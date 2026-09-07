import type {
  CheckpointTransition,
  JournalOperation,
  JsonValue,
  PendingRequest,
  PlanRequest,
} from "./journalTypes.js";
import { Journal, JournalSafetyError } from "./journal.js";

export type ReplayContext<C extends JsonValue, R extends JsonValue> = {
  checkpoint: C;
  pending: PendingRequest<R>;
  result: R;
};

export type ReplayHandlers<C extends JsonValue, R extends JsonValue> = {
  sendExact(requestBody: string, operation: JournalOperation): Promise<unknown>;
  nextCheckpoint(
    context: ReplayContext<C, R>,
  ): CheckpointTransition<C> | Promise<CheckpointTransition<C>>;
  now(): number;
};

/** Resume the journal's sole unresolved operation. */
export async function resumePendingCall<
  C extends JsonValue,
  R extends JsonValue,
>(journal: Journal<C, R>, handlers: ReplayHandlers<C, R>): Promise<R> {
  let pending = journal.pending;
  if (!pending) throw new JournalSafetyError("there is no request to resume");
  let result = pending.result?.value;
  if (result === undefined) {
    const raw = await handlers.sendExact(
      pending.requestBody,
      pending.operation,
    );
    result = await journal.recordValidatedResult(raw, handlers.now());
    pending = journal.pending!;
  }
  const transition = await handlers.nextCheckpoint({
    checkpoint: journal.checkpoint,
    pending,
    result,
  });
  await journal.commitResult(transition);
  return result;
}

/** Plan a new exact request and drive it through the same restart path. */
export async function runJournaledCall<
  C extends JsonValue,
  R extends JsonValue,
>(
  journal: Journal<C, R>,
  request: PlanRequest,
  handlers: ReplayHandlers<C, R>,
): Promise<R> {
  if (journal.pending) {
    throw new JournalSafetyError("an older request must be resumed first");
  }
  await journal.planRequest(request);
  return await resumePendingCall(journal, handlers);
}
