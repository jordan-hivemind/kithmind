import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type {
  DiscoveryFile,
  DiscoveryGap,
  GapCode,
  PipelineConfig,
  PdfDiscoveryFile,
  RootConfig,
  SourceObservation,
} from "./types.js";

const MAX_VISITED_ENTRIES = 4_096;
const FILESYSTEM_DEADLINE_MS = 30_000;
export const MAX_DISCOVERED_PDF_BYTES = 16 * 1024 * 1024;

export class FilesystemFailure extends Error {
  constructor(
    readonly code: GapCode,
    message: string,
  ) {
    super(message);
  }
}

export type SafeRoot = RootConfig & {
  canonicalPath: string;
  device: number;
  inode: number;
};

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new FilesystemFailure(
      "unsupported",
      "platform ownership checks are unavailable",
    );
  }
  return uid;
}

function safeDirectory(
  entry: Stats,
  expectedUid: number,
  message: string,
): void {
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== expectedUid ||
    (entry.mode & 0o022) !== 0
  ) {
    throw new FilesystemFailure("permission_denied", message);
  }
}

function pathParts(relativePath: string): string[] {
  if (isAbsolute(relativePath)) {
    throw new FilesystemFailure("unstable", "relative path is absolute");
  }
  const parts = relativePath.split(sep);
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    throw new FilesystemFailure("unstable", "relative path is invalid");
  }
  return parts;
}

function segment(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw new FilesystemFailure("unsupported", "path is not valid Unicode");
  }
}

export function toFsUri(alias: string, relativePath: string): string {
  const parts = pathParts(relativePath);
  const uri = `fs://${alias}/${parts.map(segment).join("/")}`;
  if (Buffer.byteLength(uri, "utf8") > 2_048) {
    throw new FilesystemFailure("oversized", "URI is too long");
  }
  return uri;
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  code: GapCode,
  message: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new FilesystemFailure(code, message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new FilesystemFailure(code, message)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function verifyAncestors(
  root: SafeRoot,
  relativePath: string,
  deadline: number,
): Promise<string> {
  const uid = currentUid();
  const parts = pathParts(relativePath);
  const rootEntry = await beforeDeadline(
    lstat(root.canonicalPath),
    deadline,
    "enumeration_interrupted",
    "filesystem check timed out",
  );
  safeDirectory(rootEntry, uid, "configured root permissions changed");
  if (rootEntry.dev !== root.device || rootEntry.ino !== root.inode) {
    throw new FilesystemFailure("unstable", "configured root changed");
  }
  let current = root.canonicalPath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = await beforeDeadline(
      lstat(current),
      deadline,
      "enumeration_interrupted",
      "filesystem check timed out",
    );
    safeDirectory(entry, uid, "path has an unsafe directory ancestor");
    const canonical = await beforeDeadline(
      realpath(current),
      deadline,
      "enumeration_interrupted",
      "filesystem check timed out",
    );
    if (!contains(root.canonicalPath, canonical)) {
      throw new FilesystemFailure("unstable", "path escaped configured root");
    }
  }
  const parent = parts.length === 1 ? root.canonicalPath : current;
  const canonicalParent = await beforeDeadline(
    realpath(parent),
    deadline,
    "enumeration_interrupted",
    "filesystem check timed out",
  );
  if (!contains(root.canonicalPath, canonicalParent)) {
    throw new FilesystemFailure("unstable", "path parent escaped root");
  }
  return canonicalParent;
}

export async function canonicalRoots(
  config: PipelineConfig,
): Promise<SafeRoot[]> {
  const uid = currentUid();
  const deadline = Date.now() + FILESYSTEM_DEADLINE_MS;
  const roots = await Promise.all(
    config.roots.map(async (root) => {
      const entry = await beforeDeadline(
        lstat(root.path),
        deadline,
        "enumeration_interrupted",
        "root check timed out",
      );
      safeDirectory(entry, uid, "configured root is not a safe directory");
      const canonicalPath = await beforeDeadline(
        realpath(root.path),
        deadline,
        "enumeration_interrupted",
        "root resolution timed out",
      );
      const canonicalEntry = await beforeDeadline(
        lstat(canonicalPath),
        deadline,
        "enumeration_interrupted",
        "root check timed out",
      );
      safeDirectory(
        canonicalEntry,
        uid,
        "canonical root is not a safe directory",
      );
      if (
        canonicalEntry.dev !== entry.dev ||
        canonicalEntry.ino !== entry.ino
      ) {
        throw new FilesystemFailure(
          "unstable",
          "configured root changed during canonicalization",
        );
      }
      return {
        ...root,
        canonicalPath,
        device: canonicalEntry.dev,
        inode: canonicalEntry.ino,
      };
    }),
  );
  for (let first = 0; first < roots.length; first += 1) {
    for (let second = first + 1; second < roots.length; second += 1) {
      const a = roots[first]!;
      const b = roots[second]!;
      if (
        contains(a.canonicalPath, b.canonicalPath) ||
        contains(b.canonicalPath, a.canonicalPath)
      ) {
        throw new FilesystemFailure("unstable", "roots overlap");
      }
    }
  }

  const journalEntry = await beforeDeadline(
    lstat(config.journalDir),
    deadline,
    "enumeration_interrupted",
    "journal check timed out",
  );
  if (journalEntry.isSymbolicLink() || !journalEntry.isDirectory()) {
    throw new FilesystemFailure("unstable", "journal is not a safe directory");
  }
  const journal = await beforeDeadline(
    realpath(config.journalDir),
    deadline,
    "enumeration_interrupted",
    "journal resolution timed out",
  );
  if (
    roots.some(
      (root) =>
        contains(root.canonicalPath, journal) ||
        contains(journal, root.canonicalPath),
    )
  ) {
    throw new FilesystemFailure("unstable", "journal overlaps a scanned root");
  }
  return roots;
}

type SafeFileBytes = Omit<DiscoveryFile, "text"> & {
  kind: "bytes";
  bytes: Buffer;
  linkCount: number;
};

type SafeLeafGap = {
  kind: "gap";
  gap: DiscoveryGap;
};

/**
 * Portable local-trust fallback. It detects ordinary symlink/replacement races
 * but does not claim protection from hostile same-user ancestor replacement.
 */
async function readFileBytes(
  root: SafeRoot,
  relativePath: string,
  maxBytes: number,
  deadline = Date.now() + FILESYSTEM_DEADLINE_MS,
  sourceMaxTextBytes?: number,
): Promise<SafeFileBytes | SafeLeafGap> {
  pathParts(relativePath);
  const candidate = join(root.canonicalPath, relativePath);
  if (!contains(root.canonicalPath, candidate)) {
    throw new FilesystemFailure("unstable", "path escapes root");
  }
  const canonicalParent = await verifyAncestors(root, relativePath, deadline);
  const resolvedBefore = await beforeDeadline(
    realpath(candidate),
    deadline,
    "enumeration_interrupted",
    "file resolution timed out",
  );
  if (
    !contains(root.canonicalPath, resolvedBefore) ||
    dirname(resolvedBefore) !== canonicalParent
  ) {
    throw new FilesystemFailure("unstable", "file escaped configured root");
  }
  const beforePath = await beforeDeadline(
    lstat(candidate),
    deadline,
    "enumeration_interrupted",
    "file check timed out",
  );
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw new FilesystemFailure("unsupported", "entry is not a regular file");
  }
  if (beforePath.size < 1 && sourceMaxTextBytes === undefined) {
    throw new FilesystemFailure("empty", "file is empty");
  }
  if (beforePath.size > maxBytes && sourceMaxTextBytes === undefined) {
    throw new FilesystemFailure("oversized", "file exceeds limit");
  }
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    throw new FilesystemFailure(
      "unsupported",
      "platform cannot safely open files",
    );
  }
  const opening = open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await beforeDeadline(
      opening,
      deadline,
      "enumeration_interrupted",
      "file open timed out",
    );
  } catch (error) {
    void opening
      .then((lateHandle) => lateHandle.close())
      .catch(() => undefined);
    throw error;
  }

  let abandoned = false;
  try {
    const before = await beforeDeadline(
      handle.stat(),
      deadline,
      "enumeration_interrupted",
      "file stat timed out",
    );
    if (
      !before.isFile() ||
      (sourceMaxTextBytes === undefined &&
        (before.size < 1 || before.size > maxBytes)) ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino
    ) {
      throw new FilesystemFailure(
        "unstable",
        "opened entry changed before read",
      );
    }
    let leafGapCode: DiscoveryGap["code"] | undefined;
    if (sourceMaxTextBytes !== undefined) {
      const header = Buffer.alloc(Math.min(5, before.size));
      if (header.length > 0) {
        const read = await beforeDeadline(
          handle.read(header, 0, header.length, 0),
          deadline,
          "enumeration_interrupted",
          "file read timed out",
        );
        if (read.bytesRead !== header.length) {
          throw new FilesystemFailure("unstable", "file changed while reading");
        }
      }
      const selectedMax = header.equals(Buffer.from("%PDF-"))
        ? maxBytes
        : sourceMaxTextBytes;
      if (before.size < 1) leafGapCode = "empty";
      else if (before.size > selectedMax) leafGapCode = "oversized";
    }
    let bytes: Buffer | undefined;
    if (leafGapCode === undefined) {
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        let read;
        try {
          read = await beforeDeadline(
            handle.read(bytes, offset, bytes.length - offset, offset),
            deadline,
            "enumeration_interrupted",
            "file read timed out",
          );
        } catch (error) {
          abandoned = true;
          void handle.close().catch(() => undefined);
          throw error;
        }
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset !== bytes.length) {
        throw new FilesystemFailure("unstable", "file changed while reading");
      }
    }
    const after = await beforeDeadline(
      handle.stat(),
      deadline,
      "enumeration_interrupted",
      "file stat timed out",
    );
    const repeatedParent = await verifyAncestors(root, relativePath, deadline);
    const afterPath = await beforeDeadline(
      lstat(candidate),
      deadline,
      "enumeration_interrupted",
      "file check timed out",
    );
    const resolvedAfter = await beforeDeadline(
      realpath(candidate),
      deadline,
      "enumeration_interrupted",
      "file resolution timed out",
    );
    if (
      repeatedParent !== canonicalParent ||
      resolvedAfter !== resolvedBefore ||
      !contains(root.canonicalPath, resolvedAfter) ||
      dirname(resolvedAfter) !== repeatedParent ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== before.nlink ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      afterPath.dev !== beforePath.dev ||
      afterPath.ino !== beforePath.ino ||
      afterPath.size !== beforePath.size ||
      afterPath.nlink !== beforePath.nlink ||
      afterPath.mtimeMs !== beforePath.mtimeMs ||
      afterPath.ctimeMs !== beforePath.ctimeMs
    ) {
      throw new FilesystemFailure("unstable", "file changed during read");
    }
    const sourceModifiedAt = Math.trunc(before.mtimeMs);
    if (!Number.isSafeInteger(sourceModifiedAt) || sourceModifiedAt < 0) {
      throw new FilesystemFailure(
        "unstable",
        "file modification time is invalid",
      );
    }
    if (leafGapCode !== undefined) {
      return {
        kind: "gap",
        gap: {
          rootAlias: root.alias,
          relativePath,
          uri: toFsUri(root.alias, relativePath),
          sourceModifiedAt,
          code: leafGapCode,
        },
      };
    }
    return {
      kind: "bytes",
      rootAlias: root.alias,
      relativePath,
      uri: toFsUri(root.alias, relativePath),
      sourceModifiedAt,
      sha256: createHash("sha256").update(bytes!).digest("hex"),
      byteLength: bytes!.length,
      bytes: bytes!,
      linkCount: before.nlink,
    };
  } finally {
    if (!abandoned) await handle.close();
  }
}

function utf8DiscoveryFile(
  file: SafeFileBytes,
  maxBytes: number,
): DiscoveryFile {
  if (file.byteLength > maxBytes) {
    throw new FilesystemFailure("oversized", "file exceeds limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(file.bytes);
  } catch {
    throw new FilesystemFailure("unsupported", "file is not UTF-8");
  }
  const {
    kind: _kind,
    bytes: _bytes,
    linkCount: _linkCount,
    ...descriptor
  } = file;
  return { ...descriptor, text };
}

const PDF_ENCRYPT_MARKER = Buffer.from("/Encrypt");
const PDF_EOF_MARKER = Buffer.from("%%EOF");
const PDF_TRAILER_MARKER = Buffer.from("trailer");
// Cross-reference streams (PDF 1.5+) carry no literal "trailer" keyword;
// their own stream dictionary declares `/Type /XRef` instead, so that
// substring anchors the dictionary the same way "trailer" does for a
// classic table.
const PDF_XREF_TYPE_MARKER = Buffer.from("/XRef");
const PDF_DICT_OPEN = Buffer.from("<<");
const PDF_PREV_PATTERN = /\/Prev\s+(\d+)/;
// ponytail: each hop re-scans textually for the nearest trailer/xref-type
// dictionary before a boundary, rather than resolving `/Prev` as a precise
// object offset. That is exact for the current (last) revision, which is
// all real encryption detection needs (a reader must find /Encrypt in the
// trailer it reads first, always the last one) - bounded and cheap for the
// rest. Upgrade to real offset resolution if an encrypted file is ever
// found where only an older revision's dictionary carries /Encrypt.
const MAX_PDF_TRAILER_HOPS = 8;
// A trailer or xref-stream dictionary is a handful of short keys; anything
// past this many bytes without a closing `>>` is treated as unparseable.
const MAX_PDF_DICT_BYTES = 65_536;

function pdfDictEnd(bytes: Buffer, openAt: number): number | undefined {
  if (bytes[openAt] !== 0x3c || bytes[openAt + 1] !== 0x3c) return undefined;
  let depth = 0;
  const limit = Math.min(bytes.length - 1, openAt + MAX_PDF_DICT_BYTES);
  for (let index = openAt; index < limit; index += 1) {
    if (bytes[index] === 0x3c && bytes[index + 1] === 0x3c) {
      depth += 1;
      index += 1;
    } else if (bytes[index] === 0x3e && bytes[index + 1] === 0x3e) {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/**
 * The nearest trailer dictionary (or, for a cross-reference stream, its own
 * `/Type /XRef` stream dictionary) positioned at or before `boundary`.
 */
function pdfTrailerDictBefore(
  bytes: Buffer,
  boundary: number,
): { start: number; end: number } | undefined {
  const trailerAt = bytes.lastIndexOf(PDF_TRAILER_MARKER, boundary);
  if (trailerAt >= 0) {
    const openAt = bytes.indexOf(
      PDF_DICT_OPEN,
      trailerAt + PDF_TRAILER_MARKER.length,
    );
    const end = openAt < 0 ? undefined : pdfDictEnd(bytes, openAt);
    if (end !== undefined) return { start: openAt, end };
  }
  const xrefAt = bytes.lastIndexOf(PDF_XREF_TYPE_MARKER, boundary);
  if (xrefAt < 0) return undefined;
  const dictStart = bytes.lastIndexOf(PDF_DICT_OPEN, xrefAt);
  if (dictStart < 0) return undefined;
  const end = pdfDictEnd(bytes, dictStart);
  // The anchor must actually fall inside the dictionary found; otherwise
  // this "<<" belongs to something earlier and unrelated.
  if (end === undefined || end <= xrefAt) return undefined;
  return { start: dictStart, end };
}

/**
 * Detects a PDF's trailer `/Encrypt` entry from the raw bytes, before any
 * parser opens the file: locates the last trailer dictionary before the
 * file's final `%%EOF` (or, for a cross-reference stream, its `/Type /XRef`
 * stream dictionary), then any `/Prev` chain, checking only those bounded
 * dictionary byte ranges for `/Encrypt` rather than the whole file, so an
 * unrelated `/Encrypt` literal inside a content stream cannot match. Never
 * decodes or logs the file's content; dependency-free and bounded (no
 * dictionary is scanned past `MAX_PDF_DICT_BYTES`, no more than
 * `MAX_PDF_TRAILER_HOPS` hops are walked). Fails open to "not encrypted" on
 * anything it cannot parse, leaving the parser to decide.
 */
function isPdfEncrypted(bytes: Buffer): boolean {
  const eofAt = bytes.lastIndexOf(PDF_EOF_MARKER);
  let boundary = eofAt < 0 ? bytes.length : eofAt;
  for (let hop = 0; hop < MAX_PDF_TRAILER_HOPS; hop += 1) {
    const dict = pdfTrailerDictBefore(bytes, boundary);
    if (!dict) return false;
    const slice = bytes.subarray(dict.start, dict.end);
    if (slice.includes(PDF_ENCRYPT_MARKER)) return true;
    const prevMatch = PDF_PREV_PATTERN.exec(slice.toString("latin1"));
    const prevOffset = prevMatch ? Number(prevMatch[1]) : undefined;
    if (
      prevOffset === undefined ||
      !Number.isSafeInteger(prevOffset) ||
      prevOffset < 0 ||
      prevOffset >= dict.start
    ) {
      return false;
    }
    boundary = prevOffset;
  }
  return false;
}

function pdfDiscoveryFile(file: SafeFileBytes): PdfDiscoveryFile {
  if (file.linkCount !== 1) {
    throw new FilesystemFailure("unstable", "PDF has multiple hard links");
  }
  if (!file.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new FilesystemFailure("unsupported", "file is not a PDF");
  }
  if (isPdfEncrypted(file.bytes)) {
    throw new FilesystemFailure("encrypted", "PDF requires a password");
  }
  const {
    kind: _kind,
    bytes: _bytes,
    linkCount: _linkCount,
    ...descriptor
  } = file;
  return { ...descriptor, mediaType: "application/pdf" };
}

export async function readUtf8File(
  root: SafeRoot,
  relativePath: string,
  maxBytes: number,
  deadline = Date.now() + FILESYSTEM_DEADLINE_MS,
): Promise<DiscoveryFile> {
  const result = await readFileBytes(root, relativePath, maxBytes, deadline);
  if (result.kind === "gap") {
    throw new FilesystemFailure(result.gap.code, "file is not readable");
  }
  return utf8DiscoveryFile(result, maxBytes);
}

export async function readPdfFile(
  root: SafeRoot,
  relativePath: string,
  deadline = Date.now() + FILESYSTEM_DEADLINE_MS,
): Promise<PdfDiscoveryFile> {
  const result = await readFileBytes(
    root,
    relativePath,
    MAX_DISCOVERED_PDF_BYTES,
    deadline,
  );
  if (result.kind === "gap") {
    throw new FilesystemFailure(result.gap.code, "file is not readable");
  }
  return pdfDiscoveryFile(result);
}

async function readSourceObservation(
  root: SafeRoot,
  relativePath: string,
  maxTextBytes: number,
  deadline: number,
): Promise<SourceObservation> {
  const result = await readFileBytes(
    root,
    relativePath,
    MAX_DISCOVERED_PDF_BYTES,
    deadline,
    maxTextBytes,
  );
  if (result.kind === "gap") return result;
  const file = result;
  if (file.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    try {
      return { kind: "pdf", file: pdfDiscoveryFile(file) };
    } catch (error) {
      if (!(error instanceof FilesystemFailure) || error.code !== "encrypted") {
        throw error;
      }
      const {
        kind: _kind,
        bytes: _bytes,
        linkCount: _linkCount,
        ...descriptor
      } = file;
      return { kind: "gap", gap: { ...descriptor, code: "encrypted" } };
    }
  }
  try {
    return { kind: "utf8", file: utf8DiscoveryFile(file, maxTextBytes) };
  } catch (error) {
    if (!(error instanceof FilesystemFailure) || error.code !== "unsupported") {
      throw error;
    }
    const {
      kind: _kind,
      bytes: _bytes,
      linkCount: _linkCount,
      ...descriptor
    } = file;
    return { kind: "gap", gap: { ...descriptor, code: "unsupported" } };
  }
}

async function discoverWith<T extends DiscoveryFile | SourceObservation>(
  config: PipelineConfig,
  roots: SafeRoot[],
  read: (root: SafeRoot, relativePath: string, deadline: number) => Promise<T>,
): Promise<T[]> {
  const found: T[] = [];
  const uris = new Set<string>();
  let encountered = 0;
  const deadline = Date.now() + FILESYSTEM_DEADLINE_MS;

  function inclusion(root: SafeRoot):
    | {
        leaves: Set<string>;
        ancestors: Set<string>;
        matched: Set<string>;
      }
    | undefined {
    if (root.includeFiles === undefined) return undefined;
    const leaves = new Set(root.includeFiles);
    const ancestors = new Set<string>();
    for (const path of root.includeFiles) {
      const parts = pathParts(path);
      for (let length = 1; length < parts.length; length += 1) {
        ancestors.add(parts.slice(0, length).join(sep));
      }
    }
    return { leaves, ancestors, matched: new Set() };
  }

  async function walk(
    root: SafeRoot,
    directory: string,
    depth: number,
    selected: ReturnType<typeof inclusion>,
  ): Promise<void> {
    if (depth > config.maxDepth) {
      throw new FilesystemFailure(
        "oversized",
        "directory depth limit exceeded",
      );
    }
    const beforeDirectory = await beforeDeadline(
      lstat(directory),
      deadline,
      "enumeration_interrupted",
      "filesystem enumeration timed out",
    ).catch((error: unknown) => {
      if (error instanceof FilesystemFailure) throw error;
      throw new FilesystemFailure(
        "permission_denied",
        "directory is unreadable",
      );
    });
    safeDirectory(
      beforeDirectory,
      currentUid(),
      "directory is not safely owned",
    );
    const canonicalDirectory = await beforeDeadline(
      realpath(directory),
      deadline,
      "enumeration_interrupted",
      "filesystem enumeration timed out",
    );
    if (!contains(root.canonicalPath, canonicalDirectory)) {
      throw new FilesystemFailure("unstable", "directory escaped root");
    }

    const directoryHandle = await beforeDeadline(
      opendir(directory),
      deadline,
      "enumeration_interrupted",
      "filesystem enumeration timed out",
    ).catch((error: unknown) => {
      if (error instanceof FilesystemFailure) throw error;
      throw new FilesystemFailure(
        "permission_denied",
        "directory is unreadable",
      );
    });
    const entries = [];
    try {
      while (true) {
        const entry = await beforeDeadline(
          directoryHandle.read(),
          deadline,
          "enumeration_interrupted",
          "filesystem enumeration timed out",
        );
        if (!entry) break;
        encountered += 1;
        if (encountered > MAX_VISITED_ENTRIES) {
          throw new FilesystemFailure(
            "oversized",
            "filesystem node limit exceeded",
          );
        }
        entries.push(entry);
      }
    } finally {
      await directoryHandle.close().catch(() => undefined);
    }
    entries.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
    );

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const rel = relative(root.canonicalPath, fullPath);
      const selectedLeaf = selected?.leaves.has(rel) ?? false;
      const selectedAncestor = selected?.ancestors.has(rel) ?? false;
      if (selected !== undefined && !selectedLeaf && !selectedAncestor) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new FilesystemFailure(
          "unstable",
          selected === undefined
            ? "symlink found in root"
            : "included path is a symlink",
        );
      }
      if (selectedAncestor) {
        if (!entry.isDirectory()) {
          throw new FilesystemFailure(
            "unsupported",
            "included file ancestor is not a directory",
          );
        }
        await walk(root, fullPath, depth + 1, selected);
        continue;
      }
      if (entry.isDirectory()) {
        if (selectedLeaf) {
          throw new FilesystemFailure(
            "unsupported",
            "included file is not a regular file",
          );
        }
        await walk(root, fullPath, depth + 1, selected);
        continue;
      }
      if (!entry.isFile()) {
        throw new FilesystemFailure(
          "unsupported",
          selectedLeaf
            ? "included file is not a regular file"
            : "root contains a non-regular entry",
        );
      }
      if (entry.name === ".DS_Store") continue;
      if (found.length >= config.maxFiles) {
        throw new FilesystemFailure("oversized", "file count limit exceeded");
      }
      const file = await read(root, rel, deadline);
      const uri =
        "uri" in file
          ? file.uri
          : file.kind === "gap"
            ? file.gap.uri
            : file.file.uri;
      if (uris.has(uri)) {
        throw new FilesystemFailure("unstable", "filesystem URI collision");
      }
      uris.add(uri);
      found.push(file);
      selected?.matched.add(rel);
    }

    const afterDirectory = await beforeDeadline(
      lstat(directory),
      deadline,
      "enumeration_interrupted",
      "filesystem enumeration timed out",
    ).catch((error: unknown) => {
      if (error instanceof FilesystemFailure) throw error;
      throw new FilesystemFailure(
        "unstable",
        "directory disappeared during enumeration",
      );
    });
    const resolvedAfter = await beforeDeadline(
      realpath(directory),
      deadline,
      "enumeration_interrupted",
      "filesystem enumeration timed out",
    );
    if (
      resolvedAfter !== canonicalDirectory ||
      afterDirectory.isSymbolicLink() ||
      !afterDirectory.isDirectory() ||
      afterDirectory.dev !== beforeDirectory.dev ||
      afterDirectory.ino !== beforeDirectory.ino ||
      afterDirectory.mtimeMs !== beforeDirectory.mtimeMs ||
      afterDirectory.ctimeMs !== beforeDirectory.ctimeMs
    ) {
      throw new FilesystemFailure(
        "unstable",
        "directory changed during enumeration",
      );
    }
  }

  for (const root of roots) {
    const selected = inclusion(root);
    await walk(root, root.canonicalPath, 0, selected);
    if (
      selected !== undefined &&
      selected.matched.size !== selected.leaves.size
    ) {
      throw new FilesystemFailure("unstable", "included file is missing");
    }
  }
  return found;
}

export async function discoverFiles(
  config: PipelineConfig,
  roots: SafeRoot[],
): Promise<DiscoveryFile[]> {
  return discoverWith(config, roots, (root, relativePath, deadline) =>
    readUtf8File(root, relativePath, config.maxFileBytes, deadline),
  );
}

/**
 * Scans the same trusted roots as legacy UTF-8 discovery, but keeps PDF bytes
 * out of the text reader. PDF entries are descriptors only; a later runner
 * must first obtain a verified parser-profile preparation result before it can
 * send a binary admission entry or capture bytes.
 */
export async function discoverSourceObservations(
  config: PipelineConfig,
  roots: SafeRoot[],
): Promise<SourceObservation[]> {
  return discoverWith(config, roots, (root, relativePath, deadline) =>
    readSourceObservation(root, relativePath, config.maxFileBytes, deadline),
  );
}
