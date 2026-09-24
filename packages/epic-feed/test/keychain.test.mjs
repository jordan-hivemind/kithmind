// The pure argv builders behind the Keychain-backed `TokenStore`, asserted
// without ever executing `/usr/bin/security` -- that binary does not exist
// on a Linux CI runner, which is exactly why `runAuthorize`/`pull` take an
// injectable `TokenStore` instead of calling these write/delete functions
// directly (see authorize.test.mjs, pull.test.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import { addGenericPasswordArgs, deleteGenericPasswordArgs } from "../dist/index.js";

test("addGenericPasswordArgs builds the exact security add-generic-password argv", () => {
  assert.deepEqual(
    addGenericPasswordArgs(
      "jordan",
      "com.kithmind.epic.token.jamie-synthetic",
      "the-secret-json",
    ),
    [
      "add-generic-password",
      "-U",
      "-a",
      "jordan",
      "-s",
      "com.kithmind.epic.token.jamie-synthetic",
      "-w",
      "the-secret-json",
    ],
  );
});

test("deleteGenericPasswordArgs builds the exact security delete-generic-password argv", () => {
  assert.deepEqual(
    deleteGenericPasswordArgs("jordan", "com.kithmind.epic.token.jamie-synthetic"),
    ["delete-generic-password", "-a", "jordan", "-s", "com.kithmind.epic.token.jamie-synthetic"],
  );
});
