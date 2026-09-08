import { describe, expect, it } from "vitest";

import {
  parseWorkerProtocolErrorData,
  parseWorkerRequest,
  WorkerProtocolParseError,
} from "./protocol";

const source = {
  protocolVersion: 1,
  spaceId: "space-id",
  sourceAccountId: "source-account-id",
} as const;

describe("worker protocol parser", () => {
  it("parses and normalizes each implemented operation", () => {
    expect(
      parseWorkerRequest({ ...source, operation: "source.status" }),
    ).toEqual({ ...source, operation: "source.status" });
    expect(
      parseWorkerRequest({ ...source, operation: "diagnostics.status" }),
    ).toEqual({ ...source, operation: "diagnostics.status" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "diagnostics.heartbeat",
        watcherId: "01890a5d-ac96-7cc4-8b7e-6f4f5ca5c139",
        connectorVersion: "pipeline-1.0.0",
      }),
    ).toMatchObject({ operation: "diagnostics.heartbeat" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "source.inventoryPage",
        scanId: "scan-id",
        requestId: "inventory-request",
        expectedInventoryEpoch: 2,
        expectedManifestVersion: 4,
        paginationOpts: { cursor: null, numItems: 25 },
      }),
    ).toMatchObject({ operation: "source.inventoryPage" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "scan.begin",
        requestId: "request-1",
        watcherId: "watcher-1",
        connectorVersion: "fs-v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      }),
    ).toMatchObject({ operation: "scan.begin", mode: "normal" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "scan.appendPage",
        scanId: "scan-id",
        requestId: "request-2",
        ordinal: 0,
        entries: [
          {
            externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
            uri: "fs://documents/example.txt",
            title: "Example",
            docType: "text",
            sourceModifiedAt: 123,
            content: {
              status: "ready",
              sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              byteLength: 7,
            },
          },
        ],
      }),
    ).toMatchObject({ operation: "scan.appendPage", ordinal: 0 });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "scan.seal",
        scanId: "scan-id",
        requestId: "request-3",
        expectedPageCount: 1,
        health: { status: "healthy" },
      }),
    ).toMatchObject({ operation: "scan.seal" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "scan.reconcile",
        scanId: "scan-id",
        requestId: "request-4",
        expectedInventoryEpoch: 1,
        ordinal: 0,
        maxItems: 50,
      }),
    ).toMatchObject({ operation: "scan.reconcile" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "discovery.reserve",
        requestId: "reserve-1",
        maxItems: 4,
      }),
    ).toMatchObject({ operation: "discovery.reserve", maxItems: 4 });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "discovery.admitUtf8",
        requestId: "admit-1",
        workId: "work-id",
        leaseEpoch: 1,
        leaseToken: "a".repeat(64),
        text: "alpha beta",
      }),
    ).toMatchObject({ operation: "discovery.admitUtf8", leaseEpoch: 1 });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "processing.assessBegin",
        requestId: "assess-begin-1",
        scanId: "scan-id",
        expectedInventoryEpoch: 2,
        expectedManifestVersion: 4,
      }),
    ).toMatchObject({ operation: "processing.assessBegin" });
    expect(
      parseWorkerRequest({
        ...source,
        operation: "processing.assessPage",
        requestId: "assess-page-1",
        assessmentId: "assessment-id",
        ordinal: 0,
        maxItems: 1,
      }),
    ).toMatchObject({ operation: "processing.assessPage", maxItems: 1 });
  });

  it("rejects unknown operations and extra keys", () => {
    expect(() =>
      parseWorkerRequest({ ...source, operation: "jobs.execute" }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "processing.assessPage",
        requestId: "assess-page-too-wide",
        assessmentId: "assessment-id",
        ordinal: 0,
        maxItems: 2,
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "diagnostics.heartbeat",
        watcherId: "01890A5D-AC96-7CC4-8B7E-6F4F5CA5C139",
        connectorVersion: "pipeline-1.0.0",
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "diagnostics.heartbeat",
        watcherId: "01890a5d-ac96-7cc4-8b7e-6f4f5ca5c139",
        connectorVersion: "pipeline-1.0.0",
        requestId: "not-supported",
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "source.status",
        actorId: "x",
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "discovery.reserve",
        requestId: "reserve-too-many",
        maxItems: 5,
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "discovery.admitUtf8",
        requestId: "bad-token",
        workId: "work-id",
        leaseEpoch: 1,
        leaseToken: "not-a-token",
        text: "alpha",
      }),
    ).toThrow(WorkerProtocolParseError);
  });

  it("rejects malformed Unicode and out-of-bounds pages", () => {
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "scan.begin",
        requestId: "bad\ud800",
        watcherId: "watcher",
        connectorVersion: "v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      }),
    ).toThrow(WorkerProtocolParseError);
    expect(() =>
      parseWorkerRequest({
        ...source,
        operation: "scan.appendPage",
        scanId: "scan-id",
        requestId: "request",
        ordinal: 0,
        entries: [],
      }),
    ).toThrow(WorkerProtocolParseError);
  });

  it("accepts only allowlisted structured errors", () => {
    expect(
      parseWorkerProtocolErrorData({
        type: "worker_protocol_error",
        code: "scan_conflict",
      }),
    ).toEqual({ type: "worker_protocol_error", code: "scan_conflict" });
    expect(
      parseWorkerProtocolErrorData({
        type: "worker_protocol_error",
        code: "secret_backend_failure",
      }),
    ).toBeUndefined();
  });
});
