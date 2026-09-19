"use client";

// How the app pages (dashboard, browse, settings, spaces) keep server-rendered
// data current without a reload.
//
// Each of these pages is loaded by a server component in one read-only
// transaction, and there is no GET route per page to refetch from. So the
// server render stays the source of truth and `router.refresh()` is the
// refetch: it re-runs the page's own loader, under the page's own session
// check, and hands the component new props. No new endpoint, nothing new to
// authorize.
//
// TanStack Query holds the props in its cache so a mutation can change them
// at once and roll back on failure (`optimistic.ts`). Two triggers refresh:
//
//   * a mutation settling, whether it worked or not;
//   * a change on one of the page's tables arriving from the change feed,
//     which is how a write from another tab, device or the worker shows up.
//
// The admin screens use `useLiveChanges` against their own GET routes instead;
// both share the one feed connection per tab in `change-feed-client.ts`.

import {
  hashKey,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { useToast } from "@/components/ui/toast";
import { subscribeToChanges } from "@/lib/kith/change-feed-client";
import { invalidatedKeys } from "@/lib/kith/live-changes";
import { optimisticHandlers } from "@/lib/kith/optimistic";

/**
 * The server's value for `queryKey`, kept in the query cache, refreshed from
 * the server whenever one of `tables` changes.
 */
export function useServerData<T>(
  queryKey: QueryKey,
  server: T,
  tables: readonly string[],
): T {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({
    queryKey,
    // Never called in practice: the data is never stale, and a refetch is a
    // `router.refresh()`, which arrives as a new `server` prop below.
    queryFn: () => server,
    initialData: server,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const keyHash = hashKey(queryKey);
  useEffect(() => {
    queryClient.setQueryData(queryKey, server);
    // `queryKey` is compared by its hash, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, keyHash, server]);

  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  useEffect(
    () =>
      subscribeToChanges((changes) => {
        if (invalidatedKeys(changes, { page: tablesRef.current }).length > 0) {
          router.refresh();
        }
      }),
    [router],
  );

  return data ?? server;
}

/**
 * A mutation that changes `queryKey`'s cached value at once with `apply`,
 * rolls back and shows a toast on failure, and refreshes from the server when
 * it settles.
 */
export function useOptimisticMutation<T, V>({
  queryKey,
  mutationFn,
  apply,
  onSuccess,
}: {
  queryKey: QueryKey;
  mutationFn: (variables: V) => Promise<unknown>;
  apply: (current: T, variables: V) => T;
  onSuccess?: (result: unknown, variables: V) => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  return useMutation({
    mutationFn,
    ...optimisticHandlers<T, V>(queryClient, queryKey, apply, {
      onFailure: toast,
      resync: () => router.refresh(),
    }),
    ...(onSuccess === undefined ? {} : { onSuccess }),
  });
}
