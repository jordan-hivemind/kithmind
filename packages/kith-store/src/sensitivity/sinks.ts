// The sinks that get scrubbed, and nothing else.
//
// Every function here is a wrapper for one place where text the machinery
// produced -- not text the owner asked for -- leaves the archive. Logs, error
// strings handed to clients, change-feed payloads, and the `last_error` a
// failed job writes. None of these is a read of the owner's data: they are
// incidental copies made by code, read by whoever can read a log aggregator,
// and nobody decided to put an SSN in one.
//
// The rule these encode, and the one a reviewer should check every call site
// against: scrubbing here must never change what is STORED as archive content
// and never change what a tool RETURNS. If a change to this file would alter
// either, the change is wrong. `last_error` is the one borderline case and it
// is included deliberately -- it is a diagnostic string a worker wrote about a
// failure, displayed on an operations screen, not a value anybody asked the
// archive to keep.

import { scrubIdentifiers } from "./identifiers.js";

/**
 * A log line, or any string on its way to `console.*`.
 *
 * Returns the text unchanged when it carries no identifier, which is almost
 * every line, so the common path allocates nothing.
 */
export function scrubLogText(text: string): string {
  return scrubIdentifiers(text);
}

/**
 * One structured log record's values, scrubbed in place of its strings.
 *
 * Shallow on purpose: the log records this codebase writes are flat objects of
 * scalars (`{ tool, name, message }` in the MCP error boundary, `{ jobId,
 * kind, error }` in the deferred runner). Walking arbitrary depth would invite
 * this being pointed at a row of archive data, which is exactly the thing it
 * must not be used for.
 */
export function scrubLogFields<T extends Record<string, unknown>>(fields: T): T {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      const safe = scrubIdentifiers(value);
      if (safe !== value) changed = true;
      out[key] = safe;
    } else {
      out[key] = value;
    }
  }
  return (changed ? out : fields) as T;
}

/**
 * An error message about to be handed to a client or written to a log.
 *
 * The MCP boundary already replaces most messages with "Internal error"; this
 * covers the ones it passes through and the original it logs. A parser or a
 * database driver quoting the offending value is the usual way an identifier
 * reaches a log line, and it reaches it inside an error message.
 */
export function scrubErrorMessage(message: string): string {
  return scrubIdentifiers(message);
}

/** An `Error`'s message, scrubbed, for a thrown value of unknown type. */
export function scrubThrown(error: unknown): string {
  return scrubErrorMessage(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * A `deferred_work.last_error` string before it is written.
 *
 * Bounded as well as scrubbed: the column takes a diagnostic, and a stack trace
 * or a quoted document page is neither diagnostic nor something this row should
 * carry a copy of.
 */
export function scrubJobError(message: string, maxChars = 2_000): string {
  const scrubbed = scrubIdentifiers(message);
  return scrubbed.length <= maxChars
    ? scrubbed
    : `${scrubbed.slice(0, maxChars)}…`;
}

/**
 * A change-feed payload's string values.
 *
 * The feed carries table names, row ids and operations rather than row
 * contents, so in practice this finds nothing -- which is the point of applying
 * it: the day someone widens the feed to carry a title or an error, the
 * scrubbing is already in the path rather than being remembered.
 */
export function scrubFeedPayload<T extends Record<string, unknown>>(
  payload: T,
): T {
  return scrubLogFields(payload);
}

/**
 * Anything on its way to an outbound alert, webhook or third-party endpoint.
 *
 * Nothing calls this today: the deployment has no alerting, by decision. It
 * exists so that the first thing that does has an obvious function to call, and
 * so the test below fixes the expectation now rather than after the first
 * webhook ships.
 */
export function scrubOutbound(text: string): string {
  return scrubIdentifiers(text);
}
