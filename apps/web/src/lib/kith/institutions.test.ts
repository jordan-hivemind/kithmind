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

describe("last four", () => {
  test("Morgan Stanley's BDA type code is dropped from the name", () => {
    expect(
      friendlyAccountName(account({ displayLabel: "Investments: BDA" })),
    ).toBe("Investments");
    expect(
      friendlyAccountName(account({ displayLabel: "Other Loans: SBL" })),
    ).toBe("Other Loans: SBL");
  });

  test("a missing last four says why, a present one says nothing", () => {
    const rows = groupInstitutions(
      [
        record({
          account: account({
            accountId: "a",
            disclosures: [{ field: "accountLast4", reason: "not_reported" }],
          }),
        }),
        record({ account: account({ accountId: "b", accountLast4: "1234" }) }),
      ],
      NOW,
    )[0]!.children!;
    expect(rows[0]!.last4Reason).toMatch(/No statement has printed/);
    expect(rows[1]!.last4Reason).toBeNull();
  });
});

describe("freshness", () => {
  test("nothing held is empty, not stale", () => {
    expect(freshness("2020-01-01", false, NOW, null).status).toBe("empty");
  });

  test("records with no snapshot are fresh: a cash account has none", () => {
    expect(freshness(null, true, NOW, "2026-08-31")).toEqual({
      status: "fresh",
      statusDetail: "no snapshot",
    });
  });

  test("a snapshot past the statement interval is stale, with its age", () => {
    expect(freshness("2026-09-01", true, NOW, "2026-09-01").status).toBe("fresh");
    const stale = freshness("2026-06-01", true, NOW, "2026-08-31");
    expect(stale.status).toBe("stale");
    expect(stale.statusDetail).toMatch(/latest holdings statement 2026-06-01, 109 days ago/);
  });
});

describe("the owner's overrides", () => {
  const overrides = (values: Record<string, unknown>) =>
    new Map([
      [
        "account-1",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: false,
          ...values,
        },
      ],
    ]) as never;

  test("a name, last four and type replace the archive's, which stay available", () => {
    const [group] = groupInstitutions(
      [record({ account: account({ displayLabel: "Investments: BDA" }) })],
      NOW,
      overrides({
        displayName: "Joint brokerage",
        accountLast4: "4321",
        accountType: "trust",
      }),
    );
    const child = group!.children![0]!;
    expect(child.name).toBe("Joint brokerage");
    expect(child.accountLast4).toBe("4321");
    expect(child.accountType).toBe("trust");
    expect(child.last4Reason).toBeNull();
    expect(child.archive).toEqual({
      name: "Investments",
      accountLast4: null,
      accountType: null,
    });
  });

  test("closed makes an account inactive whatever its dates say, but never fills an empty one", () => {
    const [group] = groupInstitutions(
      [record(), record({ account: account({ accountId: "b" }), statementCount: 0, recordCount: 0 })],
      NOW,
      new Map([
        ["account-1", { displayName: null, accountLast4: null, accountType: null, closed: true }],
        ["b", { displayName: null, accountLast4: null, accountType: null, closed: true }],
      ]) as never,
    );
    expect(group!.children![0]!.status).toBe("inactive");
    expect(group!.children![0]!.statusDetail).toBe("marked closed");
    expect(group!.children![1]!.status).toBe("empty");
  });
});

describe("current value", () => {
  const value = (decimal: string, currency = "USD", asOf = "2026-08-31") => ({
    currentValue: { value: { decimal, currency }, asOf, source: "balance" },
  });

  test("a group sums its active accounts and leaves out the ones that went quiet", () => {
    const [group] = groupInstitutions(
      [
        record(value("100.5")),
        record({ account: account({ accountId: "b" }), ...value("50") }),
        record({
          account: account({ accountId: "c" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
          ...value("7000", "USD", "2022-12-31"),
        }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBe(150.5);
    expect(group!.currentValueCurrency).toBe("USD");
    expect(group!.children![2]!.currentValue).toBe(7000);
  });

  test("a group across currencies has no total", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        record({ account: account({ accountId: "b" }), ...value("50", "EUR") }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBeNull();
  });

  test("one active account with no value leaves the institution with no total", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        // The archive holds records for this account but could not state a
        // single value for it. Summing around it reports the institution as
        // worth 100 when part of it was never counted.
        record({ account: account({ accountId: "b" }) }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBeNull();
    expect(group!.currentValueCurrency).toBeNull();
    expect(group!.currentValueAsOf).toBeNull();
    // The account that does have one still shows it.
    expect(group!.children![0]!.currentValue).toBe(100);
  });

  test("a total is dated by its oldest component, never its newest", () => {
    const [group] = groupInstitutions(
      [
        record(value("100", "USD", "2026-08-31")),
        record({
          account: account({ accountId: "b" }),
          ...value("50", "USD", "2026-03-31"),
        }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBe(150);
    // 2026-08-31 would claim the whole 150 was true in August; half of it was
    // last seen in March.
    expect(group!.currentValueAsOf).toBe("2026-03-31");
  });

  test("an account that went quiet is left out of the total and out of the requirement", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        record({
          account: account({ accountId: "b" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
          ...value("7000", "USD", "2022-12-31"),
        }),
        // Inactive and valueless: still not a hole in the live total.
        record({
          account: account({ accountId: "c" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
        }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBe(100);
    expect(group!.currentValueAsOf).toBe("2026-08-31");
    expect(group!.children![1]!.currentValue).toBe(7000);
  });

  test("an account the archive holds nothing for is not a hole either", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        record({
          account: account({ accountId: "b" }),
          statementCount: 0,
          recordCount: 0,
          activityFrom: undefined,
          activityTo: undefined,
          latestSnapshotAsOf: undefined,
        }),
      ],
      NOW,
    );
    expect(group!.children![1]!.status).toBe("empty");
    expect(group!.currentValue).toBe(100);
  });

  test("a closed account is left out of the total, and cannot hold it back", () => {
    const overrides = new Map([
      ["b", { displayName: null, accountLast4: null, accountType: null, closed: true }],
    ]);
    const [group] = groupInstitutions(
      [
        record(value("100")),
        record({ account: account({ accountId: "b" }) }),
      ],
      NOW,
      overrides,
    );
    expect(group!.children!.find((child) => child.id === "b")!.status).toBe(
      "inactive",
    );
    expect(group!.currentValue).toBe(100);
  });

  test("an institution with no active account at all has no total", () => {
    const [group] = groupInstitutions(
      [
        record({
          account: account({ accountId: "b" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
          ...value("7000", "USD", "2022-12-31"),
        }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBeNull();
  });
});

describe("inactive", () => {
  test("an account with no activity for a quarter has stopped, not fallen behind", () => {
    const quiet = freshness("2022-10-31", true, NOW, "2022-12-31");
    expect(quiet.status).toBe("inactive");
    expect(quiet.statusDetail).toMatch(/no activity since 2022-12-31/);
  });

  test("recent activity with an old snapshot is still stale", () => {
    expect(freshness("2022-10-31", true, NOW, "2026-09-10").status).toBe(
      "stale",
    );
  });

  test("an institution of only inactive and empty accounts is inactive", () => {
    const [group] = groupInstitutions(
      [
        record({
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
        }),
        record({
          account: account({ accountId: "account-2" }),
          statementCount: 0,
          recordCount: 0,
          activityFrom: undefined,
          activityTo: undefined,
          latestSnapshotAsOf: undefined,
        }),
      ],
      NOW,
    );
    expect(group!.status).toBe("inactive");
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
          activityTo: "2026-08-31",
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
