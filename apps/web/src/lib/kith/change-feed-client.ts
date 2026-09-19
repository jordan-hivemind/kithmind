// One change-feed connection per browser tab, shared by every hook that wants
// it.
//
// Three properties this exists for, none of which a per-hook `useEffect` can
// give on its own:
//
//   * One connection. Two admin tables on one screen must not open two
//     streams against a route that holds a serverless instance open and a
//     database awake for each. Subscribers share the connection and the
//     cursor; the last one to leave closes it.
//   * Nothing while hidden. A forgotten tab is the case that keeps a
//     serverless database awake for hours for nobody, so a hidden tab holds no
//     connection at all. It resumes from the same cursor, and the feed's
//     retention (three days) is far longer than a tab is plausibly hidden, so
//     resuming loses nothing.
//   * Backing off when idle. An open admin panel nobody is writing to polls
//     every ten seconds rather than every two.
//
// Kept out of the hook and out of React so all three are plain functions with
// one module-level object to reason about.

import {
  type LiveChange,
  parseEventBlock,
  splitEventBlocks,
} from "@/lib/kith/live-changes";

/** Poll interval while changes are arriving. */
export const ACTIVE_POLL_MS = 2_000;
/** Poll interval once nothing has changed for `IDLE_AFTER_MS`. */
export const IDLE_POLL_MS = 10_000;
/** How long without a change before the idle interval takes over. */
export const IDLE_AFTER_MS = 60_000;
/** How long to wait before reopening after a failure. */
export const RETRY_DELAY_MS = 3_000;

/** The interval to wait before the next poll, given how long it has been since
 * the last change. Exported so the rule is testable without a timer. */
export function pollIntervalMs(msSinceLastChange: number): number {
  return msSinceLastChange >= IDLE_AFTER_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
}

type Subscriber = (changes: readonly LiveChange[]) => void;

type Feed = {
  subscribers: Set<Subscriber>;
  /** The cursor, kept across reconnects, visibility changes and subscribers. */
  cursor: string | null;
  /** Aborts the in-flight request; null when nothing is open. */
  controller: AbortController | null;
  running: boolean;
  lastChangeAt: number;
  detachVisibility: (() => void) | null;
};

const feed: Feed = {
  subscribers: new Set(),
  cursor: null,
  controller: null,
  running: false,
  lastChangeAt: 0,
  detachVisibility: null,
};

type ChangesPayload = { cursor: string; changes: LiveChange[] };

function url(cursor: string | null): string {
  return cursor === null
    ? "/api/kith/changes"
    : `/api/kith/changes?since=${encodeURIComponent(cursor)}`;
}

/** `Content-Type` is the gate `guardedRequest` checks on every method, this
 * GET included. See `lib/kith/api-route.ts`. */
const JSON_HEADER = { "Content-Type": "application/json" } as const;

function deliver(changes: readonly LiveChange[]): void {
  if (changes.length === 0) return;
  feed.lastChangeAt = Date.now();
  for (const subscriber of [...feed.subscribers]) subscriber(changes);
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** One stream. Returns false when the response was not a stream, so the caller
 * polls rather than reopening something that cannot work here. */
async function openStream(signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url(feed.cursor), {
    headers: { ...JSON_HEADER, Accept: "text/event-stream" },
    signal,
    cache: "no-store",
  });
  if (!response.ok || response.body === null) return false;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const payload = (await response.json()) as ChangesPayload;
    feed.cursor = payload.cursor;
    deliver(payload.changes);
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
        feed.cursor = frame.change.id;
        batch.push(frame.change);
      } else if (frame.kind === "end" && frame.cursor !== "") {
        feed.cursor = frame.cursor;
      }
    }
    deliver(batch);
  }
}

async function poll(signal: AbortSignal): Promise<void> {
  const response = await fetch(url(feed.cursor), {
    headers: JSON_HEADER,
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("changes poll failed");
  const payload = (await response.json()) as ChangesPayload;
  feed.cursor = payload.cursor;
  deliver(payload.changes);
}

async function run(): Promise<void> {
  const controller = feed.controller;
  if (controller === null) return;
  const { signal } = controller;
  let streaming = true;
  while (!signal.aborted) {
    try {
      if (streaming) streaming = await openStream(signal);
      else {
        await poll(signal);
        if (signal.aborted) break;
        await wait(pollIntervalMs(Date.now() - feed.lastChangeAt), signal);
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof DOMException && error.name === "AbortError") break;
      streaming = false;
      await wait(RETRY_DELAY_MS, signal);
    }
  }
  feed.running = false;
}

function start(): void {
  if (feed.running || feed.subscribers.size === 0 || hidden()) return;
  feed.running = true;
  feed.controller = new AbortController();
  feed.lastChangeAt = Date.now();
  void run();
}

function stop(): void {
  feed.controller?.abort();
  feed.controller = null;
}

function onVisibility(): void {
  if (hidden()) stop();
  else start();
}

/**
 * Subscribes to the feed, opening it if this is the first subscriber, and
 * returns the unsubscribe. The cursor survives every one of them leaving, so
 * a screen that unmounts and remounts resumes where it was rather than
 * skipping to now.
 */
export function subscribeToChanges(subscriber: Subscriber): () => void {
  feed.subscribers.add(subscriber);
  if (feed.detachVisibility === null && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    feed.detachVisibility = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      feed.detachVisibility = null;
    };
  }
  start();
  return () => {
    feed.subscribers.delete(subscriber);
    if (feed.subscribers.size > 0) return;
    stop();
    feed.detachVisibility?.();
  };
}

/** Test-only: forgets the connection and its cursor. */
export function resetChangeFeed(): void {
  feed.subscribers.clear();
  stop();
  feed.detachVisibility?.();
  feed.cursor = null;
  feed.running = false;
  feed.lastChangeAt = 0;
}
