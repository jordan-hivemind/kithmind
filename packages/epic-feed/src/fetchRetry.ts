// A small retrying JSON fetch: 429 and 5xx get retried with backoff (honoring
// `Retry-After` when Epic sends one), everything else is returned or thrown
// immediately. Shared by `pull.ts`'s resource paging and its Binary fetch.

import type { Fetch } from "./oauth.js";

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 250;

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Fetches `url`, retrying a 429 or 5xx response up to `maxAttempts` times.
 * Returns the final `Response` (never throws for a non-2xx status; the
 * caller decides what a persistent failure means). */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: Fetch,
  options: RetryOptions = {},
): Promise<Response> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, init);
    if (response.status !== 429 && response.status < 500) return response;
    lastResponse = response;
    if (attempt === maxAttempts - 1) return response;
    const delay = retryAfterMs(response) ?? baseDelayMs * 2 ** attempt;
    await sleep(delay);
  }
  // Unreachable given maxAttempts >= 1, but keeps the return type total.
  return lastResponse!;
}
