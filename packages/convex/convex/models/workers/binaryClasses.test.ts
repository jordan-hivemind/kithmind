// P2-70i2: the archived-binary lane used to be "the binary class is PDF". It
// is now a closed set of classes, {pdf_docqa_v1, spreadsheet_v1}, each with
// its own media type, its own measured byte bound and its own per-account
// audit. What this test proves is the separation: a class the account was not
// audited for is refused, a crossed media-type/profile pair is refused, and
// the two digests a scan entry commits differ by class, so a PDF receipt can
// never satisfy a workbook and a workbook receipt can never satisfy a PDF.
//
// Every value here is synthetic.
import { BINARY_CLASSES } from "@repo/worker-protocol";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { appendWorkerScanPage, beginWorkerScan } from "./model";
import { parseWorkerRequest } from "./protocol";
import { accountBinaryClasses } from "./profile";

const PDF = BINARY_CLASSES.pdf_docqa_v1;
const WORKBOOK = BINARY_CLASSES.spreadsheet_v1;

const FINGERPRINTS = {
  parserFingerprint: "1".repeat(64),
  extractionConfigurationFingerprint: "3".repeat(64),
  extractorFingerprint: "synthetic-extractor:v1",
  recordSchemaFingerprint: "no-records:v1",
  normalizationFingerprint: "synthetic-pages:v1",
  chunkerFingerprint: "synthetic-chunks:v1",
  correctionRevision: "correction:1",
};

async function fixture(classes: readonly string[] | undefined) {
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
      ...(classes === undefined
        ? {}
        : {
            binaryProfileIds: classes as ("pdf_docqa_v1" | "spreadsheet_v1")[],
          }),
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

function binaryEntry(overrides: Record<string, unknown> = {}) {
  const { uri, externalId, ...content } = overrides;
  return {
    externalId: externalId ?? "11111111-2222-4333-8444-555555555551",
    uri: uri ?? "fs://fixture/quarterly.xlsx",
    title: "quarterly.xlsx",
    sourceModifiedAt: 1_000,
    content: {
      status: "ready_binary_v1",
      sha256: "a".repeat(64),
      byteLength: 4_096,
      mediaType: WORKBOOK.mediaType,
      parserProfileId: "spreadsheet_v1",
      ...FINGERPRINTS,
      ...content,
    },
  };
}

async function appendOne(
  f: Awaited<ReturnType<typeof fixture>>,
  entry: ReturnType<typeof binaryEntry>,
) {
  const base = {
    protocolVersion: 1 as const,
    spaceId: f.spaceId as string,
    sourceAccountId: f.sourceAccountId as string,
  };
  const scan = await f.t.run((ctx) =>
    beginWorkerScan(
      ctx,
      f.principal,
      parseWorkerRequest({
        ...base,
        operation: "scan.begin",
        requestId: "11111111-2222-4333-8444-5555555555aa",
        watcherId: "synthetic-watcher",
        connectorVersion: "p2-70i2-test",
        mode: "normal",
        expectedInventoryEpoch: 0,
      }) as never,
      1_000,
    ),
  );
  const request = parseWorkerRequest({
    ...base,
    operation: "scan.appendPage",
    requestId: "11111111-2222-4333-8444-5555555555bb",
    scanId: (scan as { scanId: string }).scanId,
    ordinal: 0,
    entries: [entry],
  });
  return f.t.run((ctx) =>
    appendWorkerScanPage(ctx, f.principal, request as never, 1_100),
  );
}

describe("the closed set of binary classes (P2-70i2)", () => {
  test("an account audited for the workbook class admits workbook bytes", async () => {
    const f = await fixture(["pdf_docqa_v1", "spreadsheet_v1"]);
    await appendOne(f, binaryEntry());
    const rows = await f.t.run((ctx) =>
      ctx.db.query("workerScanEntries").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contentRepresentation).toBe("archived_binary_v1");
    expect(rows[0]!.binaryParserProfileId).toBe("spreadsheet_v1");
    expect(rows[0]!.binaryMediaType).toBe(WORKBOOK.mediaType);
    const inventory = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    // Admitted, not excluded: the row is on the path to being content indexed
    // rather than carrying `unsupported`.
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.exclusionReason).toBe("extraction_pending");
    expect(inventory[0]!.mediaType).toBe(WORKBOOK.mediaType);
  });

  test("an account audited only for PDF refuses workbook bytes", async () => {
    const f = await fixture(["pdf_docqa_v1"]);
    await expect(appendOne(f, binaryEntry())).rejects.toThrow(
      /source_unavailable/,
    );
    // And an account that predates the class set keeps exactly its one class.
    const legacy = await fixture(undefined);
    expect(
      await legacy.t.run(async (ctx) =>
        accountBinaryClasses((await ctx.db.get(legacy.sourceAccountId))!),
      ),
    ).toEqual(["pdf_docqa_v1"]);
    await expect(appendOne(legacy, binaryEntry())).rejects.toThrow(
      /source_unavailable/,
    );
  });

  test("a crossed media type and profile is refused by the validator", async () => {
    const f = await fixture(["pdf_docqa_v1", "spreadsheet_v1"]);
    // A workbook profile claiming PDF bytes, and a PDF profile claiming
    // workbook bytes. Both name a real class and a real media type; only the
    // pairing is wrong.
    await expect(
      appendOne(f, binaryEntry({ mediaType: PDF.mediaType })),
    ).rejects.toThrow();
    await expect(
      appendOne(
        f,
        binaryEntry({
          parserProfileId: "pdf_docqa_v1",
          mediaType: WORKBOOK.mediaType,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      appendOne(f, binaryEntry({ parserProfileId: "docx_v1" })),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("workerScanEntries").collect()),
    ).toHaveLength(0);
  });

  test("the byte bound is the class's own, not one bound for every class", async () => {
    const f = await fixture(["pdf_docqa_v1", "spreadsheet_v1"]);
    expect(WORKBOOK.maxOriginalBytes).toBeLessThan(PDF.maxOriginalBytes);
    await expect(
      appendOne(f, binaryEntry({ byteLength: WORKBOOK.maxOriginalBytes + 1 })),
    ).rejects.toThrow();
    // The same byte length is inside the PDF class's bound.
    await appendOne(
      f,
      binaryEntry({
        parserProfileId: "pdf_docqa_v1",
        mediaType: PDF.mediaType,
        byteLength: WORKBOOK.maxOriginalBytes + 1,
        uri: "fs://fixture/statement.pdf",
      }),
    );
    expect(
      await f.t.run((ctx) => ctx.db.query("workerScanEntries").collect()),
    ).toHaveLength(1);
  });

  test("the PDF security-handler fields are refused on another class", async () => {
    const f = await fixture(["pdf_docqa_v1", "spreadsheet_v1"]);
    await expect(
      appendOne(
        f,
        binaryEntry({ permissionsRestricted: true, encryptionRevision: 6 }),
      ),
    ).rejects.toThrow();
  });

  test("both scan-entry digests carry the class", async () => {
    const digestsFor = async (
      profileId: string,
      mediaType: string,
      uri: string,
    ) => {
      const f = await fixture(["pdf_docqa_v1", "spreadsheet_v1"]);
      await appendOne(
        f,
        binaryEntry({ parserProfileId: profileId, mediaType, uri }),
      );
      const rows = await f.t.run((ctx) =>
        ctx.db.query("workerScanEntries").collect(),
      );
      return {
        processing: rows[0]!.processingIdentityDigest,
        inventory: rows[0]!.inventoryMetadataDigest,
      };
    };
    // The same bytes, the same fingerprints, the same uri: only the class
    // differs, and both digests differ with it.
    const workbook = await digestsFor(
      "spreadsheet_v1",
      WORKBOOK.mediaType,
      "fs://fixture/same-name",
    );
    const pdf = await digestsFor(
      "pdf_docqa_v1",
      PDF.mediaType,
      "fs://fixture/same-name",
    );
    expect(workbook.processing).not.toBe(pdf.processing);
    expect(workbook.inventory).not.toBe(pdf.inventory);
  });

  test("a stored account class set outside the closed set never widens it", async () => {
    const f = await fixture(["spreadsheet_v1"]);
    const classes = await f.t.run(async (ctx) =>
      accountBinaryClasses(
        (await ctx.db.get(f.sourceAccountId as Id<"sourceAccounts">))!,
      ),
    );
    // `binaryProfileIds` is authoritative when present, so naming only the
    // workbook class removes the PDF class this account used to hold.
    expect(classes).toEqual(["spreadsheet_v1"]);
    await expect(
      appendOne(
        f,
        binaryEntry({
          parserProfileId: "pdf_docqa_v1",
          mediaType: PDF.mediaType,
        }),
      ),
    ).rejects.toThrow(/source_unavailable/);
  });
});
