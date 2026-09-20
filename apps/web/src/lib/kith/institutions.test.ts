// ADM-2's institutions grouping, masking and freshness rules.

import { describe, expect, test } from "vitest";

import {
  freshness,
  friendlyAccountName,
  groupInstitutions,
} from "@/lib/kith/institutions";

const NOW = Date.parse("2026-09-18T12:00:00Z");

function account(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "account-1",
    sourceId: "source-1",
    institutionName: "Example Broker",
    disclosures: [],
    ...overrides,
  } as never;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    account: account(),
    statementCount: 4,
    recordCount: 40,
    activityFrom: "2025-01-02",
    activityTo: "2026-08-31",
    latestSnapshotAsOf: "2026-08-31",
    openReviewCount: 0,
    ...overrides,
  } as never;
}

describe("account names stay separate from identifiers", () => {
  test("the display label wins", () => {
    expect(friendlyAccountName(account({ displayLabel: "Income" }))).toBe(
      "Income",
    );
  });

  test("a missing label is explicit instead of replaced by an account id", () => {
    expect(friendlyAccountName(account())).toBe("Unlabeled account");
  });
});

describe("freshness", () => {
  test("nothing held is empty, not stale", () => {
    expect(freshness("2020-01-01", false, NOW).status).toBe("empty");
  });

  test("records with no snapshot are fresh: a cash account has none", () => {
    expect(freshness(null, true, NOW)).toEqual({
      status: "fresh",
      statusDetail: "no snapshot",
    });
  });

  test("a snapshot past the statement interval is stale, with its age", () => {
    expect(freshness("2026-09-01", true, NOW).status).toBe("fresh");
    const stale = freshness("2026-06-01", true, NOW);
    expect(stale.status).toBe("stale");
    expect(stale.statusDetail).toMatch(/latest snapshot 2026-06-01, 109d old/);
  });
});

describe("grouping", () => {
  test("a group's numbers are its accounts' numbers, and its range is widened", () => {
    const [group] = groupInstitutions(
      [
        record(),
        record({
          account: account({
            accountId: "account-2",
            displayLabel: "IRA",
            accountLast4: "1234",
          }),
          statementCount: 2,
          recordCount: 8,
          activityFrom: "2024-06-01",
          activityTo: "2026-02-28",
          latestSnapshotAsOf: "2026-02-28",
          openReviewCount: 3,
        }),
      ],
      NOW,
    );
    expect(group!.accounts).toBe(2);
    expect(group!.statements).toBe(6);
    expect(group!.records).toBe(48);
    expect(group!.openReviews).toBe(3);
    expect(group!.activityFrom).toBe("2024-06-01");
    expect(group!.activityTo).toBe("2026-08-31");
    expect(group!.latestSnapshotAsOf).toBe("2026-08-31");
    expect(group!.children?.map((child) => child.name)).toEqual([
      "Unlabeled account",
      "IRA",
    ]);
    expect(group!.children?.map((child) => child.accountName)).toEqual([
      "Unlabeled account",
      "IRA",
    ]);
    expect(group!.children?.map((child) => child.accountLast4)).toEqual([
      null,
      "1234",
    ]);
  });

  test("one stale account makes the group stale, although its latest snapshot is recent", () => {
    const [group] = groupInstitutions(
      [
        record(),
        record({
          account: account({ accountId: "account-2", displayLabel: "IRA" }),
          activityFrom: "2020-01-01",
          activityTo: "2024-06-30",
          latestSnapshotAsOf: "2024-06-30",
        }),
      ],
      NOW,
    );
    // The group's own latest snapshot column is still the recent one.
    expect(group!.latestSnapshotAsOf).toBe("2026-08-31");
    expect(group!.status).toBe("stale");
    expect(group!.statusDetail).toMatch(/1 stale, oldest IRA/);
  });

  test("an institution the archive holds nothing for is a row, not an omission", () => {
    const [group] = groupInstitutions(
      [
        record({
          statementCount: 0,
          recordCount: 0,
          activityFrom: undefined,
          activityTo: undefined,
          latestSnapshotAsOf: undefined,
        }),
      ],
      NOW,
    );
    expect(group!.status).toBe("empty");
    expect(group!.statements).toBe(0);
    expect(group!.activityFrom).toBeNull();
  });

  test("institutions come back in name order", () => {
    const grouped = groupInstitutions(
      [
        record({ account: account({ institutionName: "Zephyr Bank" }) }),
        record({
          account: account({
            accountId: "account-2",
            institutionName: "Alder Trust",
          }),
        }),
      ],
      NOW,
    );
    expect(grouped.map((group) => group.name)).toEqual([
      "Alder Trust",
      "Zephyr Bank",
    ]);
  });
});
