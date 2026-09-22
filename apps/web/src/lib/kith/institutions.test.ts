// ADM-2's institutions grouping and masking rules, and FIN-STATUS-1's feed
// merge (`mergeLiveAccounts`): Current value/Holdings as of from the feed
// when an account is linked to one, and the Status column computed from the
// feed alone. `feed-status.test.ts` covers the status rule itself, branch by
// branch; this file covers grouping, masking, value summation and the merge
// that wires the feed into an archive-only row.

import type { admin } from "@repo/kith-store";
import { describe, expect, test } from "vitest";

import { valueIsStale } from "@/lib/kith/account-freshness";
import {
  friendlyAccountName,
  groupInstitutions,
  mergeLiveAccounts,
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

function finAccount(
  overrides: Partial<admin.FinAccountRow> = {},
): admin.FinAccountRow {
  return {
    accountId: "fin-1",
    archiveAccountId: null,
    plaidAccountId: "plaid-account-1",
    institutionName: "Example Broker",
    accountName: "Brokerage",
    mask: "1234",
    type: "investment",
    subtype: "brokerage",
    currentBalance: null,
    currency: "USD",
    balanceAsOf: null,
    balanceSource: null,
    holdingsValue: null,
    holdingsAsOf: null,
    holdingsSource: null,
    needsRelinkAt: null,
    ...overrides,
  };
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

describe("the archive-only baseline (no feed merge)", () => {
  // `groupInstitutions` alone never sees `kith.fin_accounts`, so every row
  // it returns is as if nothing is feed-linked: `no_feed` when the archive
  // has a recent-enough record, `inactive` when it does not or has none at
  // all. `cadence`/`freshnessReason`/`expectedBy` still come from
  // `accountFreshness`, for the account drawer, and are unaffected.
  const child = (overrides: Record<string, unknown>) =>
    groupInstitutions([record(overrides)], NOW)[0]!.children![0]!;

  test("nothing held is inactive, and the row is marked empty", () => {
    const row = child({
      statementCount: 0,
      recordCount: 0,
      activityFrom: undefined,
      activityTo: undefined,
      latestSnapshotAsOf: undefined,
    });
    expect(row.status).toBe("inactive");
    expect(row.statusDetail).toBe("no archive record");
    expect(row.empty).toBe(true);
  });

  test("a recent archive record with no feed link reads no_feed", () => {
    const row = child({ latestSnapshotAsOf: undefined });
    expect(row.status).toBe("no_feed");
    expect(row.freshnessReason).toBe("no_balance");
    expect(row.empty).toBe(false);
  });

  test("an old holdings snapshot never makes the Status column stale: that is a feed question now", () => {
    expect(child({ latestSnapshotAsOf: "2026-08-31" }).status).toBe("no_feed");
    const behind = child({ latestSnapshotAsOf: "2026-06-30" });
    // The archive's own cadence rule still marks this account behind, for
    // the drawer.
    expect(behind.freshnessReason).toBe("holdings_behind");
    // But the Status column no longer reads it: unlinked, and the archive
    // has a record from today.
    expect(behind.status).toBe("no_feed");
  });

  test("the row still carries the balance date, cadence and expectation beside the snapshot", () => {
    const row = child({
      activityTo: "2026-08-31",
      latestSnapshotAsOf: "2026-06-30",
      balanceDates: ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"],
      latestBalanceHoldsSecurities: true,
    });
    expect(row.latestBalanceAsOf).toBe("2026-06-30");
    expect(row.latestSnapshotAsOf).toBe("2026-06-30");
    expect(row.cadence).toBe("quarterly");
    expect(row.expectedBy).toBe("2026-10-20");
    expect(row.status).toBe("no_feed");
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
        displayName: "Joint brokerage: BDA",
        accountLast4: "4321",
        accountType: "trust",
      }),
    );
    const child = group!.children![0]!;
    // BDA cleanup applies to the institution's generic label, never to the
    // owner's literal choice of name.
    expect(child.name).toBe("Joint brokerage: BDA");
    expect(child.accountLast4).toBe("4321");
    expect(child.accountType).toBe("trust");
    expect(child.last4Reason).toBeNull();
    expect(child.archive).toEqual({
      name: "Investments",
      accountLast4: null,
      accountType: null,
    });
  });

  test("closed makes an account inactive whatever its dates, or its own emptiness, say", () => {
    const [group] = groupInstitutions(
      [
        record(),
        record({
          account: account({ accountId: "b" }),
          statementCount: 0,
          recordCount: 0,
        }),
      ],
      NOW,
      new Map([
        [
          "account-1",
          {
            displayName: null,
            accountLast4: null,
            accountType: null,
            closed: true,
          },
        ],
        [
          "b",
          {
            displayName: null,
            accountLast4: null,
            accountType: null,
            closed: true,
          },
        ],
      ]) as never,
    );
    expect(group!.children![0]!.status).toBe("inactive");
    expect(group!.children![0]!.statusDetail).toBe("marked closed");
    // Closed wins even over an account the archive holds nothing for: there
    // is no separate "empty" status any more, and a closed account with
    // nothing in it is exactly as inactive as one that still is closed.
    expect(group!.children![1]!.status).toBe("inactive");
    expect(group!.children![1]!.empty).toBe(true);
  });
});

describe("current value", () => {
  const value = (decimal: string, currency = "USD", asOf = "2026-08-31") => ({
    currentValue: { value: { decimal, currency }, asOf, source: "balance" },
  });

  test("a group sums its live accounts", () => {
    const [group] = groupInstitutions(
      [
        record(value("100.5")),
        record({ account: account({ accountId: "b" }), ...value("50") }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBe(150.5);
    expect(group!.currentValueCurrency).toBe("USD");
    expect(group!.currentValueAsOf).toBe("2026-08-31");
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

  test("an account that went quiet holding nothing is left out of the total", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        // Quiet and valueless: nothing was dropped from the total, so the
        // total is still the whole of what the institution holds.
        record({
          account: account({ accountId: "b" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
        }),
      ],
      NOW,
    );
    expect(group!.children![1]!.status).toBe("inactive");
    expect(group!.currentValue).toBe(100);
    expect(group!.currentValueAsOf).toBe("2026-08-31");
  });

  test("a closed account with no value is left out of the total, and cannot hold it back", () => {
    const overrides = new Map([
      [
        "b",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: true,
        },
      ],
    ]);
    const [group] = groupInstitutions(
      [record(value("100")), record({ account: account({ accountId: "b" }) })],
      NOW,
      overrides,
    );
    expect(group!.children!.find((child) => child.id === "b")!.status).toBe(
      "inactive",
    );
    expect(group!.currentValue).toBe(100);
  });

  test("an excluded account that still holds money blanks the total", () => {
    const [group] = groupInstitutions(
      [
        record(value("100")),
        // Quiet past the threshold, and holding half a million. Summing the
        // live accounts alone would show this institution as worth 100.
        record({
          account: account({ accountId: "b" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
          ...value("500000", "USD", "2022-12-31"),
        }),
      ],
      NOW,
    );
    expect(group!.children!.find((child) => child.id === "b")!.status).toBe(
      "inactive",
    );
    expect(group!.currentValue).toBeNull();
    // The account's own row still shows what it holds.
    expect(
      group!.children!.find((child) => child.id === "b")!.currentValue,
    ).toBe(500000);
  });

  test("a closed account holding a balance blanks the total", () => {
    const closed = new Map([
      [
        "b",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: true,
        },
      ],
    ]);
    const [group] = groupInstitutions(
      [
        record(value("100")),
        record({ account: account({ accountId: "b" }), ...value("250") }),
      ],
      NOW,
      closed,
    );
    expect(group!.currentValue).toBeNull();
  });

  test("a closed account with nothing left in it does not block the total", () => {
    const closed = new Map([
      [
        "b",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: true,
        },
      ],
      [
        "c",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: true,
        },
      ],
    ]);
    const [group] = groupInstitutions(
      [
        record(value("100")),
        // Emptied before it was closed.
        record({ account: account({ accountId: "b" }), ...value("0") }),
        // Closed, and the archive states no value for it at all.
        record({ account: account({ accountId: "c" }) }),
      ],
      NOW,
      closed,
    );
    expect(group!.currentValue).toBe(100);
  });

  test("an account the archive holds nothing for never blocks the total", () => {
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
    expect(group!.children![1]!.status).toBe("inactive");
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

describe("a value older than the inactivity threshold is not a current one", () => {
  // NOW is 2026-09-18. 100 days before it is 2026-06-10.
  test("exactly the threshold is still current", () => {
    expect(valueIsStale("2026-06-10", NOW)).toBe(false);
  });

  test("one day past the threshold is not", () => {
    expect(valueIsStale("2026-06-09", NOW)).toBe(true);
  });

  test("today is current, and no date is nothing to judge", () => {
    expect(valueIsStale("2026-09-18", NOW)).toBe(false);
    expect(valueIsStale(null, NOW)).toBe(false);
  });

  test("an account whose balance is years old carries the flag, although the archive has a recent record", () => {
    // The reviewer's fixture: a 2019 balance with 2026 holdings activity.
    // The archive is right to report the balance, and the row is right to
    // read `no_feed` -- there is no feed link, and the archive has a recent
    // record. The figure itself is still seven years old, independently.
    const [group] = groupInstitutions(
      [
        record({
          currentValue: {
            value: { decimal: "900", currency: "USD" },
            asOf: "2019-01-31",
            source: "balance",
          },
        }),
      ],
      NOW,
    );
    const child = group!.children![0]!;
    expect(child.status).toBe("no_feed");
    expect(child.currentValue).toBe(900);
    expect(child.currentValueStale).toBe(true);
    // And the institution's own total, dated by that same figure.
    expect(group!.currentValueStale).toBe(true);
  });

  test("a recent figure carries no flag, on the account or the total", () => {
    const [group] = groupInstitutions(
      [
        record({
          currentValue: {
            value: { decimal: "900", currency: "USD" },
            asOf: "2026-08-31",
            source: "balance",
          },
        }),
      ],
      NOW,
    );
    expect(group!.children![0]!.currentValueStale).toBe(false);
    expect(group!.currentValueStale).toBe(false);
  });

  test("a total is judged by its oldest component, like its date", () => {
    const [group] = groupInstitutions(
      [
        record({
          currentValue: {
            value: { decimal: "100", currency: "USD" },
            asOf: "2026-08-31",
            source: "balance",
          },
        }),
        record({
          account: account({ accountId: "b" }),
          currentValue: {
            value: { decimal: "50", currency: "USD" },
            asOf: "2019-01-31",
            source: "balance",
          },
        }),
      ],
      NOW,
    );
    expect(group!.currentValue).toBe(150);
    expect(group!.currentValueAsOf).toBe("2019-01-31");
    expect(group!.currentValueStale).toBe(true);
  });
});

describe("inactive", () => {
  const child = (overrides: Record<string, unknown>) =>
    groupInstitutions([record(overrides)], NOW)[0]!.children![0]!;

  test("an account with no activity for a quarter has stopped, not fallen behind", () => {
    const quiet = child({
      latestSnapshotAsOf: "2022-10-31",
      activityTo: "2022-12-31",
    });
    expect(quiet.status).toBe("inactive");
    // The archive's own reason still names it dormant, for the drawer.
    expect(quiet.freshnessReason).toBe("dormant");
    // The Status column's own tooltip names the archive's last record.
    expect(quiet.statusDetail).toBe("no archive record since 2022-12-31");
  });

  test("recent activity with an old snapshot is not a Status problem: no feed is linked", () => {
    expect(
      child({ latestSnapshotAsOf: "2022-10-31", activityTo: "2026-09-10" })
        .status,
    ).toBe("no_feed");
  });

  test("an institution of only old and contentless accounts is inactive", () => {
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

  test("an archive-only group's status is the worst of its accounts, no_feed outranking inactive", () => {
    const [group] = groupInstitutions(
      [
        record(), // recent record, no feed link: no_feed
        record({
          account: account({ accountId: "b", displayLabel: "Dormant" }),
          activityTo: "2022-12-31",
          latestSnapshotAsOf: "2022-10-31",
        }), // years quiet: inactive
      ],
      NOW,
    );
    expect(group!.children!.map((child) => child.status)).toEqual([
      "no_feed",
      "inactive",
    ]);
    // An unlinked account with a recent archive record is more worth a look
    // than one gone quiet, so it outranks it for the header's own tag.
    expect(group!.status).toBe("no_feed");
    expect(group!.statusDetail).toBe("1 no feed, 1 inactive");
  });

  test("a quarterly account's quarter-end value does not make the total stale", () => {
    const [group] = groupInstitutions(
      [
        record({
          currentValue: {
            value: { decimal: "10", currency: "USD" },
            asOf: "2026-08-31",
            source: "balance",
          },
        }),
        record({
          account: account({ accountId: "b" }),
          activityTo: "2026-06-30",
          latestSnapshotAsOf: "2026-06-30",
          balanceDates: [
            "2026-06-30",
            "2026-03-31",
            "2025-12-31",
            "2025-09-30",
          ],
          latestBalanceHoldsSecurities: true,
          // The latest balance states no total, so the value is the older
          // quarter's.
          currentValue: {
            value: { decimal: "20", currency: "USD" },
            asOf: "2026-03-31",
            source: "balance",
          },
        }),
      ],
      NOW,
    );
    // 171 days old: past a monthly account's 100, inside a quarterly one's.
    expect(group!.children![1]!.cadence).toBe("quarterly");
    expect(group!.children![1]!.currentValueStale).toBe(false);
    expect(group!.currentValue).toBe(30);
    expect(group!.currentValueAsOf).toBe("2026-03-31");
    expect(group!.currentValueStale).toBe(false);
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
    expect(group!.status).toBe("inactive");
    expect(group!.children![0]!.empty).toBe(true);
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

describe("valuation and reconciliation warnings never reach this screen", () => {
  // These checks are real (`accountFreshness`'s `needs_review` branch, read
  // by the Needs Attention screen through a separate path), but the owner
  // retired them from Institutions. An unpriced holding or a failed
  // reconciliation must change nothing here: not the status, not its
  // tooltip, and not whether the account counts toward the total.
  test("a reconciliation failure does not become a status, and its wording never appears", () => {
    const value = {
      value: { decimal: "100", currency: "USD" },
      asOf: "2026-08-31",
      source: "balance",
    };
    const [group] = groupInstitutions(
      [
        record({
          account: account({ accountId: "review", displayLabel: "Review" }),
          latestSnapshotAsOf: "2026-04-30",
          balanceDates: ["2026-08-31"],
          latestBalanceHoldsSecurities: true,
          currentValue: value,
          latestHoldingsObservation: {
            asOf: "2026-08-31",
            sourceComplete: true,
            fullyValued: true,
            supportedValuationBasis: true,
            hasBlockingReview: false,
            reconciliation: "failed",
          },
        }),
      ],
      NOW,
    );
    const row = group!.children![0]!;
    expect(row.status).toBe("no_feed");
    expect(row.statusDetail).not.toContain("reconcile");
    expect(row.statusDetail).not.toContain("valuation");
    expect(row.currentValue).toBe(100);
  });

  test("a reviewed account still counts toward the group total and never widens the header's own status", () => {
    const value = (decimal: string) => ({
      value: { decimal, currency: "USD" },
      asOf: "2026-08-31",
      source: "balance",
    });
    const [group] = groupInstitutions(
      [
        record({
          account: account({ accountId: "quality-account" }),
          latestSnapshotAsOf: "2025-12-31",
          balanceDates: ["2026-08-31", "2026-07-31"],
          latestBalanceHoldsSecurities: true,
          currentValue: value("100"),
          latestHoldingsObservation: {
            asOf: "2026-08-31",
            sourceComplete: true,
            fullyValued: true,
            supportedValuationBasis: true,
            hasBlockingReview: false,
            reconciliation: "failed",
          },
        }),
        record({
          account: account({ accountId: "current-account" }),
          currentValue: value("200"),
        }),
      ],
      NOW,
    );
    expect(group!.status).toBe("no_feed");
    expect(group!.statusDetail).toBe("2 no feed");
    expect(group!.currentValue).toBe(300);
    expect(group!.latestHoldingsObservedAsOf).toBe("2026-08-31");
    expect(group!.children![0]!.latestSnapshotAsOf).toBe("2025-12-31");
  });
});

describe("feed values and status (mergeLiveAccounts)", () => {
  test("an archive account linked to a live Plaid account shows the feed's value, dated and sourced from it", () => {
    const [group] = groupInstitutions([record()], NOW);
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          currentBalance: 1234.56,
          balanceAsOf: "2026-09-17",
          balanceSource: "plaid",
        }),
      ],
      NOW,
    );
    const child = merged[0]!.children![0]!;
    expect(child.currentValue).toBe(1234.56);
    expect(child.currentValueAsOf).toBe("2026-09-17");
    expect(child.valueSource).toBe("feed");
    expect(child.status).toBe("fresh");
  });

  test("a fin_accounts row import-archive alone created is not a feed link: the archive value stands", () => {
    const [group] = groupInstitutions(
      [record({ currentValue: { value: { decimal: "500", currency: "USD" }, asOf: "2026-08-31", source: "balance" } })],
      NOW,
    );
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          plaidAccountId: null,
          currentBalance: 999,
          balanceAsOf: "2026-08-01",
          balanceSource: "archive",
        }),
      ],
      NOW,
    );
    const child = merged[0]!.children![0]!;
    expect(child.currentValue).toBe(500);
    expect(child.valueSource).toBe("statement");
    // Still no feed link, so the same archive-only rule as `groupInstitutions`
    // alone: a recent record with nothing linked reads `no_feed`.
    expect(child.status).toBe("no_feed");
  });

  test("a feed snapshot older than 2 days is stale", () => {
    const [group] = groupInstitutions([record()], NOW);
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          currentBalance: 100,
          balanceAsOf: "2026-09-10",
          balanceSource: "plaid",
        }),
      ],
      NOW,
    );
    const child = merged[0]!.children![0]!;
    expect(child.status).toBe("stale");
    expect(child.currentValueStale).toBe(true);
    expect(child.statusDetail).toContain("feed last updated 2026-09-10");
  });

  test("needs_relink wins over a fresh feed snapshot", () => {
    const [group] = groupInstitutions([record()], NOW);
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          currentBalance: 100,
          balanceAsOf: "2026-09-17",
          balanceSource: "plaid",
          needsRelinkAt: "2026-09-01T00:00:00Z",
        }),
      ],
      NOW,
    );
    expect(merged[0]!.children![0]!.status).toBe("needs_relink");
  });

  test("archive closed wins even over a fresh feed link", () => {
    const overrides = new Map([
      [
        "account-1",
        {
          displayName: null,
          accountLast4: null,
          accountType: null,
          closed: true,
        },
      ],
    ]) as never;
    const [group] = groupInstitutions([record()], NOW, overrides);
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          currentBalance: 100,
          balanceAsOf: "2026-09-17",
          balanceSource: "plaid",
        }),
      ],
      NOW,
    );
    expect(merged[0]!.children![0]!.status).toBe("inactive");
    expect(merged[0]!.children![0]!.statusDetail).toBe("marked closed");
  });

  test("linked but never pulled reads stale, and the archive value still shows", () => {
    const [group] = groupInstitutions(
      [record({ currentValue: { value: { decimal: "500", currency: "USD" }, asOf: "2026-08-31", source: "balance" } })],
      NOW,
    );
    const merged = mergeLiveAccounts(
      [group!],
      [finAccount({ archiveAccountId: "account-1" })],
      NOW,
    );
    const child = merged[0]!.children![0]!;
    expect(child.status).toBe("stale");
    expect(child.statusDetail).toBe("linked; no feed snapshot yet");
    expect(child.currentValue).toBe(500);
    expect(child.valueSource).toBe("statement");
  });

  test("an archive account unlinked and quiet for a year reads inactive, not no_feed", () => {
    const [group] = groupInstitutions(
      [record({ activityTo: "2022-12-31", latestSnapshotAsOf: "2022-10-31" })],
      NOW,
    );
    const merged = mergeLiveAccounts([group!], [], NOW);
    expect(merged[0]!.children![0]!.status).toBe("inactive");
  });

  test("a Plaid-only account with no archive counterpart gets its own row and is never hidden as empty", () => {
    const merged = mergeLiveAccounts(
      [],
      [
        finAccount({
          accountId: "fin-vanguard",
          institutionName: "Vanguard",
          accountName: "Roth IRA",
          currentBalance: 42000,
          balanceAsOf: "2026-09-17",
          balanceSource: "plaid",
        }),
      ],
      NOW,
    );
    expect(merged).toHaveLength(1);
    const child = merged[0]!.children![0]!;
    expect(child.institutionName).toBe("Vanguard");
    expect(child.currentValue).toBe(42000);
    expect(child.valueSource).toBe("feed");
    expect(child.status).toBe("fresh");
    expect(child.empty).toBe(false);
  });

  test("the institution header sums the feed-updated value and takes the worst child status", () => {
    const [group] = groupInstitutions(
      [
        record(),
        record({
          account: account({ accountId: "b" }),
          currentValue: {
            value: { decimal: "10", currency: "USD" },
            asOf: "2026-08-31",
            source: "balance",
          },
        }),
      ],
      NOW,
    );
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          currentBalance: 90,
          currency: "USD",
          balanceAsOf: "2026-09-17",
          balanceSource: "plaid",
          needsRelinkAt: "2026-09-01T00:00:00Z",
        }),
      ],
      NOW,
    );
    const [header] = merged;
    // account-1 gets a feed value (90) but needs relinking; "b" keeps its
    // archive value (10) and is unlinked (no_feed). The header sums both
    // and reports the worse of the two statuses.
    expect(header!.currentValue).toBe(100);
    expect(header!.status).toBe("needs_relink");
    expect(header!.statusDetail).toBe("1 needs relink, 1 no feed");
  });

  test("Holdings as of follows the feed once linked, when the feed has a holdings snapshot", () => {
    const [group] = groupInstitutions(
      [record({ latestSnapshotAsOf: "2025-01-31" })],
      NOW,
    );
    const merged = mergeLiveAccounts(
      [group!],
      [
        finAccount({
          archiveAccountId: "account-1",
          holdingsValue: 300,
          holdingsAsOf: "2026-09-16",
          holdingsSource: "plaid",
        }),
      ],
      NOW,
    );
    const child = merged[0]!.children![0]!;
    expect(child.latestHoldingsObservedAsOf).toBe("2026-09-16");
    expect(merged[0]!.latestHoldingsObservedAsOf).toBe("2026-09-16");
  });
});
