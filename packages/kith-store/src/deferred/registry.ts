// The handler registry `drain` runs a claimed job's `kind` through.
//
// This is the seam the plan's daemon design names: "the registry is how g2's
// embedding fill and the card queue hook in later". A handler is registered
// once, by whichever row ports the domain it belongs to, and `drain` never
// needs to know what a handler does -- only whether one is registered for the
// kind it just claimed.
//
// A handler is registered in one of two scopes, and the difference is not
// stylistic.
//
// | Scope         | `drain` gives it              | For                                            |
// | ------------- | ----------------------------- | ---------------------------------------------- |
// | transaction   | a `DeferredCtx` in one open `SERIALIZABLE` transaction | work that is entirely database work |
// | pool          | the `Pool`, nothing open      | work that makes an outbound call mid-job       |
//
// The pooled scope exists because `withKithTransaction` sets
// `idle_in_transaction_session_timeout` to `KITH_IDLE_TRANSACTION_TIMEOUT_MS`
// (five seconds) and an embedding provider request is bounded at fifteen. A
// handler that called a provider inside the transaction `drain` used to open
// unconditionally would not merely hold a `pg` connection across an HTTP call,
// which section 4.4 of the web and MCP surface plan forbids; it would be
// terminated by the server partway through. So such a handler asks for the
// pool and opens its own short transactions around the call instead.

import type { Pool } from "pg";

import { runInvestmentLinkJob } from "../admin/investmentLinkWork.js";
import { runEmbeddingFillJob } from "../embeddings/fillWork.js";
import type { FillEmbedder } from "../embeddings/fill.js";
import {
  providerBatchEmbedder,
  type EmbeddingEnvironment,
  type EmbeddingFetch,
} from "../embeddings/provider.js";
import { runDocumentExtractionJob } from "../extraction/model.js";
import {
  providerExtractionModel,
  type ExtractionModel,
} from "../extraction/provider.js";
import { inlineIngestionHandler } from "../ingestion/inlineWork.js";
import type { DeferredCtx, DeferredWorkKind, DeferredWorkRow } from "./core.js";

export type DeferredWorkHandler = (
  ctx: DeferredCtx,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
) => Promise<void>;

/**
 * A handler that must not run inside a transaction. `drain` calls `run` with
 * the pool and opens nothing of its own; the handler is responsible for every
 * transaction its work needs, and for keeping each of them short.
 */
export type PooledDeferredWorkHandler = {
  readonly scope: "pool";
  readonly run: (
    pool: Pool,
    payload: Record<string, unknown>,
    job: DeferredWorkRow,
  ) => Promise<void>;
};

export type DeferredWorkEntry = DeferredWorkHandler | PooledDeferredWorkHandler;

export type DeferredWorkRegistry = Map<DeferredWorkKind, DeferredWorkEntry>;

/** Which of the two scopes an entry was registered in. A plain function is
 * the transaction-scoped form every handler before P2-39j2 used, so an
 * existing caller that registers one keeps working unchanged. */
export function isPooledHandler(
  entry: DeferredWorkEntry,
): entry is PooledDeferredWorkHandler {
  return typeof entry !== "function";
}

/** An empty registry, for a caller that wants to register its own handlers
 * from scratch rather than start from this package's defaults. */
export function createRegistry(): DeferredWorkRegistry {
  return new Map();
}

export type DefaultRegistryOptions = {
  /**
   * The batch embedder `embedding_fill` runs with. A test injects a recording
   * one, so no test in this package ever calls a provider. Omitted, the
   * provider-backed embedder below is built instead.
   */
  embedder?: FillEmbedder;
  /**
   * The environment the default embedder reads its provider configuration
   * from. `cli.ts` passes `process.env`; omitted, no provider is configured
   * and an `embedding_fill` job fails through `fail`'s ordinary backoff rather
   * than the daemon refusing to start.
   */
  env?: EmbeddingEnvironment;
  /** The default embedder's `fetch`, for a test that wants to prove what the
   * daemon does with a provider failure without making one. */
  fetchImpl?: EmbeddingFetch;
  /**
   * The model `document_extraction` reads documents with. Injected the same
   * way and for the same reason as `embedder`: no test in this package makes a
   * real completion. Omitted, the provider-backed one is built from `env`.
   */
  extractionModel?: ExtractionModel;
};

/**
 * This package's own handlers: what `kith-deferred-work` drains with, and what
 * a test drains with unless it is asserting the unregistered-kind path.
 *
 * `inline_ingestion` is registered by P2-39e2, the row that ported admission
 * and processing. `recoverInlineIngestion` (`sweeps.ts`) has been enqueuing
 * this kind since P2-39j with nothing to run it; the handler and that sweep
 * agree on one payload shape, `{ workId }`, keyed by the inline work row's id.
 *
 * `embedding_fill` is registered by P2-39j2, which is the third leg row m
 * requires before the flag flips: the capture gate's retry guard and its
 * keyword fallback are the other two. Its scheduler is the write side
 * (`scheduleEmbeddingFill`, called from `memory/thoughts.ts` in the capture's
 * own transaction) and its payload is `{ spaceId }`, keyed per space. It is
 * pooled, not transaction scoped, for the reason in the module comment above.
 *
 * `card_queue_tick` is still unregistered: its target does not exist on
 * PostgreSQL. `models/records/cardQueue.ts` and `cardQueueTables.ts` (the
 * extraction queue states, cursors, budgets and the card ladder the tick
 * drives) were not ported by P2-39f, so there is nothing here for a handler to
 * run; migration 017 allows the kind so that the row which ports the card
 * queue can register one without a migration, and until then `drain` fails
 * such a job without consuming an attempt rather than retrying a kind nobody
 * serves. Nothing in this package schedules it, so no such row exists today.
 */
export function defaultRegistry(
  options: DefaultRegistryOptions = {},
): DeferredWorkRegistry {
  const registry = createRegistry();
  registry.set("inline_ingestion", inlineIngestionHandler);
  const embed =
    options.embedder ??
    providerBatchEmbedder(options.env ?? {}, options.fetchImpl);
  registry.set("embedding_fill", {
    scope: "pool",
    run: (pool, payload, job) => runEmbeddingFillJob(pool, payload, job, embed),
  });
  // `document_extraction` is registered by ADM-5a. Its scheduler is the three
  // activation points (`scheduleDocumentExtraction`, called beside
  // `scheduleEmbeddingFill` in the publication's own transaction) and its
  // payload is `{ spaceId, sourceItemId, processingGenerationId }`, keyed per
  // source item. Pooled for the same reason `embedding_fill` is: one model
  // call sits between its two transactions and no `pg` connection may be held
  // across it.
  const extract =
    options.extractionModel ??
    providerExtractionModel(options.env ?? {}, options.fetchImpl);
  registry.set("document_extraction", {
    scope: "pool",
    run: (pool, payload, job) =>
      runDocumentExtractionJob(pool, payload, job, extract).then(() => undefined),
  });
  // `investment_link` is registered by ADM-8c. Its schedulers are the three
  // triggers in `../admin/investmentLinkWork.ts` -- a stored extraction, an
  // edited entry or investment, and a rejected link -- each calling
  // `schedule` in the transaction of the write that caused it, and its
  // payload is `{ spaceId, sourceItemId }`, keyed per source item.
  //
  // Transaction scoped, not pooled: every statement it runs is database work
  // in one space, it makes no outbound call, and slice 2 uses no model. So it
  // takes the `DeferredCtx` `drain` opens and needs none of the pooled
  // scope's machinery.
  registry.set("investment_link", runInvestmentLinkJob);
  // `card_queue_tick` waits on a PostgreSQL port of `cardQueue.ts`: the
  // extraction queue state, cursor and budget tables of `cardQueueTables.ts`,
  // which `packages/kith-store/src/records/` does not have.
  return registry;
}
