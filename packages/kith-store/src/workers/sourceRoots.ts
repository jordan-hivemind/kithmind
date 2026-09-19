// ADM-4b: the two worker operations the watched-folder list needs, now that
// the list lives in the database rather than in a JSON file on the watcher
// host.
//
//   * `source.roots` -- the watcher asks which subtrees under its source
//     account it should watch.
//   * `source.rootReport` -- the watcher says what it found at one of them.
//
// Both are authorized exactly as every other operation in this directory is:
// `requireWorkerSourceAccount` (auth.ts) reloads the credential, requires
// `ingest` on the account's space, requires the credential's own grant for
// *this* source account, requires the request's `spaceId` to be the account's,
// and requires the `fs` connector. Nothing below re-derives any of that.
//
// What is this file's own is the second half of the scoping: every statement
// here filters on `space_id` *and* `source_account_id` by equality against the
// authorized account, so a root is unreachable from a credential for another
// account even within the same space, and unreachable from another space at
// all. The root id in a `source.rootReport` request is therefore never
// trusted as a capability -- it selects among the caller's own roots or it
// selects nothing.

import {
  MAX_WORKER_SOURCE_ROOTS,
  type WorkerRequest,
  type WorkerSourceRoot,
  type WorkerSourceRootReportResult,
  type WorkerSourceRootsResult,
} from "@repo/worker-protocol/request";

import { newKithId } from "../ids.js";
import type { PrincipalRef } from "../identity/authorization.js";
import { requireWorkerSourceAccount } from "./auth.js";
import { at, exec, row, rows, type WorkerCtx } from "./db.js";
import { workerProtocolError } from "./errors.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";

type SourceRootDbRow = {
  id: string;
  kind: string;
  state: string;
  root_alias: string | null;
  relative_path: string | null;
  provider_folder_id: string | null;
  area: string | null;
  expected_types: unknown;
};

function toWorkerRoot(record: SourceRootDbRow): WorkerSourceRoot {
  return {
    sourceRootId: record.id,
    kind: record.kind as WorkerSourceRoot["kind"],
    // The wire has two states because a watcher has two behaviours. A root the
    // owner paused is reported as paused; `problem` is a conclusion the
    // watcher's own reports produced and is not an instruction to stop
    // looking, so it arrives as `active`.
    state: record.state === "paused" ? "paused" : "active",
    ...(record.root_alias === null ? {} : { rootAlias: record.root_alias }),
    ...(record.relative_path === null
      ? {}
      : { relativePath: record.relative_path }),
    ...(record.provider_folder_id === null
      ? {}
      : { providerFolderId: record.provider_folder_id }),
    ...(record.area === null ? {} : { area: record.area }),
    expectedTypes: Array.isArray(record.expected_types)
      ? (record.expected_types as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}

/**
 * The desired list for one source account: every root but the retired ones.
 *
 * A read, so no rate limit and no write: the watcher pulls this each pass the
 * way it pulls `source.status`.
 */
export async function getWorkerSourceRoots(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.roots" }>,
): Promise<WorkerSourceRootsResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const records = await rows<SourceRootDbRow>(
    ctx,
    `SELECT id, kind, state, root_alias, relative_path, provider_folder_id,
            area, expected_types
       FROM kith.source_roots
      WHERE source_account_id = $1 AND space_id = $2 AND state <> 'retired'
      ORDER BY created_at, id
      LIMIT $3`,
    [source.account.id, source.spaceId, MAX_WORKER_SOURCE_ROOTS],
  );
  return {
    operation: "source.roots",
    sourceAccountId: source.account.id,
    roots: records.map(toWorkerRoot),
  };
}

/**
 * One pass's report about one root.
 *
 * Keyed on `(source_root_id, observed_at)` the way
 * `admin.upsertSourceRootReport` is, so a retried request for the same pass
 * replaces its row rather than adding a second one the "latest report" read
 * would have to choose between.
 *
 * The provider folder id is written back onto the root when the worker has
 * resolved one (section 6 of the plan: the id is the identity and the path is
 * the cache). Nothing else about the root is writable here: a watcher reports
 * what it saw and never edits what it was told to watch.
 */
export async function recordWorkerSourceRootReport(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "source.rootReport" }>,
): Promise<WorkerSourceRootReportResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const root = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_roots
      WHERE id = $1 AND source_account_id = $2 AND space_id = $3
      FOR UPDATE`,
    [request.sourceRootId, source.account.id, source.spaceId],
  );
  // Another account's root, another space's root, and a root that does not
  // exist are one answer. A worker learns whether it may act, never what
  // exists.
  if (!root) workerProtocolError("not_found");

  const existing = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_root_reports
      WHERE source_root_id = $1 AND space_id = $2 AND observed_at = $3`,
    [root.id, source.spaceId, at(request.observedAt)],
  );
  const reportId = existing?.id ?? newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_root_reports
       (id, space_id, source_root_id, observed_at, item_count, state)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       item_count = EXCLUDED.item_count,
       state = EXCLUDED.state,
       observed_at = EXCLUDED.observed_at`,
    [
      reportId,
      source.spaceId,
      root.id,
      at(request.observedAt),
      request.itemCount,
      request.state,
    ],
  );
  if (request.providerFolderId !== undefined) {
    await exec(
      ctx,
      `UPDATE kith.source_roots
          SET provider_folder_id = $1, updated_at = $2
        WHERE id = $3 AND source_account_id = $4 AND space_id = $5`,
      [
        request.providerFolderId,
        at(ctx.now),
        root.id,
        source.account.id,
        source.spaceId,
      ],
    );
  }
  return {
    operation: "source.rootReport",
    sourceRootId: root.id,
    reportId,
    observedAt: request.observedAt,
  };
}
