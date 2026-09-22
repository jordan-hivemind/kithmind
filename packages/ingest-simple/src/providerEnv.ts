// `--env-from-keychain`: fills in the model-provider environment this
// package's own OCR (ocr.ts), extraction and embedding calls already read
// from `process.env` (`KITH_EXTRACT_*`/`OPENAI_API_KEY` falling back to it,
// `BRAIN_EMBED_*`/`OPENAI_API_KEY`), the same way the deferred-work daemon's
// own wrapper script does for its own process
// (`docs/worker-service.md`'s "Deferred work daemon": "It reads
// `KITH_STORE_DATABASE_URL`, plus the embedding provider key
// (`OPENAI_API_KEY` or the `BRAIN_EMBED_*` set) that `embedding_fill` jobs
// use"). Run from an interactive shell (not the daemon's own LaunchAgent
// environment), this CLI otherwise has none of that configured, which is
// exactly what produced "a page needs OCR but no extraction provider is
// configured" and "Embedding provider request failed" across the first real
// run.
//
// `DATABASE_URL` is not this module's concern: `config.ts`'s
// `loadDatabaseUrl` already falls back to its own Keychain item
// unconditionally, with or without this flag.

import { readKeychainSecretByService } from "./keychain.js";

/** The deferred-work daemon's own OpenAI-compatible provider key, read the
 * same way `config.ts`'s `DATABASE_URL_SERVICE` is -- see the daemon's
 * private wrapper script, which exports it as `OPENAI_API_KEY`. */
export const OPENAI_API_KEY_SERVICE = "com.kithmind.deferred-work.openai-key";

/**
 * The embedding model/revision the deferred-work daemon's wrapper exports
 * unconditionally alongside the key above, so this package's embedding calls
 * fingerprint-match the daemon's active generation rather than falling back
 * to `embeddings/provider.ts`'s own baseline (`text-embedding-3-small`
 * /`legacy-openai-small-1536-v1`) -- a mismatched profile fails the
 * embedding request outright rather than writing a vector under the wrong
 * identity. Only applied when the run's own environment leaves them unset,
 * exactly like the key.
 */
export const DEFAULT_BRAIN_EMBED_MODEL = "text-embedding-3-large";
export const DEFAULT_BRAIN_EMBED_MODEL_REVISION = "comparison-openai-large-1536-v1";

export type ProviderEnvResult = {
  /** Whether `OPENAI_API_KEY` was set from the Keychain item (false if it
   * was already set in the environment, or the item was not found). */
  loadedApiKey: boolean;
};

/**
 * Fills `env.OPENAI_API_KEY`, `env.BRAIN_EMBED_MODEL` and
 * `env.BRAIN_EMBED_MODEL_REVISION` in place, each only when currently unset
 * (empty or missing) -- an explicitly configured value, however it got
 * there, always wins. `env` defaults to `process.env` so cli.ts's mutation
 * is picked up by every call that already reads `process.env` directly
 * (convert.ts/ocr.ts's default, postProcess.ts's explicit pass-through);
 * takes an explicit object in tests so nothing here ever touches the real
 * Keychain or the test process's actual environment.
 *
 * Never logs a value -- only whether the Keychain item was found, via the
 * returned `loadedApiKey`.
 */
export async function applyProviderEnvFromKeychain(
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderEnvResult> {
  let loadedApiKey = false;
  if (!env.OPENAI_API_KEY) {
    const key = await readKeychainSecretByService(OPENAI_API_KEY_SERVICE);
    if (key) {
      env.OPENAI_API_KEY = key;
      loadedApiKey = true;
    }
  }
  if (!env.BRAIN_EMBED_MODEL) env.BRAIN_EMBED_MODEL = DEFAULT_BRAIN_EMBED_MODEL;
  if (!env.BRAIN_EMBED_MODEL_REVISION) env.BRAIN_EMBED_MODEL_REVISION = DEFAULT_BRAIN_EMBED_MODEL_REVISION;
  return { loadedApiKey };
}
