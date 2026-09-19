// The tab's one change-feed connection: shared, paused while hidden, and
// backing off when nothing is changing.
//
// `document` is stubbed rather than pulled in as a DOM environment: the three
// properties under test are about when a `fetch` happens and with what cursor,
// and the only DOM this module touches is `visibilityState` and one listener.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ACTIVE_POLL_MS,
  IDLE_AFTER_MS,
  IDLE_POLL_MS,
  pollIntervalMs,
  resetChangeFeed,
  subscribeToChanges,
} from "@/lib/kith/change-feed-client";
import type { LiveChange } from "@/lib/kith/live-changes";

describe("the poll interval", () => {
  test("is the active one while changes are arriving", () => {
    expect(pollIntervalMs(0)).toBe(ACTIVE_POLL_MS);
    expect(pollIntervalMs(IDLE_AFTER_MS - 1)).toBe(ACTIVE_POLL_MS);
  });

  test("backs off once nothing has changed for a minute", () => {
    expect(pollIntervalMs(IDLE_AFTER_MS)).toBe(IDLE_POLL_MS);
    expect(pollIntervalMs(10 * IDLE_AFTER_MS)).toBe(IDLE_POLL_MS);
  });
});

type Listener = () => void;

describe("the shared connection", () => {
  let requested: string[];
  let visibility: "visible" | "hidden";
  let listeners: Listener[];

  /** Every response is a plain JSON poll, which is the fallback shape. That
   * keeps each round trip one `fetch` with an observable URL. */
  function payload(cursor: string, changes: LiveChange[] = []) {
    return new Response(JSON.stringify({ cursor, changes }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Long enough for the module's own `await`s to settle, short enough that
   * the 2s poll timer has not fired. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    requested = [];
    visibility = "visible";
    listeners = [];
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (name: string, listener: Listener) => {
        if (name === "visibilitychange") listeners.push(listener);
      },
      removeEventListener: (name: string, listener: Listener) => {
        listeners = listeners.filter((entry) => entry !== listener);
      },
    });
  });

  afterEach(() => {
    resetChangeFeed();
    vi.unstubAllGlobals();
  });

  function stubFetch(responses: () => Response): void {
    vi.stubGlobal("fetch", (input: string) => {
      requested.push(String(input));
      return Promise.resolve(responses());
    });
  }

  test("two subscribers share one connection and both see a change", async () => {
    const change: LiveChange = {
      id: "7",
      table: "source_roots",
      rowId: "abc",
      op: "update",
    };
    let call = 0;
    stubFetch(() => (call++ === 0 ? payload("7", [change]) : payload("7")));

    const first: LiveChange[][] = [];
    const second: LiveChange[][] = [];
    const stopFirst = subscribeToChanges((changes) => first.push([...changes]));
    const stopSecond = subscribeToChanges((changes) => second.push([...changes]));
    await settle();

    // One connection, not two: the second subscriber joined the first's.
    expect(requested.length).toBeLessThanOrEqual(2);
    expect(first).toEqual([[change]]);
    expect(second).toEqual([[change]]);

    stopFirst();
    stopSecond();
  });

  test("a hidden tab holds no connection, and resumes on the same cursor", async () => {
    stubFetch(() => payload("42"));
    const stop = subscribeToChanges(() => {});
    await settle();
    expect(requested.length).toBeGreaterThan(0);
    // The first request carried no cursor; the feed now holds one.
    expect(requested[0]).toBe("/api/kith/changes");

    // Hiding the tab closes it, and nothing more is requested.
    visibility = "hidden";
    for (const listener of listeners) listener();
    const afterHiding = requested.length;
    await settle();
    expect(requested.length).toBe(afterHiding);

    // Showing it again reopens from the cursor it kept, not from scratch.
    visibility = "visible";
    for (const listener of listeners) listener();
    await settle();
    expect(requested.length).toBeGreaterThan(afterHiding);
    expect(requested.at(-1)).toBe("/api/kith/changes?since=42");

    stop();
  });

  test("a tab that is already hidden opens nothing at all", async () => {
    visibility = "hidden";
    stubFetch(() => payload("1"));
    const stop = subscribeToChanges(() => {});
    await settle();
    expect(requested).toEqual([]);
    stop();
  });

  test("the last subscriber leaving closes the connection", async () => {
    stubFetch(() => payload("3"));
    const stop = subscribeToChanges(() => {});
    await settle();
    const opened = requested.length;
    stop();
    await settle();
    expect(requested.length).toBe(opened);
    // And the visibility listener is gone with it.
    expect(listeners).toEqual([]);
  });
});
