// JSON serialization for MCP tool responses. run_query reads money columns
// with node:sqlite's setReadBigInts(true) (see queryGuard.ts), because a
// plain Number on an INTEGER minor-units column is exactly the binary float
// the money policy exists to prevent. A bare JSON.stringify throws on a
// BigInt; this converts each one to its exact decimal string instead, so a
// big total survives the trip out as a string, never as a float.

export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
