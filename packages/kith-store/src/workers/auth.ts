// The worker credential's authorization, once per operation.
//
// Ported from `models/workers/auth.ts` plus `lib/sourceAuth.ts`. Both are short
// and both are load bearing, so the port keeps every step including the ones that
// look redundant:
//
//   * A worker request must carry a credential. A web session reaching this
//     surface is `not_authenticated`, not "the user's own authority": the worker
//     protocol is a machine contract and its grants are per credential.
//   * The credential is reloaded from the database, so a key revoked between two
//     operations in one pass loses access on the next one. `reloadPrincipal` in
//     `../identity` is that reload, unchanged.
//   * Space access is required on top, for `ingest`. "Source ingest grants are
//     additional to current space access, never a substitute."
//   * The source account grant is required too. A key with `ingest` capability
//     but no grant for *this* source account gets nothing.
//   * The account must be the `fs` connector and enabled.
//
// Every one of those failures is one of three codes and no more information:
// `not_authorized` when the credential or grant is wrong, `not_found` when the
// row is in another space, `source_unavailable` when the connector is wrong or
// disabled. A worker learns whether it may act, never what exists.
//
// Space isolation is then carried by `source.spaceId` for the rest of the
// operation. Every statement in this directory filters on it by equality against
// the authorized account's space, which is section 2.5's "one helper resolves the
// authorized space set once per request" for the single-space case; the schema's
// composite `UNIQUE (id, space_id)` and composite foreign keys are the half that
// makes a cross-space reference unrepresentable rather than merely unqueried.

import { assertKithId, KITH_ID } from "../ids.js";
import { identityCtx } from "../identity/db.js";
import {
  reloadPrincipal,
  requireSpaceAccess,
  type PrincipalRef,
} from "../identity/authorization.js";
import { row, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { camelizeSourceAccount, type SourceAccountRow } from "./rows.js";

export type WorkerPrincipal = {
  userId: string;
  credentialId: string;
};

export type LoadedWorkerSource = {
  principal: WorkerPrincipal;
  spaceId: string;
  account: SourceAccountRow;
};

/** A worker principal, or `not_authenticated`. A credential is mandatory. */
export function requireWorkerPrincipal(
  principal: PrincipalRef,
): WorkerPrincipal {
  if (!principal.credentialId) workerProtocolError("not_authenticated");
  if (!KITH_ID.test(principal.userId) || !KITH_ID.test(principal.credentialId)) {
    workerProtocolError("not_authenticated");
  }
  return {
    userId: principal.userId,
    credentialId: principal.credentialId,
  };
}

/** One source account row by id, with no authorization applied. */
export async function loadSourceAccount(
  ctx: WorkerCtx,
  sourceAccountId: string,
): Promise<SourceAccountRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_accounts WHERE id = $1",
    [assertKithId(sourceAccountId, "invalid_source_account_id")],
  );
  return found ? camelizeSourceAccount(found) : null;
}

/**
 * The port of `requireSourceAccountAccess` for a worker credential, throwing the
 * protocol's codes rather than the ingestion surface's prose.
 *
 * The ordering is the original's and it matters: the credential's grant is
 * checked against the *reloaded* principal, and the space check happens before
 * the grant check, so a credential that lost its space membership is refused
 * before anything reveals whether the grant is still listed.
 */
export async function requireWorkerSourceAccountAccess(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  sourceAccountId: string,
): Promise<{ principal: WorkerPrincipal; account: SourceAccountRow }> {
  const workerPrincipal = requireWorkerPrincipal(principal);
  const identity = identityCtx(ctx.client, ctx.now);
  let reloaded;
  try {
    reloaded = await reloadPrincipal(identity, workerPrincipal);
  } catch {
    workerProtocolError("not_authenticated");
  }
  const account = await loadSourceAccount(ctx, sourceAccountId);
  if (!account) workerProtocolError("not_authorized");
  try {
    await requireSpaceAccess(identity, reloaded, account.spaceId, "ingest");
  } catch {
    workerProtocolError("not_authorized");
  }
  if (
    account.enabled !== true ||
    reloaded.credentialSourceAccountIds === undefined ||
    !reloaded.credentialSourceAccountIds.includes(account.id)
  ) {
    workerProtocolError("not_authorized");
  }
  return { principal: workerPrincipal, account };
}

/**
 * The whole per-operation authorization, including the two checks that are the
 * worker protocol's own rather than the ingestion surface's: the request's
 * `spaceId` must be the account's, and the connector must be `fs`.
 *
 * The space mismatch is `not_found` and not `not_authorized`, which looks
 * backwards until you read it as the original does: by this point the credential
 * *is* authorized for the account, so the only thing wrong is that the request
 * named a space the account is not in, and the account is then simply not there
 * to be found under that space.
 */
export async function requireWorkerSourceAccount(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: { spaceId: string; sourceAccountId: string },
): Promise<LoadedWorkerSource> {
  if (!KITH_ID.test(request.spaceId) || !KITH_ID.test(request.sourceAccountId)) {
    workerProtocolError("invalid_request");
  }
  const { principal: workerPrincipal, account } =
    await requireWorkerSourceAccountAccess(
      ctx,
      principal,
      request.sourceAccountId,
    );
  if (account.spaceId !== request.spaceId) workerProtocolError("not_found");
  if (account.connector !== "fs") workerProtocolError("source_unavailable");
  return { principal: workerPrincipal, spaceId: account.spaceId, account };
}

/**
 * Whether the credential that created a row could still act on this source.
 *
 * Ported from `requireOriginalActor` in `discovery.ts`. A scan or a work row
 * records who created it, and a later operation on that row re-checks *that*
 * actor rather than only the caller: work created by a credential whose grant has
 * since been revoked must not continue to be processed just because some other
 * credential is authorized now.
 */
export async function requireOriginalActor(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  actor: { actorUserId: string; actorCredentialId: string },
): Promise<void> {
  try {
    const { account } = await requireWorkerSourceAccountAccess(
      ctx,
      { userId: actor.actorUserId, credentialId: actor.actorCredentialId },
      source.account.id,
    );
    if (account.spaceId !== source.spaceId || account.connector !== "fs") {
      workerProtocolError("not_authorized");
    }
  } catch {
    workerProtocolError("not_authorized");
  }
}

/**
 * Refuses a row whose recorded actor is not the caller.
 *
 * `not_found` again: a scan created by another credential is not a scan this one
 * may learn about.
 */
export function ensureSameActor(
  principal: WorkerPrincipal,
  record: { actorUserId: string; actorCredentialId: string },
): void {
  if (
    record.actorUserId !== principal.userId ||
    record.actorCredentialId !== principal.credentialId
  ) {
    workerProtocolError("not_found");
  }
}
