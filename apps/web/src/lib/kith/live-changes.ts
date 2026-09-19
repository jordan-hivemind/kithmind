// The pure half of the live-changes client: parsing an SSE body and deciding
// what a change invalidates. No React, no fetch, so both are testable without
// a DOM.

/** One change as `/api/kith/changes` sends it. Ids only, never row content. */
export type LiveChange = {
  id: string;
  table: string;
  rowId: string;
  op: "insert" | "update" | "delete";
};

export type LiveChangeFrame =
  | { kind: "change"; change: LiveChange }
  | { kind: "end"; cursor: string }
  | { kind: "heartbeat" };

/**
 * One SSE event block (`id:` / `event:` / `data:` lines) to a frame, or null
 * when it is a comment, a `retry:` hint or anything this client does not
 * model. Unknown event types are ignored rather than thrown on: the server may
 * grow a new one before the client is redeployed.
 */
export function parseEventBlock(block: string): LiveChangeFrame | null {
  let id = "";
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data = data === "" ? value : `${data}\n${value}`;
  }
  if (event === "end") return { kind: "end", cursor: id };
  if (event !== "change" || id === "") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object") return null;
    const { table, rowId, op } = parsed as Record<string, unknown>;
    if (typeof table !== "string" || typeof rowId !== "string") return null;
    if (op !== "insert" && op !== "update" && op !== "delete") return null;
    return { kind: "change", change: { id, table, rowId, op } };
  } catch {
    return null;
  }
}

/**
 * Splits whatever has arrived so far into complete event blocks plus the
 * remainder, so a chunk that cuts an event in half does not lose it.
 */
export function splitEventBlocks(buffer: string): {
  blocks: string[];
  rest: string;
} {
  const parts = buffer.split("\n\n");
  return { blocks: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

/**
 * The query keys a set of changes invalidates.
 *
 * A screen registers the tables it reads under a key (`{ sources:
 * ["source_accounts", "source_roots", ...] }`), and a change on any of them
 * invalidates that key once however many rows changed. Keying by table rather
 * than by row is the whole reason the feed carries no row content: the client
 * refetches the query, and the query re-reads the rows under the caller's own
 * authorization.
 */
export function invalidatedKeys(
  changes: readonly LiveChange[],
  watched: Readonly<Record<string, readonly string[]>>,
): string[] {
  const tables = new Set(changes.map((change) => change.table));
  return Object.entries(watched)
    .filter(([, watchedTables]) =>
      watchedTables.some((table) => tables.has(table)),
    )
    .map(([key]) => key);
}
