// FIN-STATUS-1: the Institutions screen's Status column, from the feed
// alone. Every branch of `feedStatus`, synthetic rows only, plus the
// aggregation rules the institution header uses.

import { describe, expect, test } from "vitest";

import {
  aggregateFeedStatusDetail,
  FEED_FRESH_DAYS,
  FEED_INACTIVE_DAYS,
  feedStatus,
  feedStatusDetail,
  type FeedStatusInput,
  worstFeedStatus,
} from "@/lib/kith/feed-status";

const at = (date: string, time = "12:00:00") => Date.parse(`${date}T${time}Z`);
const NOW = at("2026-09-18");

function input(overrides: Partial<FeedStatusInput> = {}): FeedStatusInput {
  return {
    archiveClosed: false,
    archiveLastRecordAsOf: null,
    feedLinked: false,
    needsRelinkAt: null,
    latestFeedSnapshotAsOf: null,
    ...overrides,
  };
}

describe("closed always reads inactive", () => {
  test("closed wins over an unlinked account with a recent archive record", () => {
    expect(
      feedStatus(
        input({ archiveClosed: true, archiveLastRecordAsOf: "2026-09-10" }),
        NOW,
      ),
    ).toBe("inactive");
  });

  test("closed wins over a feed-linked, fresh account", () => {
    expect(
      feedStatus(
        input({
          archiveClosed: true,
          feedLinked: true,
          latestFeedSnapshotAsOf: "2026-09-17",
        }),
        NOW,
      ),
    ).toBe("inactive");
  });

  test("closed wins over an item that needs relinking", () => {
    expect(
      feedStatus(
        input({
          archiveClosed: true,
          feedLinked: true,
          needsRelinkAt: "2026-09-01T00:00:00Z",
        }),
        NOW,
      ),
    ).toBe("inactive");
  });

  test("the tooltip says closed, not the archive's last record", () => {
    expect(
      feedStatusDetail(
        "inactive",
        input({ archiveClosed: true, archiveLastRecordAsOf: "2020-01-01" }),
        NOW,
      ),
    ).toBe("marked closed");
  });
});

describe("no feed link", () => {
  test("a record within the last year reads no_feed", () => {
    expect(
      feedStatus(input({ archiveLastRecordAsOf: "2026-08-31" }), NOW),
    ).toBe("no_feed");
  });

  test(`exactly ${FEED_INACTIVE_DAYS} days old is still no_feed`, () => {
    const boundary = new Date(NOW - FEED_INACTIVE_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(feedStatus(input({ archiveLastRecordAsOf: boundary }), NOW)).toBe(
      "no_feed",
    );
  });

  test("a record older than a year reads inactive", () => {
    expect(
      feedStatus(input({ archiveLastRecordAsOf: "2022-12-31" }), NOW),
    ).toBe("inactive");
  });

  test("no record at all reads inactive, not no_feed", () => {
    expect(feedStatus(input({ archiveLastRecordAsOf: null }), NOW)).toBe(
      "inactive",
    );
  });

  test("the no_feed tooltip names the archive's last record", () => {
    expect(
      feedStatusDetail(
        "no_feed",
        input({ archiveLastRecordAsOf: "2026-08-31" }),
        NOW,
      ),
    ).toBe("no Plaid link; last archive record 2026-08-31");
  });

  test("the inactive tooltip says so when there never was a record", () => {
    expect(
      feedStatusDetail("inactive", input({ archiveLastRecordAsOf: null }), NOW),
    ).toBe("no archive record");
  });

  test("the inactive tooltip names the archive's last record when there was one", () => {
    expect(
      feedStatusDetail(
        "inactive",
        input({ archiveLastRecordAsOf: "2022-12-31" }),
        NOW,
      ),
    ).toBe("no archive record since 2022-12-31");
  });
});

describe("feed linked", () => {
  test("needs_relink wins over a fresh snapshot", () => {
    expect(
      feedStatus(
        input({
          feedLinked: true,
          needsRelinkAt: "2026-09-01T00:00:00Z",
          latestFeedSnapshotAsOf: "2026-09-17",
        }),
        NOW,
      ),
    ).toBe("needs_relink");
  });

  test("needs_relink wins over a stale or missing snapshot too", () => {
    expect(
      feedStatus(
        input({ feedLinked: true, needsRelinkAt: "2026-01-01T00:00:00Z" }),
        NOW,
      ),
    ).toBe("needs_relink");
  });

  test("the needs_relink tooltip names the date", () => {
    expect(
      feedStatusDetail(
        "needs_relink",
        input({
          feedLinked: true,
          needsRelinkAt: "2026-09-01T00:00:00Z",
        }),
        NOW,
      ),
    ).toBe("Plaid needs re-authentication since 2026-09-01");
  });

  test("linked but never pulled reads stale", () => {
    expect(
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: null }),
        NOW,
      ),
    ).toBe("stale");
    expect(
      feedStatusDetail(
        "stale",
        input({ feedLinked: true, latestFeedSnapshotAsOf: null }),
        NOW,
      ),
    ).toBe("linked; no feed snapshot yet");
  });

  test(`a snapshot within ${FEED_FRESH_DAYS} days is fresh`, () => {
    expect(
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-17" }),
        NOW,
      ),
    ).toBe("fresh");
    expect(
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-16" }),
        NOW,
      ),
    ).toBe("fresh");
  });

  test(`a snapshot older than ${FEED_FRESH_DAYS} days is stale`, () => {
    expect(
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-10" }),
        NOW,
      ),
    ).toBe("stale");
    expect(
      feedStatusDetail(
        "stale",
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-10" }),
        NOW,
      ),
    ).toBe("feed last updated 2026-09-10, 8 days ago");
  });

  test("the fresh tooltip names the feed's own update date", () => {
    expect(
      feedStatusDetail(
        "fresh",
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-17" }),
        NOW,
      ),
    ).toBe("feed updated 2026-09-17");
  });
});

describe("no valuation or reconciliation input exists to leak", () => {
  // `FeedStatusInput` has no field for an unpriced holding or a
  // reconciliation mismatch -- there is nothing for any branch here to say
  // about either, by construction. The five statuses below are the whole
  // vocabulary; "needs_review" is not one of them.
  test("every branch returns one of the five feed statuses", () => {
    const seen = new Set([
      feedStatus(input({ archiveClosed: true }), NOW),
      feedStatus(input({ archiveLastRecordAsOf: "2026-09-10" }), NOW),
      feedStatus(input({ archiveLastRecordAsOf: "2020-01-01" }), NOW),
      feedStatus(
        input({
          feedLinked: true,
          needsRelinkAt: "2026-09-01T00:00:00Z",
        }),
        NOW,
      ),
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-17" }),
        NOW,
      ),
      feedStatus(
        input({ feedLinked: true, latestFeedSnapshotAsOf: "2026-09-10" }),
        NOW,
      ),
    ]);
    expect([...seen].sort()).toEqual(
      ["fresh", "inactive", "needs_relink", "no_feed", "stale"].sort(),
    );
  });
});

describe("worstFeedStatus", () => {
  test("needs_relink outranks everything", () => {
    expect(
      worstFeedStatus(["fresh", "no_feed", "inactive", "needs_relink", "stale"]),
    ).toBe("needs_relink");
  });

  test("stale outranks no_feed and inactive", () => {
    expect(worstFeedStatus(["fresh", "no_feed", "inactive", "stale"])).toBe(
      "stale",
    );
  });

  test("no_feed outranks inactive: an unlinked account with a recent record is more worth a look", () => {
    expect(worstFeedStatus(["fresh", "inactive", "no_feed"])).toBe("no_feed");
  });

  test("inactive outranks fresh", () => {
    expect(worstFeedStatus(["fresh", "inactive"])).toBe("inactive");
  });

  test("an institution of only fresh accounts is fresh", () => {
    expect(worstFeedStatus(["fresh", "fresh"])).toBe("fresh");
  });

  test("an institution header with no accounts reports nothing wrong", () => {
    expect(worstFeedStatus([])).toBe("fresh");
  });
});

describe("aggregateFeedStatusDetail", () => {
  test("counts each status, worst first", () => {
    expect(
      aggregateFeedStatusDetail(["fresh", "stale", "stale", "no_feed"]),
    ).toBe("2 stale, 1 no feed, 1 fresh");
  });

  test("no accounts is null, not an empty string", () => {
    expect(aggregateFeedStatusDetail([])).toBeNull();
  });
});
