// The six checks P2-39b's parity harness left `pending`, exercised the way the
// harness calls them: `authDenialSurfaceOnPool`, so each one is a real
// `SERIALIZABLE` transaction on a pooled client rather than a shared session, and
// each one is rolled back so the harness's row counts still match the export.
//
// This is also the test that would notice a predicate quietly starting to pass for
// the wrong reason: it asserts that every one of the six returns true, that the
// surface has exactly the six methods `AuthDenialSurface` declares, and that one
// of them returns false when the denial it names is removed.

import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  applyKithSchema,
  createKithPool,
  withKithTransaction,
} from "../dist/index.js";
import {
  authDenialSurface,
  authDenialSurfaceOnPool,
  identityCtx,
} from "../dist/identity/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

/**
 * A pool closed before the throwaway database is dropped.
 *
 * `throwawayDatabase` registers its `DROP DATABASE ... WITH (FORCE)` first, and
 * `after` hooks run in registration order, so a pool released only in a later hook
 * still holds an idle connection when the drop terminates it -- and a terminated
 * node-postgres client with no `error` listener is an uncaught exception, not a
 * tidy cleanup. So the pool is closed inside the test body, and it carries a
 * listener regardless.
 */
async function withPool(database, make, work) {
  const pool = make(database.url);
  pool.on("error", () => {});
  try {
    return await work(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** The method names `packages/kith-migrate/src/parity.ts` calls. */
const EXPECTED_CHECKS = [
  "revokedKeyDenied",
  "writeWithoutCapabilityDenied",
  "crossSpaceKeyDenied",
  "removedMemberDenied",
  "staleSessionDenied",
  "crossSpaceReadReturnsNothing",
];

test(
  "every auth-denial and space-isolation check the parity harness expects denies",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyKithSchema(client);

    await withPool(
      database,
      (url) => createKithPool(url, 2),
      async (pool) => {
        const surface = authDenialSurfaceOnPool(pool);

        assert.deepEqual(
          Object.keys(surface).sort(),
          [...EXPECTED_CHECKS].sort(),
        );
        for (const name of EXPECTED_CHECKS) {
          assert.equal(
            await surface[name](),
            true,
            `${name} did not deny as expected`,
          );
        }
      },
    );
  },
);

test(
  "the surface is honest: a check fails when the denial it names stops happening",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyKithSchema(client);
    await withPool(
      database,
      (url) => createKithPool(url, 2),
      async (pool) => {
        // Widen the schema so a read-only key can be granted the write capability it
        // is supposed to lack, then confirm the capability check is what was doing the
        // work: with the capability present, `writeWithoutCapabilityDenied` returns
        // false rather than passing on some unrelated refusal.
        const widened = authDenialSurface(async (work) => {
          return await withKithTransaction(pool, async (transactionClient) => {
            const ctx = identityCtx(transactionClient);
            const original = transactionClient.query.bind(transactionClient);
            transactionClient.query = (sql, values) => {
              if (
                typeof sql === "string" &&
                sql.includes("INSERT INTO kith.api_keys") &&
                Array.isArray(values)
              ) {
                const next = [...values];
                const index = next.findIndex((value) => value === '["read"]');
                if (index !== -1) next[index] = '["read","write"]';
                return original(sql, next);
              }
              return original(sql, values);
            };
            try {
              return await work(ctx);
            } finally {
              transactionClient.query = original;
            }
          });
        });
        assert.equal(
          await widened.writeWithoutCapabilityDenied(),
          false,
          "the check must fail when the key actually has the write capability",
        );
      },
    );
  },
);

test(
  "the migrated schema is what the checks run against",
  { skip },
  async (t) => {
    // Not a tautology: a denial suite that quietly built its own convenient
    // tables would prove nothing about the schema the migration produces.
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyKithSchema(client);
    const { rows } = await withPool(
      database,
      (url) => new pg.Pool({ connectionString: url, max: 1 }),
      (pool) =>
        pool.query(
          `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'kith' AND table_name = ANY($1::text[])
             ORDER BY table_name`,
          [
            [
              "api_keys",
              "api_key_spaces",
              "sessions",
              "space_members",
              "spaces",
              "users",
            ],
          ],
        ),
    );
    assert.deepEqual(
      rows.map((row) => row.table_name),
      [
        "api_key_spaces",
        "api_keys",
        "sessions",
        "space_members",
        "spaces",
        "users",
      ],
    );
  },
);
