import type {
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";

/**
 * P2-31f. The one place that decides whether an admission receipt the
 * authoritative server does not hold may be retired, shared by the pass that
 * does it for itself and by the `reconcile-receipts` command an operator runs.
 *
 * P2-31d put the row conditions in the command and P2-31f copied them into the
 * runner. Copies drift, and the copy was already wrong in the same way in both
 * places: it looked at the checkpoint's own processing row and no other, so a
 * sibling row of the same original could be live server side while its receipt
 * was retired underneath it. One module, one answer.
 *
 * The limits that only apply to the automatic route are the circuit breaker.
 * An operator asking for a clear has read the dry-run counts and decided; a
 * pass has not, and the failure this whole task exists for -- a backend that
 * answers "never heard of it" for everything -- looks from one row exactly
 * like the one real misrouting this repairs. A pass may therefore clear one
 * receipt, once, and only while the server can still prove it knows a receipt
 * this worker knows is good.
 */
export type ReceiptClearRefusal =
  /** A generation is live server side under this admission. */
  | "processing_already_activated"
  /** Another processing row of the same original is activated. */
  | "sibling_processing_activated"
  /** A processing receipt names a different revision than the original. */
  | "processing_receipt_conflict"
  /** Automatic only: this row has been cleared before. */
  | "already_reconciled"
  /** Automatic only: another row was cleared within the last day. */
  | "daily_clear_limit"
  /** Automatic only: no receipt this worker knows is good can be asked about. */
  | "positive_control_unavailable"
  /** Automatic only: the server does not know a receipt that should be good. */
  | "positive_control_failed"
  /** Operator only: `--max-clears` is spent for this pass. */
  | "operator_clear_limit";

/**
 * P2-31f, second review. There is no read this worker can make, mid pass, that
 * proves the server it is talking to still holds this account's earlier
 * receipts. Three were traced and none works:
 *
 *   * `discovery.lookupArchivedAdmission` about a published sibling. The
 *     server resolves it through the sibling's live discovery work row, and an
 *     already-published file gets no new row in a later scan: the old one is
 *     obsoleted and still names the old scan, so the lookup is refused
 *     `stale_observation`. Proved against the real handler in
 *     `packages/kith-store/test/workerFoundation.test.mjs`.
 *   * `source.status` counts. `snapshotCurrent` requires the assessment's
 *     inventory epoch to equal the account's, and `scan.begin` bumps the
 *     account's, so from the first step of the pass the counts read
 *     `not_assessed`. They are absent exactly when this would need them.
 *   * `source.inventoryPage`. It is refused unless the scan is an open
 *     identity-recovery scan, it consumes the mutation rate limit, and it
 *     advances the scan's own inventory cursor. Not a probe.
 *
 * So the automatic route does not guess. It clears only when there is no other
 * receipt in the catalog for a mass void to be hiding, and everything else is
 * parked for the operator route, which is a person deciding with the dry run
 * in front of them. A control that cannot run is not a control that passed.
 */
export const POSITIVE_CONTROL_UNAVAILABLE_BY_DESIGN = true;

/** One automatic clear per source per day. */
export const AUTOMATIC_CLEAR_INTERVAL_MS = 24 * 60 * 60_000;

/** The positive control's answer; see `automaticReceiptClearRefusal`. */
export type PositiveControl = "ok" | "unavailable" | "failed";

export type ReceiptClearInput = {
  original: OriginalCatalogRow;
  processing: ProcessingCatalogRow;
  /** Every processing row in the catalog, for the sibling check. */
  processings: readonly ProcessingCatalogRow[];
  /** Every original row in the catalog, for the daily limit. */
  originals: readonly OriginalCatalogRow[];
  now: number;
  /**
   * Runs the control. Only called on the automatic route, only when every
   * other condition already holds, and it must never throw: a read-only probe
   * that cannot be made is `"unavailable"`, which refuses.
   */
  positiveControl?: () => Promise<PositiveControl>;
};

/**
 * P2-31f. The deliberate operator route, `run --retry-parked --operator-clear`.
 *
 * It keeps the conditions about this document, because those describe state
 * that no route can repair, and drops the three that exist only because a pass
 * decides alone: a person ran this after reading the dry run's parked count,
 * which is the judgement the automatic limits stand in for. Without it a
 * document parked on `already_reconciled` had no route at all: the pass walks
 * past it, so `reconcile-receipts` cannot address it, and `--retry-parked`
 * just re-ran the same limits and parked it again.
 */
export function operatorReceiptClearRefusal(
  input: Pick<ReceiptClearInput, "original" | "processing" | "processings">,
): ReceiptClearRefusal | undefined {
  return receiptClearRowRefusal(input);
}

/**
 * The conditions on the row itself. Both routes apply these, and neither may
 * clear a receipt when one of them refuses.
 */
export function receiptClearRowRefusal(
  input: Pick<ReceiptClearInput, "original" | "processing" | "processings">,
): ReceiptClearRefusal | undefined {
  // An activated row means a generation is live server side under this
  // admission. Retiring its receipt would leave that generation with no local
  // record of the admission it came from, which no route can repair.
  if (input.processing.activation) return "processing_already_activated";
  if (
    input.processings.some(
      (row) =>
        row.originalCatalogId === input.original.originalCatalogId &&
        row.processingCatalogId !== input.processing.processingCatalogId &&
        row.activation !== undefined,
    )
  )
    return "sibling_processing_activated";
  // One `discovery.admitArchived` commits both legs, so a processing receipt
  // naming the same revision is void with the original's. One naming a
  // different revision is a shape this pipeline does not produce, and guessing
  // at it would retire a receipt that may be real.
  if (
    input.original.cloud &&
    input.processing.cloud &&
    input.processing.cloud.sourceRevisionId !==
      input.original.cloud.sourceRevisionId
  )
    return "processing_receipt_conflict";
  return undefined;
}

/**
 * The full decision for the automatic route: the row conditions above, then
 * the three circuit breakers, in the order that asks the server last.
 */
export async function automaticReceiptClearRefusal(
  input: ReceiptClearInput,
): Promise<ReceiptClearRefusal | undefined> {
  const row = receiptClearRowRefusal(input);
  if (row) return row;
  // (a) At most one automatic clear per row, ever. A row whose receipt was
  // retired once and is back is not a misrouting this may repair again.
  if ((input.original.receiptReconcile?.length ?? 0) > 0)
    return "already_reconciled";
  // (b) At most one automatic clear per source per day. A backend that has
  // lost everything answers not found for every original in flight; this is
  // what stops a pass from retiring all of them in one run.
  const lastClearedAt = input.originals.reduce(
    (latest, original) =>
      Math.max(
        latest,
        ...(original.receiptReconcile ?? []).map((note) => note.clearedAt),
      ),
    Number.NEGATIVE_INFINITY,
  );
  if (input.now - lastClearedAt < AUTOMATIC_CLEAR_INTERVAL_MS)
    return "daily_clear_limit";
  // (c) The server must still know a receipt this worker knows is good. The
  // caller supplies the probe; a caller that cannot make one refuses.
  const control = input.positiveControl
    ? await input.positiveControl()
    : "unavailable";
  if (control === "failed") return "positive_control_failed";
  if (control === "unavailable") return "positive_control_unavailable";
  return undefined;
}

/**
 * Whether the control is required at all. With no other receipt in the catalog
 * there is nothing to prove the backend with, and nothing a mass void could be
 * hiding either: this receipt is the only one there is.
 */
export function positiveControlRequired(
  originals: readonly OriginalCatalogRow[],
  originalCatalogId: string,
): boolean {
  return originals.some(
    (row) => row.originalCatalogId !== originalCatalogId && row.cloud,
  );
}
