"use client";

// The live-surface poll design (plan section 5) wired to the browser: a 10
// second interval, cleared on unmount, that does not run while
// `document.visibilityState` is `hidden` and fires one immediate fetch when
// the tab becomes visible again. Every response is requested with
// `cache: "no-store"` to match the route's own `Cache-Control: no-store`.
//
// The state transitions themselves -- what a hidden tab does, what a failed
// fetch does to the displayed value -- are `lib/kith/poll.ts`'s pure
// functions, unit tested there because this project has no jsdom to render a
// hook in. This file is the thin, untested wrapper around them.
//
// Both live surfaces i6 adds (`kith-worker-heartbeat-status.tsx` and
// `kith-dashboard.tsx`'s live section) use this one hook, pointed at their
// own route and `immediate` setting.

import { useCallback, useEffect, useState } from "react";

import { nextPollState, type PollOutcome, type PollState, shouldPoll } from "@/lib/kith/poll";

const POLL_INTERVAL_MS = 10_000;

export type UseStatusPollOptions = {
  /**
   * Fetch once immediately on mount, before the first interval tick. A
   * surface with a server-rendered first paint (the dashboard) leaves this
   * false, so the poll is a refresh and never the only source of the value
   * (plan section 5). A surface with no server-rendered value of its own
   * (the worker heartbeat widget, unchanged from its Convex loading state)
   * sets it true.
   */
  immediate?: boolean;
};

/**
 * Polls `url` every 10 seconds while the tab is visible, starting from
 * `initialValue`. Returns the current `{ value, possiblyStale }`.
 */
export function useStatusPoll<T>(
  url: string,
  initialValue: T,
  options: UseStatusPollOptions = {},
): PollState<T> {
  const immediate = options.immediate ?? false;
  const [state, setState] = useState<PollState<T>>({
    value: initialValue,
    possiblyStale: false,
  });

  const poll = useCallback(async () => {
    let outcome: PollOutcome<T>;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`status route failed: ${response.status}`);
      outcome = { ok: true, value: (await response.json()) as T };
    } catch {
      outcome = { ok: false };
    }
    setState((current) => nextPollState(current, outcome));
  }, [url]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (interval !== undefined) return;
      interval = setInterval(() => {
        if (shouldPoll(document.visibilityState)) void poll();
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (interval === undefined) return;
      clearInterval(interval);
      interval = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      start();
      void poll();
    };

    if (shouldPoll(document.visibilityState)) {
      start();
      if (immediate) void poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [poll, immediate]);

  return state;
}
