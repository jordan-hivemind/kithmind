// The wire contract's request validation lives in `@repo/worker-protocol`.
//
// It moved there for P2-39e: the same 33 operations are being served from
// PostgreSQL (`packages/kith-store/src/workers`) behind the same unchanged wire
// contract, and "the same closed key sets, the same safe error codes" is a
// property worth having by construction rather than by two copies agreeing.
// Nothing about the contract changed in the move; this module keeps its name and
// its exports so every call site here is untouched.
export * from "@repo/worker-protocol/request";
