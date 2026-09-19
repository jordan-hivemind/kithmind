"use client";

// `useLiveChanges`: open `/api/kith/changes`, and turn what arrives into
// TanStack Query invalidations.
//
// It opens the feed with `fetch` rather than `EventSource` because every
// `/api/kith/*` route requires `Content-Type: application/json` as its CSRF
// barrier and `EventSource` cannot set headers. Losing the browser's built-in
// reconnect costs one `while` loop here; keeping the barrier is worth more.
//
// The fallback is the same route with the same cursor and no
// `Accept: text/event-stream`, which answers with plain JSON. So a stream that
// will not open (a proxy that buffers, a platform that refuses a long
// response) degrades to a poll without a second endpoint or a second cursor.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  invalidatedKeys,
  type LiveChange,
  parseEventBlock,
  splitEventBlocks,
} from "@/lib/kith/live-changes";

/** How long the poll fallback waits between reads. */
const POLL_INTERVAL_MS = 5_000;
/** How long to wait before reopening after a failure, so a down server is not hammered. */
const RETRY_DELAY_MS = 3_000;

type ChangesPayload = { cursor: string; changes: LiveChange[] };

function headers(): HeadersInit {
  // `Content-Type` is the gate `guardedRequest` checks on every method,
  // including this GET. See `lib/kith/api-route.ts`.
  return { "Content-Type": "application/json" };
}

function url(cursor: string | null): string {
  return cursor === null
    ? "/api/kith/changes"
    : `/api/kith/changes?since=${encodeURIComponent(cursor)}`;
}

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
  // restarting the connection on every render.
  const watchedRef = useRef(watched);
  watchedRef.current = watched;

  useEffect(() => {
    const controller = new AbortController();
    let cursor: string | null = null;
    let stopped = false;

    const apply = (changes: readonly LiveChange[]) => {
      for (const key of invalidatedKeys(changes, watchedRef.current)) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    };

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });

    /** One stream. Returns false when the stream never opened, so the caller
     * falls back to polling instead of reopening a stream that cannot work. */
    const openStream = async (): Promise<boolean> => {
      const response = await fetch(url(cursor), {
        headers: { ...headers(), Accept: "text/event-stream" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok || response.body === null) return false;
      if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        // The route answered with JSON, which is the poll shape.
        const payload = (await response.json()) as ChangesPayload;
        cursor = payload.cursor;
        apply(payload.changes);
        return false;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return true;
        buffer += value;
        const { blocks, rest } = splitEventBlocks(buffer);
        buffer = rest;
        const batch: LiveChange[] = [];
        for (const block of blocks) {
          const frame = parseEventBlock(block);
          if (frame === null) continue;
          if (frame.kind === "change") {
            cursor = frame.change.id;
            batch.push(frame.change);
          } else if (frame.kind === "end" && frame.cursor !== "") {
            cursor = frame.cursor;
          }
        }
        if (batch.length > 0) apply(batch);
      }
    };

    const poll = async (): Promise<void> => {
      const response = await fetch(url(cursor), {
        headers: headers(),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("changes poll failed");
      const payload = (await response.json()) as ChangesPayload;
      cursor = payload.cursor;
      apply(payload.changes);
    };

    void (async () => {
      let streaming = true;
      while (!stopped && !controller.signal.aborted) {
        try {
          if (streaming) streaming = await openStream();
          else {
            await poll();
            await wait(POLL_INTERVAL_MS);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          // An aborted fetch is the effect being torn down, not a failure.
          if (error instanceof DOMException && error.name === "AbortError") return;
          streaming = false;
          await wait(RETRY_DELAY_MS);
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [queryClient]);
}
