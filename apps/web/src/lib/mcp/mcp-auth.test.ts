// MCP bearer authentication on the PostgreSQL surface, against a real database.
//
// These go through `lib/mcp/auth.ts` rather than through `@repo/kith-store`,
// because what section 3.1 promises is a property of the route's authenticator:
// it returns an identity for a live credential and `null` for every other case,
// without telling the four cases apart. A store-level test would prove the store
// denies; this proves the gateway does, and that nothing on the way back widens
// it.
//
// A throwaway database per run, created and dropped here, matching i1's route
// tests: the suite skips cleanly when `KITH_STORE_DATABASE_URL` is not set,
// because a public clone has no Postgres, and no connection string is ever
// defaulted or committed.

import { randomBytes } from "node:crypto";

import {
  applyKithSchema,
  createKithPool,
  withKithTransaction,
} from "@repo/kith-store";
import {
  createApiKey,
  ensurePersonalSpace,
  type IdentityCtx,
  identityCtx,
  IdentityError,
  listSpaces,
  signUp,
} from "@repo/kith-store/identity";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { setKithPool } from "@/lib/kith/pool";

import { authenticateApiKey } from "./auth";
import { mcpPrincipalLoader } from "./principal";

const adminUrl = process.env.KITH_STORE_DATABASE_URL;
const describeWithDatabase = adminUrl ? describe : describe.skip;

const PASSWORD = "a strong enough password";

let accounts = 0;
function email(): string {
  accounts += 1;
  return `mcp-owner-${accounts}-${randomBytes(4).toString("hex")}@example.test`;
}

describeWithDatabase("MCP bearer authentication on PostgreSQL", () => {
  let pool: pg.Pool;
  let restorePool: () => void;
  let databaseName: string;

  async function onAdmin<T>(work: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await work(admin);
    } finally {
      await admin.end();
    }
  }

  function inTransaction<T>(work: (ctx: IdentityCtx) => Promise<T>): Promise<T> {
    return withKithTransaction(pool, (client) => work(identityCtx(client)));
  }

  /** A signed-up owner with a personal space and one read/write MCP key. */
  async function owner(): Promise<{
    userId: string;
    keyId: string;
    rawKey: string;
    spaceId: string;
  }> {
    return await inTransaction(async (ctx) => {
      const session = await signUp(ctx, { email: email(), password: PASSWORD });
      const spaceId = await ensurePersonalSpace(ctx, session.userId);
      const principal = {
        userId: session.userId,
        capabilities: ["read", "write"] as const,
      };
      const key = await createApiKey(ctx, {
        principal,
        name: "Synthetic MCP client",
        capabilities: ["read", "write"],
        spaceIds: [spaceId],
      });
      return {
        userId: session.userId,
        keyId: key.id,
        rawKey: key.rawKey,
        spaceId,
      };
    });
  }

  beforeAll(async () => {
    databaseName = `kith_mcp_auth_test_${randomBytes(8).toString("hex")}`;
    await onAdmin((admin) => admin.query(`CREATE DATABASE ${databaseName}`));
    const url = new URL(adminUrl!);
    url.pathname = `/${databaseName}`;

    const migrator = new pg.Client({ connectionString: url.toString() });
    migrator.on("error", () => {});
    await migrator.connect();
    await applyKithSchema(migrator);
    await migrator.end();

    pool = createKithPool(url.toString());
    pool.on("error", () => {});
    restorePool = setKithPool(pool);
  }, 60_000);

  afterAll(async () => {
    restorePool?.();
    await pool?.end().catch(() => {});
    await onAdmin((admin) =>
      admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    ).catch(() => {});
  }, 60_000);

  afterEach(() => vi.unstubAllEnvs());

  function onPostgres() {
    vi.stubEnv("KITH_POSTGRES_SURFACE", "postgres");
  }

  test("a live bearer authenticates and a revoked key does not", async () => {
    onPostgres();
    const account = await owner();

    const authenticated = await authenticateApiKey(`Bearer ${account.rawKey}`);
    expect(authenticated).toEqual({
      userId: account.userId,
      keyId: account.keyId,
    });

    // `last_used_at` is written by the same transaction that authenticated, so
    // a successful attempt is observable and a refused one leaves no trace.
    const touched = await pool.query(
      "SELECT last_used_at FROM kith.api_keys WHERE id = $1",
      [account.keyId],
    );
    expect(touched.rows[0]!.last_used_at).not.toBeNull();

    // Revocation deletes the row, which is what makes the denial immediate.
    await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [
      account.keyId,
    ]);
    expect(await authenticateApiKey(`Bearer ${account.rawKey}`)).toBeNull();
  });

  test("a key in an OAuth lifecycle authenticates nothing", async () => {
    onPostgres();
    for (const lifecycle of ["preparing", "pending"] as const) {
      const account = await owner();
      // The lifecycle column is what `hasNoOAuthLifecycle` reads. A key holding
      // either value exists so a code can be exchanged for it and is not yet a
      // credential.
      await pool.query(
        "UPDATE kith.api_keys SET oauth_lifecycle = $2 WHERE id = $1",
        [account.keyId, lifecycle],
      );
      expect(await authenticateApiKey(`Bearer ${account.rawKey}`)).toBeNull();

      // Clearing it is exactly what activation does, and it is the moment the
      // key starts authenticating.
      await pool.query(
        "UPDATE kith.api_keys SET oauth_lifecycle = NULL WHERE id = $1",
        [account.keyId],
      );
      expect(await authenticateApiKey(`Bearer ${account.rawKey}`)).toEqual({
        userId: account.userId,
        keyId: account.keyId,
      });
    }
  });

  test("a key whose user row is gone does not authenticate", async () => {
    onPostgres();
    const account = await owner();

    // A foreign key normally makes this state unreachable, which is why the
    // constraint is dropped for the length of the case: the check under test is
    // `userExists`, the live-user read the Convex action also performed, and it
    // is defense in depth behind that constraint rather than a duplicate of it.
    // A denial that only ever came from the key lookup would not prove it runs.
    const constraint = (
      await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
           WHERE conrelid = 'kith.api_keys'::regclass AND contype = 'f'
             AND confrelid = 'kith.users'::regclass`,
      )
    ).rows[0]!.conname;
    const missingUserId = randomBytes(16).toString("hex");

    await pool.query(
      `ALTER TABLE kith.api_keys DROP CONSTRAINT ${constraint}`,
    );
    try {
      await pool.query("UPDATE kith.api_keys SET user_id = $2 WHERE id = $1", [
        account.keyId,
        missingUserId,
      ]);
      expect(await authenticateApiKey(`Bearer ${account.rawKey}`)).toBeNull();
      // And the refusal left no trace that it was close.
      const touched = await pool.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM kith.api_keys WHERE id = $1",
        [account.keyId],
      );
      expect(touched.rows[0]!.last_used_at).toBeNull();
    } finally {
      await pool.query("UPDATE kith.api_keys SET user_id = $2 WHERE id = $1", [
        account.keyId,
        account.userId,
      ]);
      await pool.query(
        `ALTER TABLE kith.api_keys ADD CONSTRAINT ${constraint}
           FOREIGN KEY (user_id) REFERENCES kith.users (id)
           DEFERRABLE INITIALLY DEFERRED`,
      );
    }
  });

  test.each([
    ["no header", null],
    ["not a bearer", "Basic c2VjcmV0"],
    ["an empty bearer", "Bearer "],
    ["a bearer that is not a key", "Bearer not-an-api-key"],
    ["a bearer that looks like one", `Bearer ob_${"a".repeat(64)}`],
  ])("a malformed bearer authenticates nothing: %s", async (_name, header) => {
    onPostgres();
    expect(await authenticateApiKey(header)).toBeNull();
  });

  test("the per-call loader denies on the call after a revocation", async () => {
    onPostgres();
    const account = await owner();
    const authenticated = await authenticateApiKey(`Bearer ${account.rawKey}`);
    expect(authenticated).not.toBeNull();

    // The server holds this reference for the whole request. It carries two
    // identifiers and no authority, so every call has to read the row again.
    const withPrincipal = mcpPrincipalLoader({
      userId: authenticated!.userId,
      credentialId: authenticated!.keyId,
    });

    const first = await withPrincipal(
      ({ ctx, principal }) => listSpaces(ctx, { principal }),
      { readOnly: true },
    );
    expect(first.map((space) => space.spaceId)).toEqual([account.spaceId]);

    await pool.query("DELETE FROM kith.api_keys WHERE id = $1", [
      account.keyId,
    ]);

    await expect(
      withPrincipal(({ ctx, principal }) => listSpaces(ctx, { principal }), {
        readOnly: true,
      }),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  test("the loader's read transaction refuses a write", async () => {
    onPostgres();
    const account = await owner();
    const withPrincipal = mcpPrincipalLoader({
      userId: account.userId,
      credentialId: account.keyId,
    });

    // Section 4.2: a read tool runs under `REPEATABLE READ READ ONLY`, so a tool
    // that writes cannot do it through the read path by accident.
    await expect(
      withPrincipal(
        async ({ ctx }) => {
          await ctx.client.query(
            "UPDATE kith.api_keys SET name = 'changed' WHERE id = $1",
            [account.keyId],
          );
        },
        { readOnly: true },
      ),
    ).rejects.toThrow();
  });
});
