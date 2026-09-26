// The commitment is edited as a property of the investment and stored as its
// `commitment` entry. `commitmentWrite` decides the one entry write that makes
// the stored amount match the drawer, and must never guess when the stored
// commitment is more than one row.

import { describe, expect, it } from "vitest";

import { commitmentEntry, commitmentWrite } from "./investment-commitment";

const base = {
  id: "e1",
  entryType: "commitment" as const,
  amount: "25000.00",
  currency: "USD",
  dateIsEstimated: true,
  entryDate: "2026-09-08",
};
const call = { ...base, id: "e2", entryType: "capital_call_paid" as const };

describe("commitmentWrite", () => {
  it("does nothing when the amount is unchanged, however it is written", () => {
    expect(
      commitmentWrite({
        entries: [{ ...base, dateIsEstimated: false }, call],
        amount: "25000",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      }),
    ).toBeNull();
  });

  it("changes the amount of the one commitment entry", () => {
    expect(
      commitmentWrite({
        entries: [{ ...base, dateIsEstimated: false }],
        amount: "30000",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      }),
    ).toEqual({ method: "PATCH", body: { entryId: "e1", amount: "30000" } });
  });

  it("moves an estimated date to a known signed date", () => {
    expect(
      commitmentWrite({
        entries: [base],
        amount: "25000.00",
        currency: "USD",
        signedOn: "2026-03-01",
        today: "2026-09-26",
      }),
    ).toEqual({
      method: "PATCH",
      body: { entryId: "e1", entryDate: "2026-03-01", dateIsEstimated: false },
    });
  });

  it("never moves a date the owner stated", () => {
    expect(
      commitmentWrite({
        entries: [{ ...base, dateIsEstimated: false }],
        amount: "25000.00",
        currency: "USD",
        signedOn: "2026-03-01",
        today: "2026-09-26",
      }),
    ).toBeNull();
  });

  it("creates a commitment dated the signed date, else today as estimated", () => {
    expect(
      commitmentWrite({
        entries: [call],
        amount: "10000",
        currency: "USD",
        signedOn: "2026-03-01",
        today: "2026-09-26",
      }),
    ).toEqual({
      method: "POST",
      body: {
        entryType: "commitment",
        entryDate: "2026-03-01",
        amount: "10000",
        currency: "USD",
        dateIsEstimated: false,
      },
    });
    expect(
      commitmentWrite({
        entries: [],
        amount: "10000",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      })?.body,
    ).toMatchObject({ entryDate: "2026-09-26", dateIsEstimated: true });
  });

  it("deletes the commitment when the amount is cleared, and creates nothing from blank", () => {
    expect(
      commitmentWrite({
        entries: [base],
        amount: " ",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      }),
    ).toEqual({ method: "DELETE", body: { entryId: "e1" } });
    expect(
      commitmentWrite({
        entries: [],
        amount: "",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      }),
    ).toBeNull();
  });

  it("refuses to pick one of several commitment entries", () => {
    const entries = [base, { ...base, id: "e3" }];
    expect(commitmentEntry(entries)).toBeNull();
    expect(
      commitmentWrite({
        entries,
        amount: "1",
        currency: "USD",
        signedOn: null,
        today: "2026-09-26",
      }),
    ).toBeNull();
  });
});
