// FIN-FRESHNESS-1: the cadence-aware account freshness model. Synthetic dates
// only; every case names the pattern it stands for.

import { describe, expect, test } from "vitest";

import {
  accountFreshness,
  type AccountFreshnessInput,
  addDays,
  dormantAfterDays,
  inferCadence,
  nextPeriodEnd,
  valueIsStale,
} from "@/lib/kith/account-freshness";
import { groupInstitutions } from "@/lib/kith/institutions";

const at = (date: string, time = "12:00:00") => Date.parse(`${date}T${time}Z`);
const NOW = at("2026-09-18");

function input(
  overrides: Partial<AccountFreshnessInput> = {},
): AccountFreshnessInput {
  return {
    hasContent: true,
    closed: false,
    accountType: "brokerage",
    activityTo: "2026-09-10",
    latestSnapshotAsOf: "2026-08-31",
    balanceDates: ["2026-08-31", "2026-07-31", "2026-06-30"],
    latestBalanceHoldsSecurities: true,
    ...overrides,
  };
}

describe("period ends", () => {
  test("a month end is followed by the next month's end, leap years included", () => {
    expect(nextPeriodEnd("2024-01-31", "monthly")).toBe("2024-02-29");
    expect(nextPeriodEnd("2023-01-31", "monthly")).toBe("2023-02-28");
    expect(nextPeriodEnd("2024-02-29", "monthly")).toBe("2024-03-31");
    expect(nextPeriodEnd("2100-01-31", "monthly")).toBe("2100-02-28");
    expect(nextPeriodEnd("2000-01-31", "monthly")).toBe("2000-02-29");
  });

  test("a mid-month date is followed by its own month's end", () => {
    expect(nextPeriodEnd("2024-02-28", "monthly")).toBe("2024-02-29");
    expect(nextPeriodEnd("2026-08-15", "monthly")).toBe("2026-08-31");
  });

  test("year end rolls into January, and quarters into the next year", () => {
    expect(nextPeriodEnd("2025-12-31", "monthly")).toBe("2026-01-31");
    expect(nextPeriodEnd("2025-12-31", "quarterly")).toBe("2026-03-31");
    expect(nextPeriodEnd("2025-11-30", "quarterly")).toBe("2025-12-31");
    expect(nextPeriodEnd("2025-10-15", "quarterly")).toBe("2025-12-31");
    expect(nextPeriodEnd("2026-01-31", "quarterly")).toBe("2026-03-31");
  });

  test("an unknown cadence is held to the monthly period", () => {
    expect(nextPeriodEnd("2026-06-30", "unknown")).toBe("2026-07-31");
  });

  test("grace crosses month and year boundaries", () => {
    expect(addDays("2025-12-31", 20)).toBe("2026-01-20");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
  });
});

describe("cadence from the archive's own balance dates", () => {
  test("consecutive month ends are monthly, across a year end", () => {
    expect(inferCadence(["2026-01-31", "2025-12-31", "2025-11-30"])).toBe(
      "monthly",
    );
  });

  test("quarter ends only are quarterly", () => {
    expect(
      inferCadence(["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"]),
    ).toBe("quarterly");
  });

  test("two quarter ends are not enough to infer a permissive cadence", () => {
    expect(inferCadence(["2026-06-30", "2026-03-31"])).toBe("unknown");
    expect(inferCadence(["2026-06-30", "2026-03-31", "2025-12-31"])).toBe(
      "unknown",
    );
  });

  test("monthly while active and quarterly while quiet is quarterly", () => {
    expect(
      inferCadence([
        "2026-06-30",
        "2026-04-30",
        "2026-03-31",
        "2025-12-31",
        "2025-09-30",
        "2025-06-30",
        "2025-05-31",
      ]),
    ).toBe("quarterly");
  });

  test("two dates in one month count once", () => {
    expect(inferCadence(["2026-08-31", "2026-08-15", "2026-07-31"])).toBe(
      "monthly",
    );
  });

  test("one missed monthly statement does not teach a quarterly cadence", () => {
    expect(
      inferCadence([
        "2026-06-30",
        "2026-05-31",
        "2026-03-31",
        "2026-02-28",
        "2026-01-31",
      ]),
    ).toBe("unknown");
  });

  test("fewer than two months, a long gap, or a gap ending off a quarter is unknown", () => {
    expect(inferCadence([])).toBe("unknown");
    expect(inferCadence(["2026-08-31"])).toBe("unknown");
    expect(inferCadence(["2026-08-31", "2026-08-01"])).toBe("unknown");
    expect(inferCadence(["2026-06-30", "2026-02-28"])).toBe("unknown");
    expect(inferCadence(["2026-05-31", "2026-03-31"])).toBe("unknown");
  });

  test("only the recent window counts: an old irregular gap does not", () => {
    expect(
      inferCadence([
        "2026-08-31",
        "2026-07-31",
        "2026-06-30",
        "2026-05-31",
        "2026-04-30",
        "2026-03-31",
        "2026-02-28",
        "2024-01-31",
      ]),
    ).toBe("monthly");
  });
});

describe("statements: monthly", () => {
  test("the last day of grace is fresh and the next day is stale", () => {
    const monthly = input({
      activityTo: "2026-07-31",
      latestSnapshotAsOf: "2026-07-31",
      balanceDates: ["2026-07-31", "2026-06-30"],
    });
    // 2026-07-31 -> next 2026-08-31 -> overdue after 2026-09-20.
    const onTime = accountFreshness(monthly, at("2026-09-20", "23:59:59"));
    expect(onTime.status).toBe("fresh");
    expect(onTime.expectedBy).toBe("2026-09-20");
    const late = accountFreshness(monthly, at("2026-09-21", "00:00:00"));
    expect(late.status).toBe("stale");
    expect(late.reason).toBe("statement_overdue");
    expect(late.statusDetail).toMatch(
      /next was expected by 2026-09-20 \(monthly\)/,
    );
  });

  test("a year-end statement is due in January", () => {
    const yearEnd = input({
      activityTo: "2025-12-31",
      latestSnapshotAsOf: "2025-12-31",
      balanceDates: ["2025-12-31", "2025-11-30"],
    });
    expect(accountFreshness(yearEnd, at("2026-02-19")).status).toBe("fresh");
    expect(accountFreshness(yearEnd, at("2026-02-20")).expectedBy).toBe(
      "2026-02-20",
    );
    expect(accountFreshness(yearEnd, at("2026-02-21")).reason).toBe(
      "statement_overdue",
    );
  });

  test("a January statement in a leap year is due after February 29", () => {
    const leap = input({
      activityTo: "2024-01-31",
      latestSnapshotAsOf: "2024-01-31",
      balanceDates: ["2024-01-31", "2023-12-31"],
    });
    expect(accountFreshness(leap, at("2024-03-20")).expectedBy).toBe(
      "2024-03-20",
    );
    expect(accountFreshness(leap, at("2024-03-20")).status).toBe("fresh");
    expect(accountFreshness(leap, at("2024-03-21")).status).toBe("stale");
  });
});

describe("statements: quarterly", () => {
  const quarterly = input({
    activityTo: "2026-06-30",
    latestSnapshotAsOf: "2026-06-30",
    balanceDates: ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"],
  });

  test("a quiet quarterly account is fresh until its quarter end plus grace", () => {
    const fresh = accountFreshness(quarterly, NOW);
    expect(fresh.status).toBe("fresh");
    expect(fresh.cadence).toBe("quarterly");
    expect(fresh.expectedBy).toBe("2026-10-20");
    expect(accountFreshness(quarterly, at("2026-10-20")).status).toBe("fresh");
    const late = accountFreshness(quarterly, at("2026-10-21"));
    expect(late.status).toBe("stale");
    expect(late.reason).toBe("statement_overdue");
  });

  test("a missed quarter becomes dormant only after two quarters and grace", () => {
    expect(dormantAfterDays("quarterly")).toBe(204);
    const days = (n: number) => at(addDays("2026-06-30", n));
    expect(accountFreshness(quarterly, days(204)).status).toBe("stale");
    expect(accountFreshness(quarterly, days(205)).status).toBe("inactive");
  });
});

describe("unknown cadence", () => {
  test("one balance is held to the monthly allowance and says so", () => {
    const single = input({
      activityTo: "2026-06-30",
      latestSnapshotAsOf: "2026-06-30",
      balanceDates: ["2026-06-30"],
    });
    const judged = accountFreshness(single, NOW);
    expect(judged.cadence).toBe("unknown");
    expect(judged.status).toBe("stale");
    expect(judged.statusDetail).toMatch(/cadence unknown/);
  });

  test("recent activity cannot turn a missed monthly import into quarterly", () => {
    const interrupted = input({
      activityTo: "2026-09-10",
      latestSnapshotAsOf: "2026-06-30",
      balanceDates: [
        "2026-06-30",
        "2026-05-31",
        "2026-03-31",
        "2026-02-28",
        "2026-01-31",
      ],
    });
    const judged = accountFreshness(interrupted, at("2026-09-21"));
    expect(judged).toMatchObject({
      cadence: "unknown",
      status: "stale",
      reason: "statement_overdue",
      expectedBy: "2026-08-20",
    });
  });
});

describe("dormant and closed", () => {
  test("a monthly account quiet exactly 100 days is not dormant; 101 is", () => {
    const quiet = (days: number) =>
      accountFreshness(
        input({
          activityTo: addDays("2026-09-18", -days),
          latestSnapshotAsOf: addDays("2026-09-18", -days),
          balanceDates: [addDays("2026-09-18", -days)],
        }),
        NOW,
      );
    expect(quiet(100).status).not.toBe("inactive");
    expect(quiet(101).status).toBe("inactive");
    expect(quiet(101).reason).toBe("dormant");
  });

  test("closed comes only from the owner, whatever the dates say", () => {
    const judged = accountFreshness(input({ closed: true }), NOW);
    expect(judged).toMatchObject({ status: "inactive", reason: "closed" });
  });

  test("a nominal all-cash balance is not closed, dormant or stale", () => {
    // A penny left in a quarterly account: live, balance-only.
    const penny = accountFreshness(
      input({
        activityTo: "2026-06-30",
        latestSnapshotAsOf: "2025-04-30",
        balanceDates: [
          "2026-06-30",
          "2026-04-30",
          "2026-03-31",
          "2025-12-31",
          "2025-09-30",
        ],
        latestBalanceHoldsSecurities: false,
      }),
      NOW,
    );
    expect(penny).toMatchObject({
      status: "fresh",
      reason: "balance_only",
      cadence: "quarterly",
    });
  });

  test("nothing held is empty", () => {
    expect(accountFreshness(input({ hasContent: false }), NOW).status).toBe(
      "empty",
    );
  });
});

describe("balances against holdings", () => {
  test("current balances with holdings a year behind is stale, and says both dates", () => {
    const judged = accountFreshness(
      input({ latestSnapshotAsOf: "2025-09-30" }),
      NOW,
    );
    expect(judged.status).toBe("stale");
    expect(judged.reason).toBe("holdings_behind");
    expect(judged.statusDetail).toBe(
      "statement balance current to 2026-08-31; holdings last recorded 2025-09-30",
    );
  });

  test("holdings one statement behind but inside grace are not flagged", () => {
    const judged = accountFreshness(
      input({ latestSnapshotAsOf: "2026-07-31" }),
      NOW,
    );
    expect(judged.status).toBe("fresh");
    expect(judged.reason).toBe("current");
  });

  test("recent activity and a securities balance with no holdings ever recorded is stale", () => {
    const judged = accountFreshness(input({ latestSnapshotAsOf: null }), NOW);
    expect(judged).toMatchObject({
      status: "stale",
      reason: "holdings_missing",
    });
  });

  test("an all-cash latest balance expects no holdings, however old the last snapshot", () => {
    const judged = accountFreshness(
      input({
        latestSnapshotAsOf: "2024-01-31",
        latestBalanceHoldsSecurities: false,
      }),
      NOW,
    );
    expect(judged).toMatchObject({ status: "fresh", reason: "balance_only" });
  });

  test("a cash-type account expects no holdings", () => {
    for (const accountType of ["bank", "credit_line", "mortgage", "Checking"]) {
      const judged = accountFreshness(
        input({
          accountType,
          latestSnapshotAsOf: null,
          latestBalanceHoldsSecurities: null,
        }),
        NOW,
      );
      expect(judged.reason).toBe("balance_only");
    }
  });

  test("an unstated holds-securities flag with an old snapshot still flags holdings", () => {
    const judged = accountFreshness(
      input({
        latestSnapshotAsOf: "2025-09-30",
        latestBalanceHoldsSecurities: null,
      }),
      NOW,
    );
    expect(judged.reason).toBe("holdings_behind");
  });

  test("transactions only, no balance or snapshot, is fresh with nothing to hold it to", () => {
    const judged = accountFreshness(
      input({
        balanceDates: [],
        latestSnapshotAsOf: null,
        latestBalanceHoldsSecurities: null,
      }),
      NOW,
    );
    expect(judged).toMatchObject({
      status: "fresh",
      reason: "no_balance",
      expectedBy: null,
    });
    expect(judged.statusDetail).toBe(
      "no statement balance recorded; activity through 2026-09-10",
    );
  });

  test("no balance but an old snapshot is holdings behind", () => {
    const judged = accountFreshness(
      input({
        balanceDates: [],
        latestSnapshotAsOf: "2026-06-30",
        latestBalanceHoldsSecurities: null,
      }),
      NOW,
    );
    expect(judged.reason).toBe("holdings_behind");
  });
});

describe("value staleness follows the cadence", () => {
  test("monthly and unknown allow 100 days, quarterly 204", () => {
    expect(valueIsStale(addDays("2026-09-18", -100), NOW)).toBe(false);
    expect(valueIsStale(addDays("2026-09-18", -101), NOW)).toBe(true);
    expect(valueIsStale(addDays("2026-09-18", -101), NOW, "unknown")).toBe(
      true,
    );
    expect(valueIsStale(addDays("2026-09-18", -204), NOW, "quarterly")).toBe(
      false,
    );
    expect(valueIsStale(addDays("2026-09-18", -205), NOW, "quarterly")).toBe(
      true,
    );
  });
});

describe("identity and display never change freshness", () => {
  const record = (account: Record<string, unknown>) =>
    ({
      account: {
        accountId: "account-1",
        sourceId: "source-1",
        institutionName: "Example Broker",
        disclosures: [],
        ...account,
      },
      statementCount: 4,
      recordCount: 40,
      activityFrom: "2025-01-02",
      activityTo: "2026-06-30",
      latestSnapshotAsOf: "2026-06-30",
      balanceDates: ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"],
      latestBalanceHoldsSecurities: true,
      openReviewCount: 0,
    }) as never;

  test("a missing last four, an alias label or an owner rename give the same status", () => {
    const plain = groupInstitutions([record({ accountLast4: "1234" })], NOW)[0]!
      .children![0]!;
    const noLast4 = groupInstitutions(
      [
        record({
          disclosures: [{ field: "accountLast4", reason: "ambiguous_aliases" }],
        }),
      ],
      NOW,
    )[0]!.children![0]!;
    const renamed = groupInstitutions(
      [record({ displayLabel: "Investments: BDA" })],
      NOW,
      new Map([
        [
          "account-1",
          {
            displayName: "Quarterly IRA",
            accountLast4: "9999",
            accountType: null,
            closed: false,
          },
        ],
      ]),
    )[0]!.children![0]!;
    for (const row of [plain, noLast4, renamed]) {
      expect(row).toMatchObject({
        status: "fresh",
        freshnessReason: "current",
        cadence: "quarterly",
        expectedBy: "2026-10-20",
      });
    }
    expect(noLast4.accountLast4).toBeNull();
    expect(noLast4.last4Reason).toMatch(/conflicting numbers/);
    expect(renamed.id).toBe("account-1");
  });

  test("an owner-set cash type expects no holdings", () => {
    const row = groupInstitutions(
      [record({})],
      NOW,
      new Map([
        [
          "account-1",
          {
            displayName: null,
            accountLast4: null,
            accountType: "bank",
            closed: false,
          },
        ],
      ]),
    )[0]!.children![0]!;
    expect(row.freshnessReason).toBe("balance_only");
  });
});

describe("observed holdings quality stays separate from statement age", () => {
  const observation = {
    asOf: "2026-08-31",
    sourceComplete: true,
    fullyValued: true,
    supportedValuationBasis: true,
    hasBlockingReview: false,
    reconciliation: "no_issue_recorded" as const,
  };
  test("current complete holdings with unreconciled trades need review, not an overdue label", () => {
    const result = accountFreshness(
      input({
        latestSnapshotAsOf: "2025-12-31",
        latestHoldingsObservation: { ...observation, reconciliation: "failed" },
      }),
      NOW,
    );
    expect(result.status).toBe("needs_review");
    expect(result.reason).toBe("reconciliation_failed");
    expect(result.statusDetail).toContain(
      "historical trade quantities do not reconcile",
    );
    expect(result.statusDetail).toContain("last verified snapshot 2025-12-31");
  });
  test.each([
    [{ sourceComplete: false }, "holdings_incomplete"],
    [{ fullyValued: false, sourceComplete: false }, "valuation_incomplete"],
    [{ supportedValuationBasis: false }, "valuation_unsupported"],
    [{ hasBlockingReview: true }, "review_open"],
    [{ reconciliation: "pending" as const }, "reconciliation_pending"],
  ] as const)(
    "current incomplete data never becomes fresh: %s",
    (changed, reason) => {
      const result = accountFreshness(
        input({
          latestSnapshotAsOf: null,
          latestHoldingsObservation: { ...observation, ...changed },
        }),
        NOW,
      );
      expect(result.status).toBe("needs_review");
      expect(result.reason).toBe(reason);
    },
  );
  test("overdue statements remain stale even with quality diagnostics", () => {
    const result = accountFreshness(
      input({
        latestSnapshotAsOf: "2026-05-31",
        balanceDates: ["2026-06-30", "2026-05-31"],
        latestHoldingsObservation: {
          ...observation,
          asOf: "2026-06-30",
          fullyValued: false,
        },
      }),
      NOW,
    );
    expect(result.status).toBe("stale");
    expect(result.reason).toBe("statement_overdue");
  });
  test("an old partial holdings observation cannot hide missing newer holdings", () => {
    const result = accountFreshness(
      input({
        latestSnapshotAsOf: null,
        latestHoldingsObservation: {
          ...observation,
          asOf: "2026-04-30",
          sourceComplete: false,
        },
      }),
      NOW,
    );
    expect(result.status).toBe("stale");
    expect(result.reason).toBe("holdings_behind");
  });
  test.each([
    { accountType: "bank", latestBalanceHoldsSecurities: false },
    { accountType: "brokerage", latestBalanceHoldsSecurities: false },
    { accountType: "bank", balanceDates: [] },
    { hasContent: false, activityTo: "2024-01-01", balanceDates: [] },
  ])(
    "a current partial observation remains visible despite cash type or old activity: %s",
    (overrides) => {
      const value = input({
        ...overrides,
        latestSnapshotAsOf: null,
        latestHoldingsObservation: {
          ...observation,
          sourceComplete: false,
          fullyValued: false,
        },
      });
      expect(accountFreshness(value, NOW).status).toBe("needs_review");
      expect(accountFreshness({ ...value, closed: true }, NOW).reason).toBe(
        "closed",
      );
    },
  );
  test("a newer all-cash statement supersedes older partial holdings for cadence", () => {
    const result = accountFreshness(
      input({
        latestBalanceHoldsSecurities: false,
        latestHoldingsObservation: {
          ...observation,
          asOf: "2026-07-31",
          fullyValued: false,
        },
      }),
      NOW,
    );
    expect(result.status).toBe("fresh");
    expect(result.reason).toBe("balance_only");
  });
  test("legacy rows keep their existing status when assessment is absent", () => {
    expect(
      accountFreshness(input({ latestSnapshotAsOf: "2025-12-31" }), NOW).status,
    ).toBe("stale");
  });
  test("current holdings without a balance still retain their quality warning", () => {
    const result = accountFreshness(
      input({
        balanceDates: [],
        latestBalanceHoldsSecurities: null,
        latestSnapshotAsOf: null,
        latestHoldingsObservation: { ...observation, fullyValued: false },
      }),
      NOW,
    );
    expect(result.status).toBe("needs_review");
  });
});
