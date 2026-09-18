// P2-31a: the operator route for discovery work that has spent every attempt.
//
// `reserveArchivedDiscovery` and `reserveDiscoveryWork` both refuse a row whose
// `attempts` has reached `MAX_WORKER_DISCOVERY_ATTEMPTS`, and nothing in the
// protocol lowers that counter: `failArchivedDiscovery` only ever raises it, and
// a settled failure is deliberately reported to the scan as `unchanged` rather
// than as identity review (see `entries.ts`). That is correct for a document
// that genuinely cannot be processed, and wrong for one whose attempts were
// spent on a client defect that has since been fixed, which is what P2-31a's
// stale provider proof did: every wedged pass renewed the expired lease, spent
// an attempt, and failed on the same unfixable declaration.
//
// This is the port of Convex's `requeueFailedDiscoveryWork` (PR210), reduced to
// the part that is actually needed here. It resets the counter and puts the row
// back in the state the reserve path claims from. It does not touch
// `source_items`, scans, scan entries, the inventory, or any archive receipt: a
// re-attempt has to re-derive all of that anyway, and the row's own history is
// what an operator reads afterwards to see that this happened.
//
// Deliberately not lowered or rewritten: `lease_epoch`. It is the protocol's
// fence against a worker that still believes it holds a lease, so it only ever
// rises, and the reserve that follows this reset raises it by one as usual.
//
// No transaction control here, per `db.ts`: the caller opens one transaction
// per call. `cli.ts` beside this file is that caller.

import type { ClientBase, QueryResultRow } from "pg";

import { MAX_WORKER_DISCOVERY_ATTEMPTS } from "./discovery.js";

export const RESET_DEFAULT_LIMIT = 50;
export const RESET_MAX_LIMIT = 500;

/**
 * The only two states a reset moves out of, both of which mean the row ran out
 * of attempts without anything having judged the document itself: `leased` when
 * a pass died holding the lease, and `queued` when the last lease expired
 * without a recorded failure. That is the shape a client defect leaves behind,
 * and it is the whole of what this command is for.
 *
 * The other four are deliberately out of reach.
 *
 * `admitted` is the successful terminal state and `obsolete` is superseded
 * history that the current-work unique index excludes; requeueing either would
 * invent work the protocol already settled.
 *
 * `failed` at the cap is a settled parse failure: something read the document
 * and could not process it, and `failArchivedDiscovery` spent the attempts
 * saying so. Resetting it would buy eight more paid parse attempts against a
 * document that has already refused eight. `needs_review` is a row the generic
 * reserve path parked (`discovery.ts`) and requeueing it would step around the
 * review rather than answer it. Neither is safe to sweep from a command whose
 * dry run reports counts only, because an operator cannot see from a count
 * which rows they would be agreeing to retry. A future operator flow for those
 * two wants to name the row and show what it is holding, not batch them in
 * here.
 */
const RESETTABLE_STATES = ["queued", "leased"];

export type DiscoveryWorkResetResult = {
  spaceId: string;
  eligible: number;
  reset: number;
};

/**
 * Makes exhausted discovery work reservable again for one space.
 *
 * A row is eligible when it has reached the attempt cap, is `queued` or
 * `leased` (see `RESETTABLE_STATES`), and holds no live lease. The live-lease
 * refusal is the important one: a worker that still owns an unexpired lease may
 * be mid operation, and clearing its lease underneath it would let a second
 * worker claim the same item. An expired lease is already claimable by the
 * protocol's own rules, so taking it here changes nothing a reserve would not.
 *
 * Idempotent: a reset row is below the cap, so a second call finds nothing.
 * `apply` false counts without writing.
 */
export async function resetExhaustedDiscoveryWork(
  client: ClientBase,
  args: {
    spaceId: string;
    apply: boolean;
    now: number;
    limit?: number;
  },
): Promise<DiscoveryWorkResetResult> {
  const limit = args.limit ?? RESET_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > RESET_MAX_LIMIT)
    throw new Error("Invalid discovery work reset page bounds");
  if (!Number.isSafeInteger(args.now) || args.now < 0)
    throw new Error("Invalid discovery work reset clock");
  const eligible = await client.query<QueryResultRow>(
    `SELECT id FROM kith.worker_discovery_work
      WHERE space_id = $1
        AND attempts >= $2
        AND state = ANY($3)
        AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
      ORDER BY created_at, id
      LIMIT $5
      FOR UPDATE`,
    [
      args.spaceId,
      MAX_WORKER_DISCOVERY_ATTEMPTS,
      RESETTABLE_STATES,
      new Date(args.now),
      limit,
    ],
  );
  const ids = eligible.rows.map((row) => String(row.id));
  if (!args.apply || ids.length === 0)
    return { spaceId: args.spaceId, eligible: ids.length, reset: 0 };
  // `queued` with no lease and no backoff is the shape both reserve paths claim
  // from. The failure fields go with the attempts they described; leaving a
  // `failure_code` behind on a row that is queued again would report a failure
  // this row is no longer in.
  const updated = await client.query(
    `UPDATE kith.worker_discovery_work
        SET state = 'queued', attempts = 0, lease_token = NULL,
            lease_owner_credential_id = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, failure_code = NULL, retryable = NULL
      WHERE id = ANY($1)`,
    [ids],
  );
  return {
    spaceId: args.spaceId,
    eligible: ids.length,
    reset: updated.rowCount ?? 0,
  };
}

/** Spaces holding at least one row at the attempt cap. Ids only. */
export async function spacesWithExhaustedDiscoveryWork(
  client: ClientBase,
): Promise<string[]> {
  const rows = await client.query<QueryResultRow>(
    `SELECT DISTINCT space_id FROM kith.worker_discovery_work
      WHERE attempts >= $1 AND state = ANY($2)
      ORDER BY space_id`,
    [MAX_WORKER_DISCOVERY_ATTEMPTS, RESETTABLE_STATES],
  );
  return rows.rows.map((row) => String(row.space_id));
}
