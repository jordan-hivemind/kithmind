// One table of cases, two implementations of the same rule.
//
// The importer decides whether a GBP sheet row's stated USD amount agrees with
// `amount * rate` (`checkRate` in `investment-import.ts`). The matcher decides
// whether a USD document's amount is the same money as a GBP entry
// (`amountMatches` in `packages/kith-store/src/admin/linkScoring.ts`). It is
// ONE rule -- the larger of 1% or $1.00, the owner's decision of 2026-09-19 --
// written twice, because the importer is loaded into the browser bundle and
// cannot import `@repo/kith-store` (see the note at the head of
// `investment-schemas.ts`, where that import once broke the build).
//
// Two copies of a money rule drift. This test is what stops them: every case
// below is run through both, and the answers must agree. A capital call the
// importer accepts and the matcher refuses -- or the reverse -- is a
// disagreement about the owner's money that nothing else in the repository
// would notice.

import {
  amountMatches,
  RATE_TOLERANCE_FLOOR_CENTS,
  RATE_TOLERANCE_FRACTION,
  rateToleranceCents,
} from "@repo/kith-store/admin";
import { describe, expect, it } from "vitest";

import { checkRate, multiplyDecimals } from "@/lib/kith/investment-import";

/**
 * Synthetic. Each case is a GBP amount, its rate to USD, and a USD figure
 * that either agrees with the conversion or does not.
 *
 * The boundaries are the point. `10000.00 * 1.2734` is `12734.00`, and the
 * tolerance is 1% of the STATED figure rather than of the converted one, so
 * the two edges are not symmetric about it: `12862.62` and `12607.93` are the
 * last values either side that agree. The small amounts exercise the $1.00
 * floor, where 1% is less than a dollar and the floor is what decides.
 */
const CASES: ReadonlyArray<{
  why: string;
  gbp: string;
  rate: string;
  statedUsd: string;
}> = [
  { why: "exact", gbp: "10000.00", rate: "1.2734", statedUsd: "12734.00" },
  { why: "one cent inside", gbp: "10000.00", rate: "1.2734", statedUsd: "12734.01" },
  { why: "at the 1% edge, above", gbp: "10000.00", rate: "1.2734", statedUsd: "12862.62" },
  { why: "one cent past it", gbp: "10000.00", rate: "1.2734", statedUsd: "12862.63" },
  { why: "at the 1% edge, below", gbp: "10000.00", rate: "1.2734", statedUsd: "12607.93" },
  { why: "one cent past it, below", gbp: "10000.00", rate: "1.2734", statedUsd: "12607.92" },
  { why: "far off", gbp: "10000.00", rate: "1.2734", statedUsd: "13000.00" },
  // Under $100 converted, 1% is under a dollar and the floor decides.
  { why: "floor, exact", gbp: "40.00", rate: "1.25", statedUsd: "50.00" },
  { why: "floor, at the edge", gbp: "40.00", rate: "1.25", statedUsd: "51.00" },
  { why: "floor, one cent past", gbp: "40.00", rate: "1.25", statedUsd: "51.01" },
  { why: "floor, at the edge below", gbp: "40.00", rate: "1.25", statedUsd: "49.00" },
  { why: "floor, one cent past below", gbp: "40.00", rate: "1.25", statedUsd: "48.99" },
  // Exactly at the crossover: 1% of $100.00 is $1.00, the floor itself.
  { why: "crossover", gbp: "80.00", rate: "1.25", statedUsd: "101.01" },
  { why: "crossover, one cent past", gbp: "80.00", rate: "1.25", statedUsd: "101.02" },
  // A rate with more decimal places than money has.
  { why: "long rate", gbp: "3333.33", rate: "1.2718293746", statedUsd: "4239.53" },
  { why: "long rate, off", gbp: "3333.33", rate: "1.2718293746", statedUsd: "4500.00" },
];

describe("the cross-currency tolerance, in both implementations", () => {
  it("is the same two constants on both sides", () => {
    expect(RATE_TOLERANCE_FRACTION).toBe(100n);
    expect(RATE_TOLERANCE_FLOOR_CENTS).toBe(100n);
    expect(rateToleranceCents(5_000n)).toBe(100n);
    expect(rateToleranceCents(100_000n)).toBe(1_000n);
  });

  it.each(CASES)(
    "agrees on $gbp GBP at $rate against $statedUsd USD ($why)",
    ({ gbp, rate, statedUsd }) => {
      // The importer: does the sheet's own USD column agree with the rate?
      const importerAccepts = !checkRate(
        statedUsd,
        multiplyDecimals(gbp, rate),
      ).suspect;
      // The matcher: is the document's USD amount this GBP entry's money?
      const matcherAccepts = amountMatches({
        documentAmount: statedUsd,
        documentCurrency: "USD",
        entryAmount: gbp,
        entryCurrency: "GBP",
        entryExchangeRate: rate,
      }).matched;
      expect(matcherAccepts).toBe(importerAccepts);
    },
  );

  it("covers both answers, so agreement is not agreement on one of them", () => {
    const answers = new Set(
      CASES.map(
        ({ gbp, rate, statedUsd }) =>
          !checkRate(statedUsd, multiplyDecimals(gbp, rate)).suspect,
      ),
    );
    expect([...answers].sort()).toEqual([false, true]);
  });
});
