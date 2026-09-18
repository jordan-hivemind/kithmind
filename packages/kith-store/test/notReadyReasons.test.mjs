// P2-100b. The reason tally must name a throw precisely enough that one
// deploy answers "which loader, and what kind of error", and must do it
// without ever recording a message, an id or a row value.
//
// These tests need no database: the loaders take a `ClientBase`, so a stub
// that returns planted rows drives the real throw through the real mapping.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ProofError, provenance } from "../dist/index.js";
import {
  ERROR_KINDS,
  LOADER_ERROR_MESSAGES,
  MAX_REASON_KEYS,
  OTHER_REASON,
  REASON_STAGES,
  WorkerProtocolError,
  errorKind,
  incrementReason,
  isNotReadyReason,
  readNotReadyReasons,
  stagedReason,
} from "../dist/workers/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// A message that no longer exists in the file it names would silently degrade
// every error it covers to `unmapped_error`, which is exactly the round trip
// this row exists to prevent. Read the real source rather than trust the table.
test("every mapped loader message still exists in the file it names", async () => {
  const sources = new Map();
  for (const entry of LOADER_ERROR_MESSAGES) {
    if (!sources.has(entry.file)) {
      sources.set(entry.file, await readFile(packageRoot + entry.file, "utf8"));
    }
    assert.ok(
      sources.get(entry.file).includes(`"${entry.message}"`),
      `missing literal for ${entry.kind} in ${entry.file}`,
    );
    assert.ok(ERROR_KINDS.includes(entry.kind));
  }
  assert.equal(
    new Set(LOADER_ERROR_MESSAGES.map((entry) => entry.kind)).size,
    LOADER_ERROR_MESSAGES.length,
  );
});

test("a reason key is only ever closed-enum parts", () => {
  for (const stage of REASON_STAGES) {
    assert.ok(isNotReadyReason(`${stage}:scan_conflict`));
    assert.ok(isNotReadyReason(`${stage}:TypeError`));
    assert.ok(isNotReadyReason(`${stage}:sqlstate:40001`));
    assert.ok(!isNotReadyReason(`${stage}:some message`));
    assert.ok(!isNotReadyReason(`${stage}:sqlstate:not-a-state`));
  }
  assert.ok(isNotReadyReason("job_shape"));
  assert.ok(isNotReadyReason(OTHER_REASON));
  assert.ok(!isNotReadyReason("made_up_reason"));
  assert.ok(!isNotReadyReason("receipt_chain:kith_0123456789"));
});

test("an error's kind is its code, its mapped literal, or nothing", () => {
  assert.equal(errorKind(new WorkerProtocolError("scan_conflict")), "scan_conflict");
  assert.equal(errorKind(new ProofError("request_conflict")), "request_conflict");
  assert.equal(errorKind(new TypeError("whatever it said")), "TypeError");
  const dbError = new Error("duplicate key value violates unique constraint");
  dbError.name = "DatabaseError";
  dbError.code = "23505";
  assert.equal(errorKind(dbError), "sqlstate:23505");
  // A message that is not in the table contributes nothing but the shape.
  assert.equal(errorKind({ message: "/Users/someone/private.pdf" }), "unmapped_error");
});

/** A `ClientBase` stand-in that answers each query from a planted list. */
function stubClient(results) {
  let call = 0;
  return {
    query: async () => {
      const rows = results[call] ?? [];
      call += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

test("a real archive binding failure names the loader and the literal", async () => {
  // Two rows for one (account, subject_key, copy_role): the loader refuses
  // rather than pick one.
  const notUnique = stubClient([[{ id: "a" }, { id: "b" }]]);
  await assert.rejects(
    provenance.loadCurrentArchiveBinding(notUnique, {
      spaceId: "s",
      sourceAccountId: "a",
      sourceItemId: "i",
      sourceRevisionId: "r",
      subjectKind: "original_bytes",
      copyRole: "primary",
    }),
    (error) => {
      assert.equal(
        stagedReason("binding_load_error:original_bytes/primary", error),
        "binding_load_error:original_bytes/primary:archive_binding_not_unique",
      );
      return true;
    },
  );

  // One row that does not match the subject it was asked for.
  const mismatched = stubClient([
    [
      {
        id: "b",
        space_id: "other",
        source_account_id: "a",
        source_item_id: "i",
        source_revision_id: "r",
        subject_kind: "original_bytes",
        copy_role: "primary",
        subject_key: "k",
        receipt_id: "rc",
        binding_epoch: 0,
      },
    ],
    [{ id: "rc" }],
  ]);
  await assert.rejects(
    provenance.loadCurrentArchiveBinding(mismatched, {
      spaceId: "s",
      sourceAccountId: "a",
      sourceItemId: "i",
      sourceRevisionId: "r",
      subjectKind: "original_bytes",
      copyRole: "primary",
    }),
    (error) => {
      assert.equal(
        stagedReason("binding_load_error:original_bytes/primary", error),
        "binding_load_error:original_bytes/primary:archive_binding_invalid",
      );
      return true;
    },
  );
});

test("a provider binding with no verification names the loader and TypeError", async () => {
  // `verified_at` is nullable in migration 004, and the loader reads
  // `.getTime()` off it. The tally must say which loader threw and that it was
  // a TypeError, and nothing else.
  const client = stubClient([
    [
      {
        id: "b",
        space_id: "s",
        source_account_id: "a",
        source_item_id: "i",
        source_revision_id: "r",
        reference_id: "ref",
        binding_epoch: 0,
        verified_at: null,
      },
    ],
  ]);
  await assert.rejects(provenance.loadProviderOriginalBinding(client, "r"), (error) => {
    assert.equal(
      stagedReason("provider_binding_load_error", error),
      "provider_binding_load_error:TypeError",
    );
    return true;
  });
});

// P2-100c. `payload_verify_error:scan_conflict` named a 250-line function.
// Every detail it can now report has to be a key the tally will keep, or the
// next pass loses the answer again.
test("every payload verify detail is a kind the tally accepts", () => {
  assert.ok(provenance.PAYLOAD_VERIFY_DETAILS.length > 40);
  for (const detail of provenance.PAYLOAD_VERIFY_DETAILS) {
    assert.ok(ERROR_KINDS.includes(detail), detail);
    assert.ok(
      isNotReadyReason(`payload_verify_error:${detail}`),
      `payload_verify_error:${detail}`,
    );
    // Fixed literals only: nothing that could carry an id, hash or count.
    assert.match(detail, /^[a-z_]+(:[a-z_]+)?$/);
  }
  assert.equal(
    new Set(provenance.PAYLOAD_VERIFY_DETAILS).size,
    provenance.PAYLOAD_VERIFY_DETAILS.length,
  );
});

test("the verifier names its check and still throws what it always threw", async () => {
  // A generation missing the three ids refuses at the first check. The note
  // fires, and the error is the same ProofError with the same code.
  const seen = [];
  await assert.rejects(
    provenance.verifySealedParsedPayload(stubClient([]), { id: "g" }, (detail) =>
      seen.push(detail),
    ),
    (error) => {
      assert.equal(error.name, "ProofError");
      assert.equal(error.code, "scan_conflict");
      return true;
    },
  );
  assert.deepEqual(seen, ["missing_ids"]);

  // The same call with no note behaves identically, which is what the seal and
  // activate callers rely on.
  await assert.rejects(
    provenance.verifySealedParsedPayload(stubClient([]), { id: "g" }),
    (error) => error.name === "ProofError" && error.code === "scan_conflict",
  );

  // A later site: the ids are present, the manifest row is not.
  const later = [];
  await assert.rejects(
    provenance.verifySealedParsedPayload(
      stubClient([[], []]),
      {
        id: "g",
        payloadManifestId: "m",
        sourceTextVersionId: "t",
        parserArtifactId: "a",
      },
      (detail) => later.push(detail),
    ),
    (error) => error.code === "scan_conflict",
  );
  assert.deepEqual(later, ["manifest_or_text_missing"]);
});

test("the key set stays bounded and overflows into one bucket", () => {
  let reasons = {};
  for (let index = 0; index < MAX_REASON_KEYS + 10; index += 1) {
    reasons = incrementReason(reasons, `receipt_chain:sqlstate:${index + 10000}`);
  }
  assert.equal(Object.keys(reasons).length, MAX_REASON_KEYS + 1);
  assert.equal(reasons[OTHER_REASON], 10);
  // A key already present keeps counting rather than overflowing.
  reasons = incrementReason(reasons, "receipt_chain:sqlstate:10000");
  assert.equal(reasons["receipt_chain:sqlstate:10000"], 2);
  assert.equal(Object.keys(reasons).length, MAX_REASON_KEYS + 1);
  // Reading back drops unknown keys and honours the same cap.
  const read = readNotReadyReasons({
    notReadyReasons: { ...reasons, "not a reason": 4, job_shape: -1 },
  });
  assert.ok(Object.keys(read).length <= MAX_REASON_KEYS);
  assert.equal(read["not a reason"], undefined);
  assert.equal(read.job_shape, undefined);
});
