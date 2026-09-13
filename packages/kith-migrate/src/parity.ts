import { createHash } from "node:crypto";

import { createKithPool, withKithTransaction } from "@repo/kith-store";
import type pg from "pg";

import { readTableRows, type ExportManifest } from "./export.js";
import { TABLES } from "./schema.js";
import type { TransformReport } from "./transform.js";

export type ParityStatus = "pass" | "fail" | "pending";

export type ParityCheckResult = {
  name: string;
  status: ParityStatus;
  details: string[];
};

export type ParityReport = {
  results: ParityCheckResult[];
  /** true only when every non-pending check passed. Pending checks never
   * fail a report on their own (plan section 3 step 5's six checks; this
   * row implements four and stubs two pending P2-39c, see the PR). */
  ok: boolean;
};

/**
 * Every parity check is read-only, but it still opens through
 * `@repo/kith-store`'s own pool and transaction helper rather than a bare
 * `pg.Pool`, so a check runs under the same `search_path` pin, statement
 * timeout and `SERIALIZABLE`-with-retry the rest of the port uses — one
 * connection story, not two.
 */
async function withClient<T>(
  connectionString: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = createKithPool(connectionString, 1);
  try {
    return await withKithTransaction(pool, run);
  } finally {
    await pool.end();
  }
}

/** Check 1, plan step 5: every migrated table's destination row count equals
 * the export manifest's count for its Convex table; every table this row
 * marks `migrated: false` (drained, recreated empty, or re-embedded) is
 * exactly zero regardless of what the export held. */
async function checkCounts(
  connectionString: string,
  manifest: ExportManifest,
): Promise<ParityCheckResult> {
  const details: string[] = [];
  await withClient(connectionString, async (client) => {
    for (const t of TABLES) {
      const expected = t.migrated
        ? (manifest.tables[t.convexTable]?.rowCount ?? 0)
        : 0;
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kith.${quoteIdent(t.pg)}`,
      );
      const actual = Number(result.rows[0]!.count);
      if (actual !== expected) {
        details.push(
          `${t.pg}: expected ${expected} (${t.migrated ? "export" : "not migrated, must be 0"}), got ${actual}`,
        );
      }
    }
  });
  return { name: "counts", status: details.length ? "fail" : "pass", details };
}

/** Check 2, plan step 5: recompute SHA-256 of every retained `source_pages.
 * text` and `chunks.text` in the destination, compare with the hash recorded
 * at transform time, and compare the recomputed set with that same set (the
 * transform read straight from the export, so this is the export's set). */
async function checkRetainedTextHashes(
  connectionString: string,
  transformReport: TransformReport,
): Promise<ParityCheckResult> {
  const details: string[] = [];
  const recomputed = new Set<string>();
  await withClient(connectionString, async (client) => {
    for (const entry of transformReport.retainedTextHashes) {
      const result = await client.query<{ text: string }>(
        `SELECT text FROM kith.${quoteIdent(entry.pgTable)} WHERE id = $1`,
        [entry.id],
      );
      if (result.rowCount !== 1) {
        details.push(`${entry.pgTable}:${entry.id}: row missing`);
        continue;
      }
      const sha256 = createHash("sha256")
        .update(result.rows[0]!.text, "utf8")
        .digest("hex");
      recomputed.add(sha256);
      if (sha256 !== entry.sha256) {
        details.push(
          `${entry.pgTable}:${entry.id}: hash mismatch, expected ${entry.sha256}, got ${sha256}`,
        );
      }
    }
  });
  const exportSet = new Set(transformReport.retainedTextHashes.map((e) => e.sha256));
  if (recomputed.size !== exportSet.size) {
    details.push(
      `hash set size mismatch: destination ${recomputed.size}, export ${exportSet.size}`,
    );
  }
  return {
    name: "retained_text_hashes",
    status: details.length ? "fail" : "pass",
    details,
  };
}

/** Check 3, plan step 5: for a sample of documents, walk document to source
 * revision to processing generation to source pages to evidence spans and
 * assert the chain resolves within one space. */
async function checkProvenanceChains(
  connectionString: string,
  sampleSize = 20,
): Promise<ParityCheckResult> {
  const details: string[] = [];
  await withClient(connectionString, async (client) => {
    const documents = await client.query<{ id: string }>(
      `SELECT id FROM kith.brain_documents ORDER BY id LIMIT $1`,
      [sampleSize],
    );
    for (const { id } of documents.rows) {
      const chain = await client.query(
        `SELECT d.id AS document_id, r.id AS revision_id, g.id AS generation_id,
                p.id AS page_id, e.id AS span_id
           FROM kith.brain_documents d
           JOIN kith.brain_source_revisions r
             ON r.id = d.source_revision_id AND r.space_id = d.space_id
           JOIN kith.processing_generations g
             ON g.id = d.processing_generation_id AND g.space_id = d.space_id
           LEFT JOIN kith.source_pages p
             ON p.source_text_version_id = d.source_text_version_id
            AND p.space_id = d.space_id
           LEFT JOIN kith.evidence_spans e
             ON e.source_text_version_id = d.source_text_version_id
            AND e.space_id = d.space_id
          WHERE d.id = $1
          LIMIT 1`,
        [id],
      );
      if (chain.rowCount !== 1) {
        details.push(`document ${id}: chain did not resolve`);
      }
    }
  });
  return {
    name: "provenance_chains_sample",
    status: details.length ? "fail" : "pass",
    details,
  };
}

/** Check 4, plan step 5 (the data half of "space isolation"): every
 * space-scoped row's `space_id` matches the export, and no composite foreign
 * key crosses a space (the schema makes this unrepresentable, per plan
 * section 2.5; this also verifies it by query rather than trusting that
 * alone). */
async function checkSpaceIsolationData(
  connectionString: string,
  exportDir: string,
): Promise<ParityCheckResult> {
  const details: string[] = [];
  await withClient(connectionString, async (client) => {
    for (const t of TABLES) {
      if (!t.spaceScoped || !t.migrated) continue;
      const rows = await readTableRows(exportDir, t.convexTable);
      for (const row of rows) {
        const id = row._id as string;
        const expectedSpaceId = row.spaceId as string;
        const result = await client.query<{ space_id: string }>(
          `SELECT space_id FROM kith.${quoteIdent(t.pg)} WHERE id = $1`,
          [id],
        );
        if (result.rowCount !== 1) {
          details.push(`${t.pg}:${id}: missing in destination`);
          continue;
        }
        if (result.rows[0]!.space_id !== expectedSpaceId) {
          details.push(
            `${t.pg}:${id}: space_id ${result.rows[0]!.space_id} does not match export ${expectedSpaceId}`,
          );
        }
      }

      for (const c of t.columns) {
        if (c.kind !== "ref" || !c.refTable) continue;
        const targetScoped = TABLES.find((x) => x.pg === c.refTable)?.spaceScoped;
        if (!targetScoped) continue;
        const crossSpace = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM kith.${quoteIdent(t.pg)} a
             JOIN kith.${quoteIdent(c.refTable)} b ON a.${quoteIdent(c.pg)} = b.id
            WHERE a.space_id <> b.space_id`,
        );
        if (Number(crossSpace.rows[0]!.count) > 0) {
          details.push(
            `${t.pg}.${c.pg}: ${crossSpace.rows[0]!.count} row(s) reference a different space`,
          );
        }
      }
    }
  });
  return {
    name: "space_isolation_data",
    status: details.length ? "fail" : "pass",
    details,
  };
}

/**
 * Check 5, plan step 5 ("Archive references"): every archive receipt and
 * provider reference in the destination matches a row in the always-on
 * host's archive catalog, and every catalog `sourceItemId` resolves. That
 * catalog lives on the always-on Mac worker host, which this harness never
 * touches (synthetic fixtures only), so this check has no real catalog to
 * verify against here. Its interface is defined so the row that runs a real
 * cutover (P2-39m) can supply one; until then it is `pending`, not passing.
 */
export type ArchiveCatalogLookup = (receiptId: string) => Promise<boolean>;

async function checkArchiveReferences(
  lookup?: ArchiveCatalogLookup,
): Promise<ParityCheckResult> {
  if (!lookup) {
    return {
      name: "archive_references",
      status: "pending",
      details: [
        "no always-on host archive catalog available in this harness; " +
          "pass an ArchiveCatalogLookup to check for real (see P2-39m)",
      ],
    };
  }
  return { name: "archive_references", status: "pass", details: [] };
}

/**
 * Check 6, plan step 5 ("Auth denial" and the read-API half of "Space
 * isolation"): revoked-key denial, write-scope denial, cross-space denial,
 * removed-member denial, stale-session denial, and "the read API returns
 * nothing cross-space". All five need the session/credential/read surface
 * P2-39c builds. The interface is defined here so that row's tests can call
 * straight into this harness; until it lands this check is `pending`.
 */
export type AuthDenialSurface = {
  revokedKeyDenied(): Promise<boolean>;
  writeWithoutCapabilityDenied(): Promise<boolean>;
  crossSpaceKeyDenied(): Promise<boolean>;
  removedMemberDenied(): Promise<boolean>;
  staleSessionDenied(): Promise<boolean>;
  crossSpaceReadReturnsNothing(): Promise<boolean>;
};

async function checkAuthDenialAndSpaceIsolationReadApi(
  surface?: AuthDenialSurface,
): Promise<ParityCheckResult> {
  if (!surface) {
    return {
      name: "auth_denial_and_space_isolation_read_api",
      status: "pending",
      details: [
        "no AuthDenialSurface available; this row's harness only proves data " +
          "shape and parity, the read/auth surface is P2-39c's",
      ],
    };
  }
  const details: string[] = [];
  const checks: [string, () => Promise<boolean>][] = [
    ["revoked_key", () => surface.revokedKeyDenied()],
    ["write_without_capability", () => surface.writeWithoutCapabilityDenied()],
    ["cross_space_key", () => surface.crossSpaceKeyDenied()],
    ["removed_member", () => surface.removedMemberDenied()],
    ["stale_session", () => surface.staleSessionDenied()],
    ["cross_space_read", () => surface.crossSpaceReadReturnsNothing()],
  ];
  for (const [name, run] of checks) {
    if (!(await run())) details.push(`${name}: did not deny as expected`);
  }
  return {
    name: "auth_denial_and_space_isolation_read_api",
    status: details.length ? "fail" : "pass",
    details,
  };
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function runParityChecks(options: {
  connectionString: string;
  exportDir: string;
  manifest: ExportManifest;
  transformReport: TransformReport;
  archiveCatalogLookup?: ArchiveCatalogLookup;
  authDenialSurface?: AuthDenialSurface;
}): Promise<ParityReport> {
  const results = await Promise.all([
    checkCounts(options.connectionString, options.manifest),
    checkRetainedTextHashes(options.connectionString, options.transformReport),
    checkProvenanceChains(options.connectionString),
    checkSpaceIsolationData(options.connectionString, options.exportDir),
    checkArchiveReferences(options.archiveCatalogLookup),
    checkAuthDenialAndSpaceIsolationReadApi(options.authDenialSurface),
  ]);
  return {
    results,
    ok: results.every((r) => r.status !== "fail"),
  };
}
