// `lib/kith/poll.ts`'s pure state machine. No jsdom is available in this
// project (see that file's header), so this is the whole test of the live
// surfaces' poll design: a hidden tab skips, a failed fetch keeps the last
// good value and flags it, and a success replaces it.

import { describe, expect, test } from "vitest";

import { nextPollState, shouldPoll } from "./poll";

describe("shouldPoll", () => {
  test("a hidden tab does not poll", () => {
    expect(shouldPoll("hidden")).toBe(false);
  });

  test("a visible tab polls", () => {
    expect(shouldPoll("visible")).toBe(true);
  });

  test("an unrecognized visibility state fails open to polling", () => {
    expect(shouldPoll("prerender")).toBe(true);
  });
});

describe("nextPollState", () => {
  test("a successful poll replaces the value and clears staleness", () => {
    const current = { value: 1, possiblyStale: true };
    expect(nextPollState(current, { ok: true, value: 2 })).toEqual({
      value: 2,
      possiblyStale: false,
    });
  });

  test("a failed poll keeps the last good value and flags it possibly stale", () => {
    const current = { value: 1, possiblyStale: false };
    expect(nextPollState(current, { ok: false })).toEqual({
      value: 1,
      possiblyStale: true,
    });
  });

  test("a failed poll after an earlier failure keeps the same last good value", () => {
    const current = { value: "last-good", possiblyStale: true };
    expect(nextPollState(current, { ok: false })).toEqual({
      value: "last-good",
      possiblyStale: true,
    });
  });

  test("a success after a failure clears the stale flag it set", () => {
    const stale = nextPollState(
      { value: "a", possiblyStale: false },
      { ok: false },
    );
    expect(stale.possiblyStale).toBe(true);
    const recovered = nextPollState(stale, { ok: true, value: "b" });
    expect(recovered).toEqual({ value: "b", possiblyStale: false });
  });
});
