// P2-80: two permissions-only encrypted PDFs (real, revision-3 RC4 and
// revision-6 AESV3, both empty-user-password) failed to append with
// {"state":"failed","code":"worker_failed"} and an empty stderr. This test
// drives the pipeline's real client code (discovery, `PipelineRunner`,
// `scanEntry`/`request` building) against a fake server whose validator is
// the real `parseWorkerRequest`, followed by the real `appendWorkerScanPage`
// handler - the same round trip production makes - and asserts both that it
// does not throw and that the admitted documents land on the sourceInventory
// row exactly as P2-77 promised (not excluded, flag and detail recorded).
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import { appendWorkerScanPage, beginWorkerScan } from "./model";
import { parseWorkerRequest } from "./protocol";
// Real pipeline client code, imported straight from source (cross-package):
// the same `PipelineRunner`/`Journal`/discovery code production runs.
import { Journal } from "../../../../pipeline/src/journal";
import {
  initialCheckpoint,
  journalCodec,
  PipelineRunner,
} from "../../../../pipeline/src/runner";
import { canonicalRoots } from "../../../../pipeline/src/filesystem";
import {
  standardEncryptedPdf,
  standardEncryptedPdfR6,
} from "../../../../pipeline/test/standardEncryptedPdfFixtures.mjs";

const PROFILE = {
  parserProfileId: "pdf_docqa_v1" as const,
  parserFingerprint: "1".repeat(64),
  extractionConfigurationFingerprint: "3".repeat(64),
  extractorFingerprint: "docling-document-qa:v1",
  recordSchemaFingerprint: "no-records:v1",
  normalizationFingerprint: "docling-pages:v1",
  chunkerFingerprint: "page-aware:v1",
  correctionRevision: "correction:1",
};

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Worker owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic worker space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-fs",
      name: "Synthetic filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      binaryProfileId: "pdf_docqa_v1",
      binaryProfileAuditDigest: "1".repeat(64),
      binaryProfileEnabledAt: 10,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "c".repeat(64),
      keyPrefix: "worker",
      name: "Synthetic worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return { userId, spaceId, sourceAccountId, credentialId };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

describe("permissions-restricted PDF append (P2-80)", () => {
  test("a fresh scan admits two real permissions-restricted PDFs through the real client and server validators", async () => {
    const f = await fixture();
    const base = await mkdtemp(join(tmpdir(), "kithmind-p2-80-"));
    const root = join(base, "root");
    const journalDir = join(base, "journal");
    await mkdir(root, { mode: 0o700 });
    await mkdir(journalDir, { mode: 0o700 });
    await chmod(root, 0o700);
    await writeFile(
      join(root, "restricted-r3.pdf"),
      standardEncryptedPdf({ userPassword: "", revision: 3 }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "restricted-r6.pdf"),
      standardEncryptedPdfR6({ userPassword: "" }),
      { mode: 0o600 },
    );

    const config = {
      protocolVersion: 1 as const,
      endpoint: "https://worker.invalid/api/worker",
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      credentialEnv: "PIPELINE_TOKEN",
      roots: [{ alias: "fixture", path: root }],
      journalDir,
      watchIntervalMs: 1_000,
      maxFiles: 256,
      maxDepth: 16,
      maxFileBytes: 65_536,
      pdfDocQa: { profile: PROFILE },
    };
    const journal = await Journal.open({
      directory: journalDir,
      binding: {
        protocolVersion: 1,
        endpoint: config.endpoint,
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        configFingerprint: "b".repeat(64),
        credentialSlot: "PIPELINE_TOKEN",
      },
      credential: "test-credential",
      initialCheckpoint,
      codec: journalCodec,
    });

    const runner = new PipelineRunner(config as never, journal, {
      async call(request: Record<string, unknown>) {
        if (request.operation === "source.status") {
          return {
            operation: "source.status",
            sourceAccountId: f.sourceAccountId,
            inventoryEpoch: 0,
            completedInventoryEpoch: 0,
            manifestVersion: 0,
            enumeration: { state: "never" },
            processing: { state: "not_assessed" },
            recordCoverage: "not_established",
          } as never;
        }
        // The real server-side validator for the outgoing request, then the
        // real convex handler - exactly what production runs.
        const parsedRequest = parseWorkerRequest(request);
        if (parsedRequest.operation === "scan.begin") {
          return (await f.t.run((ctx) =>
            beginWorkerScan(ctx, f.principal, parsedRequest, 1_000),
          )) as never;
        }
        if (parsedRequest.operation === "scan.appendPage") {
          return (await f.t.run((ctx) =>
            appendWorkerScanPage(ctx, f.principal, parsedRequest, 1_100),
          )) as never;
        }
        throw new Error(`unexpected operation ${parsedRequest.operation}`);
      },
    });
    // Skip the real docling parser-profile preparation (needs model assets
    // on disk); classification alone doesn't depend on it, and admission
    // through append happens well before any file is parsed.
    (
      runner as unknown as { preparePdfProfile: () => Promise<void> }
    ).preparePdfProfile = async () => {};
    (runner as unknown as { preparedPdfProfile: unknown }).preparedPdfProfile =
      {};

    try {
      const roots = await canonicalRoots(config as never);
      await (
        runner as unknown as {
          startCycle: (roots: unknown, status: unknown) => Promise<void>;
        }
      ).startCycle(roots, {
        enumeration: { state: "never" },
        inventoryEpoch: 0,
      });
      // Drive through scan.begin and the append page(s); stop once seal_check
      // is reached (append is done) rather than re-touching the fixture
      // files on disk, which is what seal's own recheck does.
      for (let steps = 0; steps < 10; steps += 1) {
        if (journal.checkpoint.phase === "seal_check") break;
        await (
          runner as unknown as { driveCheckpoint: () => Promise<unknown> }
        ).driveCheckpoint();
      }

      expect(journal.checkpoint.phase).toBe("seal_check");
      const appended = journal.checkpoint as unknown as {
        files: Array<{
          relativePath: string;
          kind?: string;
          discoveryState?: string;
          permissionsRestricted?: boolean;
        }>;
      };
      expect(appended.files).toHaveLength(2);
      for (const file of appended.files) {
        expect(file.kind).toBe("pdf");
        expect(file.permissionsRestricted).toBe(true);
        // Admitted, not excluded: P2-77's whole point is that these are
        // queued for processing instead of being classified as a gap.
        expect(file.discoveryState).toBe("queued");
      }

      const rows = await f.t.run((ctx) =>
        ctx.db.query("sourceInventory").collect(),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.permissionsRestricted).toBe(true);
        expect(row.permissionsDetail).toMatch(
          /standard security handler revision \d \(empty user password\)/,
        );
        // Not excluded: the row is on the path to being content-indexed
        // (published), matching an ordinary admitted PDF.
        expect(row.exclusionReason).toBe("extraction_pending");
      }
    } finally {
      await journal.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
