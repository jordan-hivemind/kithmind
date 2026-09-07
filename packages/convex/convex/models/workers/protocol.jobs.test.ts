import { describe, expect, it } from "vitest";
import { parseWorkerRequest, WorkerProtocolParseError } from "./protocol";

const source = {
  protocolVersion: 1,
  spaceId: "synthetic-space",
  sourceAccountId: "synthetic-source",
  requestId: "request-1",
};
const lease = {
  jobId: "synthetic-job",
  leaseEpoch: 1,
  leaseToken: "a".repeat(64),
};
const operations = [
  "jobs.renew",
  "jobs.stageUtf8",
  "jobs.activate",
  "jobs.fail",
] as const;
function request(operation: (typeof operations)[number]) {
  return {
    ...source,
    ...lease,
    operation,
    ...(operation === "jobs.fail" ? { failureCode: "worker_interrupted" } : {}),
  };
}

describe("worker processing request authority boundary", () => {
  it("accepts the five published job envelopes", () => {
    const reserve = { ...source, operation: "jobs.reserve", maxItems: 4 };
    expect(parseWorkerRequest(reserve)).toEqual(reserve);
    for (const operation of operations) {
      expect(parseWorkerRequest(request(operation))).toEqual(
        request(operation),
      );
    }
  });

  it("rejects worker-supplied content, processing metadata, time, and authority", () => {
    const forbidden = {
      text: "replacement content",
      title: "replacement title",
      profileId: "replacement-profile",
      expectedDocumentCount: 1,
      actualChunkCount: 1,
      capturedAt: 123,
      now: 123,
      leaseDurationMs: 999999,
      actorUserId: "another-person",
      actorCredentialId: "another-key",
      principal: { userId: "another-person" },
    };
    for (const operation of operations) {
      for (const [key, value] of Object.entries(forbidden)) {
        expect(() =>
          parseWorkerRequest({ ...request(operation), [key]: value }),
        ).toThrow(WorkerProtocolParseError);
      }
    }
    for (const extra of [
      { jobId: lease.jobId },
      { tokens: [lease.leaseToken] },
      { now: 123 },
    ]) {
      expect(() =>
        parseWorkerRequest({
          ...source,
          operation: "jobs.reserve",
          maxItems: 1,
          ...extra,
        }),
      ).toThrow(WorkerProtocolParseError);
    }
  });

  it("requires a bounded canonical lease on every job operation", () => {
    for (const operation of operations) {
      for (const invalid of [
        0,
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Infinity,
        "1",
      ]) {
        expect(() =>
          parseWorkerRequest({ ...request(operation), leaseEpoch: invalid }),
        ).toThrow(WorkerProtocolParseError);
      }
      for (const invalid of [
        "",
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
      ]) {
        expect(() =>
          parseWorkerRequest({ ...request(operation), leaseToken: invalid }),
        ).toThrow(WorkerProtocolParseError);
      }
      for (const field of ["requestId", "jobId", "leaseEpoch", "leaseToken"]) {
        const envelope: Record<string, unknown> = { ...request(operation) };
        delete envelope[field];
        expect(() => parseWorkerRequest(envelope)).toThrow(
          WorkerProtocolParseError,
        );
      }
      expect(() =>
        parseWorkerRequest({
          ...request(operation),
          requestId: "é".repeat(65),
        }),
      ).toThrow(WorkerProtocolParseError);
    }
  });

  it("bounds reservation size and prevents worker-defined failure policy", () => {
    for (const maxItems of [0, -1, 5, 1.5, Infinity, "4"]) {
      expect(() =>
        parseWorkerRequest({ ...source, operation: "jobs.reserve", maxItems }),
      ).toThrow(WorkerProtocolParseError);
    }
    for (const failureCode of [
      "worker_interrupted",
      "worker_resource_exhausted",
      "source_bytes_invalid",
      "staging_invalid",
    ]) {
      expect(
        parseWorkerRequest({ ...request("jobs.fail"), failureCode }),
      ).toMatchObject({ failureCode });
    }
    for (const failureCode of ["not_authorized", "retry_forever", "", null]) {
      expect(() =>
        parseWorkerRequest({ ...request("jobs.fail"), failureCode }),
      ).toThrow(WorkerProtocolParseError);
    }
    for (const extra of [
      { message: "raw source text" },
      { retryable: true },
      { nextAttemptAt: 0 },
    ]) {
      expect(() =>
        parseWorkerRequest({ ...request("jobs.fail"), ...extra }),
      ).toThrow(WorkerProtocolParseError);
    }
  });
});
