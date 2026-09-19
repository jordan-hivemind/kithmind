"use client";

// `useLiveChanges`: subscribe to the tab's one change feed, and turn what
// arrives into TanStack Query invalidations.
//
// The connection itself lives in `change-feed-client.ts`, not here: one per
// tab whatever the screen mounts, nothing open while the tab is hidden, and a
// poll that backs off when nothing is changing. This hook is only the mapping
// from a change's table name to the query keys it invalidates.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { subscribeToChanges } from "@/lib/kith/change-feed-client";
import { invalidatedKeys } from "@/lib/kith/live-changes";

/**
 * Watches the feed and invalidates `watched`'s keys as their tables change.
 *
 * `watched` maps a query key's first segment to the table names that key's
 * data is read from, for example
 * `{ sources: ["source_accounts", "source_roots", "source_items"] }`.
 */
export function useLiveChanges(
  watched: Readonly<Record<string, readonly string[]>>,
): void {
  const queryClient = useQueryClient();
  // Held in a ref so a caller may pass an inline object literal without
  // resubscribing on every render.
  const watchedRef = useRef(watched);
  watchedRef.current = watched;

  useEffect(
    () =>
      subscribeToChanges((changes) => {
        for (const key of invalidatedKeys(changes, watchedRef.current)) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }),
    [queryClient],
  );
}
