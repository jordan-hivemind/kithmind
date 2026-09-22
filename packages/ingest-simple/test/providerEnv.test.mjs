// Synthetic-fixture unit tests for `applyProviderEnvFromKeychain`: operates
// on a plain object, never the real environment. `OPENAI_API_KEY` is always
// pre-set in every fixture here, so the real `security` binary is never
// invoked (the Keychain read itself is `keychain.ts`'s
// `readKeychainSecretByService`, a thin, already-covered wrapper this module
// calls only on the unset-key path).

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProviderEnvFromKeychain,
  DEFAULT_BRAIN_EMBED_MODEL,
  DEFAULT_BRAIN_EMBED_MODEL_REVISION,
} from "../dist/providerEnv.js";

test("applyProviderEnvFromKeychain leaves an already-set OPENAI_API_KEY untouched", async () => {
  const env = { OPENAI_API_KEY: "already-set" };
  const result = await applyProviderEnvFromKeychain(env);
  assert.equal(env.OPENAI_API_KEY, "already-set");
  assert.equal(result.loadedApiKey, false);
});

test("applyProviderEnvFromKeychain defaults BRAIN_EMBED_MODEL/REVISION only when unset", async () => {
  const env = { OPENAI_API_KEY: "already-set" };
  await applyProviderEnvFromKeychain(env);
  assert.equal(env.BRAIN_EMBED_MODEL, DEFAULT_BRAIN_EMBED_MODEL);
  assert.equal(env.BRAIN_EMBED_MODEL_REVISION, DEFAULT_BRAIN_EMBED_MODEL_REVISION);

  const envWithOverride = {
    OPENAI_API_KEY: "already-set",
    BRAIN_EMBED_MODEL: "text-embedding-3-small",
    BRAIN_EMBED_MODEL_REVISION: "legacy-openai-small-1536-v1",
  };
  await applyProviderEnvFromKeychain(envWithOverride);
  assert.equal(envWithOverride.BRAIN_EMBED_MODEL, "text-embedding-3-small");
  assert.equal(envWithOverride.BRAIN_EMBED_MODEL_REVISION, "legacy-openai-small-1536-v1");
});

test("applyProviderEnvFromKeychain treats an empty string as unset", async () => {
  const env = { OPENAI_API_KEY: "already-set", BRAIN_EMBED_MODEL: "" };
  await applyProviderEnvFromKeychain(env);
  assert.equal(env.BRAIN_EMBED_MODEL, DEFAULT_BRAIN_EMBED_MODEL);
});
