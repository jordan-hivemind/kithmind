// ADM-4c review. What the last pass learned about each file, so the next pass
// does not read and hash every byte of every watched folder again.
//
// Why this exists: discovery reads and SHA-256s every file on every pass. At
// 256 small files that was invisible. At three watched folders of PDFs it is
// gigabytes of I/O every five minutes, forever, against a Dropbox-synced
// directory -- and it is the reason the enumeration deadline was being hit.
//
// What it is allowed to do: supply the sha256 and the classification a read
// would have produced, for a file whose `(device, inode, size, mtimeMs)` are
// all four unchanged. Nothing else. Every safety check around the read still
// runs: the ancestors are re-verified, the path is re-resolved, the handle is
// opened `O_NOFOLLOW`, and the stat is compared before and after. A hit only
// skips the bytes.
//
// What it is not: authority. It is a sidecar beside the journal, rebuilt from
// nothing if it is missing, corrupt, from another journal, or stale. Losing it
// costs one slow pass. It is never consulted for identity, which stays the
// content hash and the provider file id, and an entry older than
// `SCAN_CACHE_REHASH_MS` is ignored so every file is re-read at least daily.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { BINARY_CLASSES, type BinaryMediaType } from "@repo/worker-protocol";

import {
  SCAN_CACHE_REHASH_MS,
  type ScanCache,
  type ScanCacheKey,
  type ScanCacheValue,
} from "./filesystem.js";

const CACHE_FILE = "scan-cache.json";
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 8_192;
const HEX_64 = /^[a-f0-9]{64}$/;
const BINARY_MEDIA_TYPES = new Set<string>(
  Object.values(BINARY_CLASSES).map((value) => value.mediaType),
);
const isBinaryMediaType = (value: string): value is BinaryMediaType =>
  BINARY_MEDIA_TYPES.has(value);

const keyOf = (key: ScanCacheKey) =>
  `${key.device}:${key.inode}:${key.size}:${Math.trunc(key.mtimeMs)}`;

type StoredEntry = { at: number; value: ScanCacheValue };

function validValue(raw: unknown): ScanCacheValue | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (row.kind === "gap") {
    return typeof row.code === "string"
      ? ({ kind: "gap", code: row.code } as ScanCacheValue)
      : undefined;
  }
  // ADM-4c review: this file is on disk and supplies content hashes, so every
  // field is checked, not merely present. A row that is not exactly right is
  // dropped and its file re-read.
  if (
    row.kind !== "binary" ||
    typeof row.sha256 !== "string" ||
    !HEX_64.test(row.sha256) ||
    !Number.isSafeInteger(row.byteLength) ||
    (row.byteLength as number) < 1 ||
    row.linkCount !== 1 ||
    typeof row.mediaType !== "string" ||
    !isBinaryMediaType(row.mediaType)
  ) {
    return undefined;
  }
  if (row.permissionsRestricted !== undefined) {
    if (
      row.permissionsRestricted !== true ||
      !Number.isSafeInteger(row.encryptionRevision) ||
      (row.encryptionRevision as number) < 2 ||
      (row.encryptionRevision as number) > 6
    ) {
      return undefined;
    }
    return {
      kind: "binary",
      sha256: row.sha256,
      byteLength: row.byteLength as number,
      linkCount: 1,
      mediaType: row.mediaType,
      permissionsRestricted: true,
      encryptionRevision: row.encryptionRevision as number,
    };
  }
  return {
    kind: "binary",
    sha256: row.sha256,
    byteLength: row.byteLength as number,
    linkCount: 1,
    mediaType: row.mediaType,
  };
}

/**
 * The cache for one journal directory. `authorityDigest` ties the file to the
 * journal that wrote it, so a cache copied beside another journal, or left
 * behind by a different source account, is discarded rather than trusted.
 */
export class JournalScanCache implements ScanCache {
  private readonly entries = new Map<string, StoredEntry>();
  private dirty = false;

  private constructor(
    private readonly path: string,
    private readonly authorityDigest: string,
  ) {}

  static async open(input: {
    journalDir: string;
    authority: string;
  }): Promise<JournalScanCache> {
    const digest = createHash("sha256").update(input.authority).digest("hex");
    const cache = new JournalScanCache(
      join(input.journalDir, CACHE_FILE),
      digest,
    );
    await cache.load();
    return cache;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      const handle = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_CACHE_BYTES) return;
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        text = bytes.subarray(0, offset).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // Missing, unreadable, or a symlink someone left in its place. A cache
      // that cannot be read is a cache that is not used; nothing is lost.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const row = parsed as Record<string, unknown>;
    if (row.version !== 1 || row.authorityDigest !== this.authorityDigest) {
      return;
    }
    if (!row.entries || typeof row.entries !== "object") return;
    for (const [key, raw] of Object.entries(
      row.entries as Record<string, unknown>,
    )) {
      if (this.entries.size >= MAX_ENTRIES) break;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const value = validValue(entry.value);
      if (!value || !Number.isSafeInteger(entry.at)) continue;
      this.entries.set(key, { at: entry.at as number, value });
    }
  }

  get(key: ScanCacheKey, now: number): ScanCacheValue | undefined {
    const entry = this.entries.get(keyOf(key));
    if (!entry) return undefined;
    // The daily safety net, and a guard against a clock that moved.
    if (entry.at > now || now - entry.at > SCAN_CACHE_REHASH_MS) {
      return undefined;
    }
    return entry.value;
  }

  set(key: ScanCacheKey, value: ScanCacheValue, now: number): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(keyOf(key))) {
      // ponytail: oldest-first eviction by insertion order, which a Map gives
      // for free. Swap for a real LRU only if a journal ever holds more files
      // than the scan ceiling, which today it cannot.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(keyOf(key), { at: now, value });
    this.dirty = true;
  }

  /**
   * Writes the cache if this pass changed it. Never throws: a cache that
   * cannot be written is a slower next pass and nothing more, and a pass that
   * has just published documents must not fail on its way out because of one.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const payload = `${JSON.stringify({
      version: 1,
      authorityDigest: this.authorityDigest,
      entries: Object.fromEntries(this.entries),
    })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_BYTES) return;
    const temporary = `${this.path}.tmp`;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        0o600,
      );
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
