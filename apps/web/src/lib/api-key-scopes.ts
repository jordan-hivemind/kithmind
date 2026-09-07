export type ApiKeyCapability = "read" | "write" | "ingest";

/** Source grants are meaningful only for credentials that can ingest. */
export function sourceAccountGrantsForCapabilities<T>(
  capabilities: readonly ApiKeyCapability[],
  sourceAccountIds: readonly T[],
): T[] {
  return capabilities.includes("ingest") ? [...sourceAccountIds] : [];
}
