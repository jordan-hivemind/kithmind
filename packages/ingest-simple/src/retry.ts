// A small, package-local serialization retry for the one Postgres
// transaction a file's `ingestFile` call makes (write.ts). `@repo/kith-store`'s
// own `withKithTransaction` already retries a `40001`/`40P01` internally, but
// the first real run over 522 files (`docs/plans/2026-09-22-simplification-
// and-feeds.md`'s ingestion line) still reported "could not serialize access
// due to read/write dependencies among transactions" as a hard per-file
// failure at `--concurrency 2`: a multi-table staging transaction (source
// item, revision, text version, pages, evidence spans, document, chunks,
// generation, activation) held open long enough, under real contention, to
// exhaust that budget. This is a second, independent retry layer at the call
// site -- a fresh `ingestFile` attempt from scratch, not a resumed
// transaction -- so a file that loses a race twice still gets a third try
// before this package counts it as failed.

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 200;

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The two SQLSTATEs that mean "this attempt lost to a concurrent one; the
 * same work may well succeed if run again" -- see `schema.ts`'s own
 * `isSerializationFailure`, which this mirrors: `40001`
 * (serialization_failure, the `SERIALIZABLE` abort) and `40P01`
 * (deadlock_detected).
 */
export function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "40001" ||
      (error as { code?: unknown }).code === "40P01")
  );
}

export type SerializationRetryOptions = {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Base delay before the first retry; doubles per attempt, full jitter,
   * capped at `maxDelayMs`. Default 25ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Test seam: replaces the real timer-based wait. */
  sleep?: Sleep;
  /** Called once per retryable failure, before the backoff wait, so a caller
   * can count "this file needed a retry" without inspecting attempt counts. */
  onRetry?: (attempt: number, error: unknown) => void;
};

/**
 * Runs `work`, retrying up to `attempts` times (3 by default) when it rejects
 * with a `40001`/`40P01` Postgres error, with a short randomized backoff
 * between attempts. Any other error, or a serialization failure on the final
 * attempt, rejects immediately -- the caller (ingest.ts) counts that as an
 * ordinary per-file failure.
 */
export async function withSerializationRetry<T>(
  work: () => Promise<T>,
  options: SerializationRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === attempts) throw error;
      options.onRetry?.(attempt, error);
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * cap);
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("withSerializationRetry: exhausted attempts without a result");
}
