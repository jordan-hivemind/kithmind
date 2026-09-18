// P2-101: the two failure-code enums are allowlists. A code missing from one
// is silently reported as `runner_failed` or `unknown`, which is the exact
// blindness this row exists to remove, so keep them complete by reading the
// sources rather than by remembering to.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { POSTGRES_BACKUP_CODES } from "./db-backup-postgres.mjs";
import { RESTORE_PROOF_CODES } from "./db-restore-proof.mjs";

async function codesIn(...files) {
  const found = new Set();
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const [, code] of source.matchAll(/(?:fail|new \w*Error)\(\s*"([a-z_]+)"/gu)) {
      found.add(code);
    }
  }
  return found;
}
function missing(codes, declared) {
  return [...codes].filter((code) => !declared.has(code)).sort();
}

test("every restore-proof failure code is in its closed enum", async () => {
  assert.deepEqual(
    missing(await codesIn("./db-restore-proof.mjs", "./db-postgres-parity.mjs"), RESTORE_PROOF_CODES),
    [],
  );
});

test("every postgres-engine failure code is in its closed enum", async () => {
  assert.deepEqual(
    missing(await codesIn("./db-backup-postgres.mjs", "./db-postgres-parity.mjs"), POSTGRES_BACKUP_CODES),
    [],
  );
  for (const code of RESTORE_PROOF_CODES) {
    assert.ok(POSTGRES_BACKUP_CODES.has(`restore_proof_failed:${code}`));
  }
});
