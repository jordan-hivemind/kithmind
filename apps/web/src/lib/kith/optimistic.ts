// The pure half of the app pages' optimistic mutations: the JSON request every
// `/api/kith/*` mutation makes, and the three TanStack Query callbacks that
// apply a change to the cache at once, roll it back on failure and resync
// afterwards.
//
// No React here, so the rollback rule is testable in node against a real
// `QueryClient` (this app has no DOM test environment). The hook that wires
// these into `useMutation` is `use-server-data.ts`.

import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type JsonResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string };

/**
 * One `/api/kith/*` request. Every such route requires
 * `Content-Type: application/json` (`guardedRequest`), and answers a failure
 * with `{ error: string }`, which becomes `message`.
 */
export async function requestJson(
  input: string,
  init: RequestInit,
  fallback = "Request failed.",
): Promise<JsonResult> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (response.status === 204) return { ok: true, body: undefined };
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) return { ok: true, body };
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  return { ok: false, message: typeof error === "string" ? error : fallback };
}

/** `requestJson`, throwing on failure, for a `mutationFn`. */
export async function mutateJson(
  input: string,
  init: RequestInit,
  fallback?: string,
): Promise<unknown> {
  const result = await requestJson(input, init, fallback);
  if (!result.ok) throw new Error(result.message);
  return result.body;
}

type Snapshot<T> = { previous: T | undefined };

/**
 * `onMutate`, `onError` and `onSettled` for a mutation whose effect on the
 * cached value `apply` can predict.
 *
 * `onMutate` cancels any refetch in flight (it would overwrite the optimistic
 * value with a pre-mutation read), keeps the current value and writes the
 * predicted one. `onError` puts the kept value back and reports the message.
 * `onSettled` resyncs from the server either way, because the prediction is a
 * guess and the server's answer is the truth.
 */
export function optimisticHandlers<T, V>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  apply: (current: T, variables: V) => T,
  hooks: { onFailure: (message: string) => void; resync: () => void },
) {
  return {
    onMutate: async (variables: V): Promise<Snapshot<T>> => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<T>(queryKey);
      if (previous !== undefined) {
        queryClient.setQueryData<T>(queryKey, apply(previous, variables));
      }
      return { previous };
    },
    onError: (error: unknown, _variables: V, snapshot: Snapshot<T> | undefined) => {
      if (snapshot?.previous !== undefined) {
        queryClient.setQueryData<T>(queryKey, snapshot.previous);
      }
      hooks.onFailure(error instanceof Error ? error.message : "Request failed.");
    },
    onSettled: () => {
      hooks.resync();
    },
  };
}

/** A temporary id for a row created optimistically, before the server's. */
export function pendingId(): string {
  return `pending:${Math.random().toString(36).slice(2)}`;
}

export function isPendingId(id: string): boolean {
  return id.startsWith("pending:");
}
