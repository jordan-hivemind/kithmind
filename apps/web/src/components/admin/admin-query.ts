"use client";

// What ADM-2's three screens share: the refetch.
//
// Each screen is server-rendered once, then keeps itself current off the
// change feed -- `useLiveChanges` invalidates the screen's key when a table it
// reads changes, and TanStack Query refetches through `/api/kith/admin/...`.
// The three differ only in their key, their watched tables and their payload,
// so that is all this takes as arguments.

import { useQuery } from "@tanstack/react-query";

import { useLiveChanges } from "@/lib/kith/use-live-changes";

export function useAdminScreen<T extends object>(
  screen: string,
  watched: Readonly<Record<string, readonly string[]>>,
  initial: T,
): T {
  useLiveChanges(watched);
  const { data } = useQuery({
    queryKey: [screen],
    queryFn: async (): Promise<T> => {
      const response = await fetch(`/api/kith/admin/${screen}`, {
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`${screen} fetch failed`);
      return (await response.json()) as T;
    },
    initialData: initial,
  });
  return data;
}
