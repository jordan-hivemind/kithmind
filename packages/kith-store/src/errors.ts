/**
 * The one error this package throws. A code rather than a message, because
 * every caller across the port boundary (a route handler, an MCP tool, the
 * worker protocol) branches on it and none of them parse prose.
 *
 * Named for the prototype this package grew out of, and kept named that way
 * deliberately: its codes are asserted by name in the integration proof, and
 * renaming a tested error class is churn rather than a change.
 */
export class ProofError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProofError";
  }
}
