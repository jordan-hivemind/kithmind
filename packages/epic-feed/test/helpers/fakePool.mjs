// A fake `pg.Pool` that just records every query, for the unit tests that
// exercise `db.ts`'s statements without a real database. Modeled on
// `@repo/plaid-feed`'s own `fakePool()` helper.

export function fakePool(responses = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      const trimmed = text.trim();
      calls.push({ text: trimmed, params });
      for (const [pattern, respond] of Object.entries(responses)) {
        if (trimmed.includes(pattern)) {
          return typeof respond === "function" ? respond(params) : respond;
        }
      }
      // A default row with a generated `id`, matching every `RETURNING id`
      // statement `db.ts` issues (`upsertHealthRecord`, `upsertHealthSource`)
      // -- a test only overrides `responses` when it cares about a specific
      // shape (a `SELECT` expecting no rows, for example).
      return { rows: [{ id: "fake-id" }] };
    },
  };
}
