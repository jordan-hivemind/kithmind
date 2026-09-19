"use client";

// The TanStack Query cache.
//
// One client per browser tab, created in state so a re-render never swaps it.
// Mounted by the `(authenticated)` layout for the app pages; the admin layout
// mounts its own inside that one, which is harmless.
//
// `staleTime` is deliberately long. The live feed is what makes data fresh
// here (`useLiveChanges` invalidates by table name), so a timer refetching on
// its own would be a second, dumber copy of the same job.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5 * 60_000, refetchOnWindowFocus: true, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
