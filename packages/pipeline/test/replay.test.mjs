import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Journal, JournalSafetyError } from "../dist/journal.js";
import { resumePendingCall, runJournaledCall } from "../dist/replay.js";

const codec = {
  parseCheckpoint(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1 ||
      typeof value.phase !== "string"
    )
      throw new Error("bad checkpoint");
    return value;
  },
  parseResult(operation, value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.operation !== operation ||
      typeof value.state !== "string"
    )
      throw new Error("bad result");
    return value;
  },
};
function binding() {
  return {
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${randomUUID()}`,
    configFingerprint: "b".repeat(64),
    credentialSlot: "WORKER_KEY",
  };
}
function planned(authority, requestId = randomUUID()) {
  return {
    operation: "jobs.stageUtf8",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "jobs.stageUtf8",
      spaceId: authority.spaceId,
      sourceAccountId: authority.sourceAccountId,
      requestId,
      jobId: "job",
      leaseEpoch: 1,
      leaseToken: "secret-token",
    }),
    createdAt: 10,
  };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "kithmind-replay-test-"));
  const authority = binding();
  const open = () =>
    Journal.open({
      directory,
      binding: authority,
      credential: "credential",
      initialCheckpoint: { version: 1, phase: "stage" },
      codec,
    });
  return { directory, authority, open };
}

test("lost response leaves exact intent and restart replays the same body", async () => {
  const fixture = await setup();
  let journal = await fixture.open();
  const operation = planned(fixture.authority, "lost-stage-response");
  let sends = 0;
  await assert.rejects(() =>
    runJournaledCall(journal, operation, {
      now: () => 20,
      async sendExact(body) {
        sends += 1;
        assert.equal(body, operation.requestBody);
        throw new Error("connection lost after commit");
      },
      nextCheckpoint() {
        throw new Error("unreachable");
      },
    }),
  );
  assert.equal(journal.pending.requestBody, operation.requestBody);
  await journal.close();

  journal = await fixture.open();
  const result = await resumePendingCall(journal, {
    now: () => 21,
    async sendExact(body) {
      sends += 1;
      assert.equal(body, operation.requestBody);
      return { operation: "jobs.stageUtf8", state: "staged" };
    },
    nextCheckpoint({ checkpoint, pending, result: replayed }) {
      assert.equal(checkpoint.phase, "stage");
      assert.equal(pending.requestId, "lost-stage-response");
      assert.equal(replayed.state, "staged");
      return {
        checkpoint: { version: 1, phase: "activate" },
        credentialSessionActive: true,
      };
    },
  });
  assert.equal(result.state, "staged");
  assert.equal(sends, 2);
  assert.equal(journal.pending, undefined);
  assert.equal(journal.checkpoint.phase, "activate");
  await journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
});

test("cached result advances after restart without sending again", async () => {
  const fixture = await setup();
  let journal = await fixture.open();
  await journal.planRequest(planned(fixture.authority, "cached-stage-result"));
  await journal.recordValidatedResult(
    { operation: "jobs.stageUtf8", state: "staged" },
    20,
  );
  await journal.close();

  journal = await fixture.open();
  let sends = 0;
  await resumePendingCall(journal, {
    now: () => 30,
    async sendExact() {
      sends += 1;
      throw new Error("must not send");
    },
    nextCheckpoint() {
      return {
        checkpoint: { version: 1, phase: "activate" },
        credentialSessionActive: true,
      };
    },
  });
  assert.equal(sends, 0);
  assert.equal(journal.pending, undefined);
  assert.equal(journal.checkpoint.phase, "activate");
  await journal.close();

  journal = await fixture.open();
  assert.equal(journal.pending, undefined);
  assert.equal(journal.checkpoint.phase, "activate");
  await journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
});

test("checkpoint failure retains the validated result for idempotent retry", async () => {
  const fixture = await setup();
  let journal = await fixture.open();
  await journal.planRequest(planned(fixture.authority, "checkpoint-failure"));
  let sends = 0;
  await assert.rejects(() =>
    resumePendingCall(journal, {
      now: () => 20,
      async sendExact() {
        sends += 1;
        return { operation: "jobs.stageUtf8", state: "staged" };
      },
      nextCheckpoint() {
        throw new Error("simulated crash before checkpoint");
      },
    }),
  );
  assert.equal(journal.pending.result.value.state, "staged");
  await journal.close();

  journal = await fixture.open();
  await resumePendingCall(journal, {
    now: () => 30,
    async sendExact() {
      sends += 1;
      throw new Error("must not send");
    },
    nextCheckpoint() {
      return {
        checkpoint: { version: 1, phase: "activate" },
        credentialSessionActive: true,
      };
    },
  });
  assert.equal(sends, 1);
  await journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
});

test("invalid result is never cached and a newer request cannot replace pending intent", async () => {
  const fixture = await setup();
  const journal = await fixture.open();
  await journal.planRequest(planned(fixture.authority, "first"));
  await assert.rejects(
    () =>
      journal.recordValidatedResult(
        { operation: "jobs.activate", state: "ready" },
        20,
      ),
    JournalSafetyError,
  );
  assert.equal(journal.pending.result, undefined);
  await assert.rejects(
    () =>
      runJournaledCall(journal, planned(fixture.authority, "second"), {
        now: () => 30,
        async sendExact() {
          throw new Error("must not send");
        },
        nextCheckpoint() {
          throw new Error("must not advance");
        },
      }),
    JournalSafetyError,
  );
  assert.equal(journal.pending.requestId, "first");
  await journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
});

test("an authority-mismatched request is rejected before transport", async () => {
  const fixture = await setup();
  const journal = await fixture.open();
  const operation = planned(fixture.authority, "wrong-authority");
  const body = JSON.parse(operation.requestBody);
  body.spaceId = `space_${randomUUID()}`;
  operation.requestBody = JSON.stringify(body);
  let sends = 0;
  await assert.rejects(
    () =>
      runJournaledCall(journal, operation, {
        now: () => 20,
        async sendExact() {
          sends += 1;
          throw new Error("must not send");
        },
        nextCheckpoint() {
          throw new Error("must not advance");
        },
      }),
    JournalSafetyError,
  );
  assert.equal(sends, 0);
  assert.equal(journal.pending, undefined);
  await journal.close();
  await rm(fixture.directory, { recursive: true, force: true });
});
