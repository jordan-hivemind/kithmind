import { describe, expect, it } from "vitest";

import { parseWorkerRequest, WorkerProtocolParseError } from "./protocol";

const source = {
  protocolVersion: 1,
  spaceId: "space-id",
  sourceAccountId: "source-account-id",
} as const;

const validEntry = {
  externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
  uri: "fs://documents/example.txt",
  sourceModifiedAt: 123,
  content: {
    status: "ready",
    sha256: "a".repeat(64),
    byteLength: 7,
  },
};

function appendPage(entry: unknown = validEntry) {
  return {
    ...source,
    operation: "scan.appendPage",
    scanId: "scan-id",
    requestId: "request-id",
    ordinal: 0,
    entries: [entry],
  };
}

function inventoryPage(paginationOpts: unknown) {
  return {
    ...source,
    operation: "source.inventoryPage",
    scanId: "scan-id",
    requestId: "request-id",
    expectedInventoryEpoch: 0,
    expectedManifestVersion: 0,
    paginationOpts,
  };
}

describe("worker protocol parser bounds", () => {
  it("measures request IDs, URIs, and cursors by UTF-8 bytes", () => {
    expect(
      parseWorkerRequest({
        ...source,
        operation: "scan.begin",
        requestId: "é".repeat(64),
        watcherId: "watcher",
        connectorVersion: "v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      }),
    ).toMatchObject({ operation: "scan.begin" });
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "scan.begin",
        requestId: "é".repeat(65),
        watcherId: "watcher",
        connectorVersion: "v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      }),
    ).toThrow(WorkerProtocolParseError);

    expect(
      parseWorkerRequest(
        appendPage({
          ...validEntry,
          uri: `fs://synthetic/${"%C3%A9".repeat(338)}aaaaa`,
        }),
      ),
    ).toMatchObject({ operation: "scan.appendPage" });
    expect(() =>
      parseWorkerRequest(
        appendPage({
          ...validEntry,
          uri: `fs://synthetic/${"%C3%A9".repeat(338)}aaaaaa`,
        }),
      ),
    ).toThrow(WorkerProtocolParseError);

    expect(
      parseWorkerRequest(
        inventoryPage({ cursor: "é".repeat(4096), numItems: 1 }),
      ),
    ).toMatchObject({ operation: "source.inventoryPage" });
    expect(() =>
      parseWorkerRequest(
        inventoryPage({ cursor: "é".repeat(4097), numItems: 1 }),
      ),
    ).toThrow(WorkerProtocolParseError);
  });

  it.each([
    ["non-UUID external ID", { ...validEntry, externalId: "not-a-uuid" }],
    [
      "uppercase hash",
      {
        ...validEntry,
        content: { ...validEntry.content, sha256: "A".repeat(64) },
      },
    ],
    [
      "zero ready-content bytes",
      { ...validEntry, content: { ...validEntry.content, byteLength: 0 } },
    ],
    [
      "oversized ready-content bytes",
      { ...validEntry, content: { ...validEntry.content, byteLength: 65_537 } },
    ],
  ])("rejects %s", (_reason, entry) => {
    expect(() => parseWorkerRequest(appendPage(entry))).toThrow(
      WorkerProtocolParseError,
    );
  });

  it.each([
    ["discovery entry", appendPage({ ...validEntry, actorId: "forged" })],
    [
      "ready content",
      appendPage({
        ...validEntry,
        content: { ...validEntry.content, actorId: "forged" },
      }),
    ],
    [
      "seal health",
      {
        ...source,
        operation: "scan.seal",
        scanId: "scan-id",
        requestId: "request-id",
        expectedPageCount: 1,
        health: { status: "healthy", actorId: "forged" },
      },
    ],
    [
      "pagination options",
      inventoryPage({ cursor: null, numItems: 1, actorId: "forged" }),
    ],
  ])("rejects extra authority key in nested %s", (_where, request) => {
    expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolParseError);
  });

  it.each([
    [
      "negative inventory epoch",
      {
        ...inventoryPage({ cursor: null, numItems: 1 }),
        expectedInventoryEpoch: -1,
      },
    ],
    [
      "unsafe inventory epoch",
      {
        ...inventoryPage({ cursor: null, numItems: 1 }),
        expectedInventoryEpoch: Number.MAX_SAFE_INTEGER,
      },
    ],
    ["zero inventory page size", inventoryPage({ cursor: null, numItems: 0 })],
    [
      "oversized inventory page size",
      inventoryPage({ cursor: null, numItems: 51 }),
    ],
    [
      "oversized reconcile page size",
      {
        ...source,
        operation: "scan.reconcile",
        scanId: "scan-id",
        requestId: "request-id",
        expectedInventoryEpoch: 0,
        maxItems: 51,
      },
    ],
  ])("rejects %s", (_reason, request) => {
    expect(() => parseWorkerRequest(request)).toThrow(WorkerProtocolParseError);
  });

  it("requires an exact explicit discovery-gap shape", () => {
    expect(() =>
      parseWorkerRequest(
        appendPage({
          ...validEntry,
          content: { status: "gap", code: "unreadable", sha256: "forged" },
        }),
      ),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "scan.seal",
        scanId: "scan-id",
        requestId: "request-id",
        expectedPageCount: 1,
        health: { status: "failed", code: "unknown_gap" },
      }),
    ).toThrow(WorkerProtocolParseError);
  });
});
