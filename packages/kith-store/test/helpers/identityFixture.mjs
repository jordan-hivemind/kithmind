// A throwaway database with the whole schema applied, and the synthetic rows the
// identity tests build on.
//
// The migrated schema, not a hand-built subset: these tests are the check that the
// service surface works against the schema the migration actually produces, so
// anything that only works against a convenient fixture is not proven.

import { randomBytes } from "node:crypto";

import pg from "pg";

import { applyKithSchema, newKithId, sha256 } from "../../dist/index.js";
import { identityCtx } from "../../dist/identity/index.js";
import { connect, skip, throwawayDatabase } from "./pgDatabase.mjs";

export { skip };

/** A signing key per run. No test ever needs one that outlives its process. */
export const sessionConfig = {
  secret: randomBytes(32).toString("hex"),
  secure: false,
};

/**
 * A migrated throwaway database, plus a `tx` that runs one piece of work in one
 * transaction and a `ctx` for ad-hoc statements.
 *
 * `now` is injectable per call, which is how the expiry cases are tested without
 * a test that sleeps.
 */
export async function identityDatabase(t) {
  const database = await throwawayDatabase(t);
  const client = await connect(database);
  await applyKithSchema(client);
  await client.query("SET search_path TO kith, public");
  return {
    client,
    databaseUrl: database.url,
    ctx: (now) => identityCtx(client, now),
    /**
     * One unit of work, always rolled back.
     *
     * The suite shares one client and one applied schema, so the isolation each
     * test needs is from the others' rows. Rolling back gives that for free and
     * also undoes the constraint drops a few tests need in order to build a state
     * the schema would otherwise refuse.
     */
    async tx(work, now) {
      await client.query("BEGIN");
      try {
        return await work(identityCtx(client, now));
      } finally {
        await client.query("ROLLBACK");
      }
    },
  };
}

/** A user row. */
export async function makeUser(ctx, fields = {}) {
  const id = newKithId();
  await ctx.client.query(
    "INSERT INTO kith.users (id, email, name) VALUES ($1, $2, $3)",
    [id, fields.email ?? null, fields.name ?? null],
  );
  return id;
}

/** A space and one membership in it. */
export async function makeSpace(ctx, fields) {
  const id = fields.id ?? newKithId();
  await ctx.client.query(
    `INSERT INTO kith.spaces (id, kind, name, created_by) VALUES ($1, $2, $3, $4)`,
    [id, fields.kind ?? "shared", fields.name ?? "Synthetic", fields.createdBy],
  );
  if (fields.role !== null) {
    await makeMember(ctx, {
      spaceId: id,
      userId: fields.memberId ?? fields.createdBy,
      role: fields.role ?? "owner",
    });
  }
  return id;
}

export async function makeMember(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.space_members (id, space_id, user_id, role) VALUES ($1, $2, $3, $4)`,
    [id, fields.spaceId, fields.userId, fields.role],
  );
  return id;
}

export async function makeSettings(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.user_space_settings
       (id, user_id, personal_space_id, default_write_space_id)
       VALUES ($1, $2, $3, $4)`,
    [
      id,
      fields.userId,
      fields.personalSpaceId,
      fields.defaultWriteSpaceId ?? null,
    ],
  );
  return id;
}

/**
 * An API key row with its grants, returning the raw key too.
 *
 * `capabilities: null` builds the legacy unmigrated shape on purpose: that state
 * has its own denial and it has to stay reachable.
 */
export async function makeApiKey(ctx, fields) {
  const rawKey = `ob_${randomBytes(32).toString("hex")}`;
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.api_keys
       (id, user_id, key_hash, key_prefix, name, capabilities, oauth_lifecycle,
        oauth_request_hash, oauth_code_hash, oauth_binding_hash,
        oauth_binding_seed_hash, oauth_encrypted_code, oauth_grant_expires_at,
        oauth_preparation_expires_at, oauth_preparation_nonce)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      fields.userId,
      fields.keyHash ?? sha256(rawKey),
      rawKey.slice(0, 11),
      fields.name ?? "synthetic",
      fields.capabilities === null
        ? null
        : JSON.stringify(fields.capabilities ?? ["read", "write"]),
      fields.oauthLifecycle ?? null,
      fields.oauthRequestHash ?? null,
      fields.oauthCodeHash ?? null,
      fields.oauthBindingHash ?? null,
      fields.oauthBindingSeedHash ?? null,
      fields.oauthEncryptedCode ?? null,
      fields.oauthGrantExpiresAt ? new Date(fields.oauthGrantExpiresAt) : null,
      fields.oauthPreparationExpiresAt
        ? new Date(fields.oauthPreparationExpiresAt)
        : null,
      fields.oauthPreparationNonce ?? null,
    ],
  );
  for (const spaceId of fields.spaceIds ?? []) {
    await ctx.client.query(
      `INSERT INTO kith.api_key_spaces (id, api_key_id, space_id) VALUES ($1, $2, $3)`,
      [newKithId(), id, spaceId],
    );
  }
  for (const sourceAccountId of fields.sourceAccountIds ?? []) {
    await ctx.client.query(
      `INSERT INTO kith.api_key_source_accounts (id, api_key_id, source_account_id)
         VALUES ($1, $2, $3)`,
      [newKithId(), id, sourceAccountId],
    );
  }
  return { id, rawKey };
}

/** A source account, for the ingest-grant cases. P2-39d owns the real writer. */
export async function makeSourceAccount(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', $3)`,
    [id, fields.spaceId, fields.enabled ?? true],
  );
  return id;
}

/** The message a rejected call raised, or null when it resolved. */
export async function refusal(work) {
  try {
    await work();
    return null;
  } catch (error) {
    return error.message;
  }
}

/** The typed `code` a rejected call raised, or null. */
export async function refusalCode(work) {
  try {
    await work();
    return null;
  } catch (error) {
    return error.data?.code ?? null;
  }
}

/** A pool on the same database, for the one test that needs a real transaction. */
export function poolFor(database) {
  return new pg.Pool({ connectionString: database.url, max: 2 });
}
