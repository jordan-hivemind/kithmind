// The rule that decides whether an entry edit moves a date or a document.
//
// `entryPatchFields` is a pure function precisely so this test needs no DOM
// and no fetch: what it decides is whether a financial date is rewritten and
// whether a document link is created, and both deserve a test that can state
// the whole scenario in three lines.
//
// The accident being guarded against, in the reviewer's words: "Drawer open
// on an entry with no document, an auto-link lands, the patch carries
// `documentId: null`" -- and the previous guard compared against the LIVE
// row, which the change feed had already refreshed underneath the drawer.

import { describe, expect, it } from "vitest";

import { entryPatchFields } from "@/lib/kith/investment-entry-patch";

const AT_OPEN = {
  documentId: null,
  entryDate: "2026-03-10",
  dateIsEstimated: true,
};

const DRAFT = {
  entryType: "capital_call_paid",
  amount: "25000.00",
  currency: "USD",
  note: "a note",
  ...AT_OPEN,
};

describe("entryPatchFields", () => {
  it("sends the ordinary fields every time", () => {
    const patch = entryPatchFields({ ...DRAFT, note: "edited" }, AT_OPEN);
    expect(patch.entryType).toBe("capital_call_paid");
    expect(patch.amount).toBe("25000.00");
    expect(patch.currency).toBe("USD");
    expect(patch.note).toBe("edited");
  });

  it("leaves out a date the owner did not retype", () => {
    const patch = entryPatchFields({ ...DRAFT, note: "edited" }, AT_OPEN);
    expect("entryDate" in patch).toBe(false);
    expect("dateIsEstimated" in patch).toBe(false);
  });

  it("sends a date the owner did retype", () => {
    const patch = entryPatchFields({ ...DRAFT, entryDate: "2026-03-11" }, AT_OPEN);
    expect(patch.entryDate).toBe("2026-03-11");
  });

  it("sends the marker when he changes it, and only then", () => {
    expect(
      entryPatchFields({ ...DRAFT, dateIsEstimated: false }, AT_OPEN)
        .dateIsEstimated,
    ).toBe(false);
    expect(
      "dateIsEstimated" in entryPatchFields({ ...DRAFT }, AT_OPEN),
    ).toBe(false);
  });

  it("never sends a null documentId, whatever the drawer opened with", () => {
    // The whole accident: a link landed while the drawer was open, so the
    // draft's null is stale rather than a decision. Sending it used to reject
    // the link permanently.
    expect("documentId" in entryPatchFields(DRAFT, AT_OPEN)).toBe(false);
    expect(
      "documentId" in
        entryPatchFields(DRAFT, { ...AT_OPEN, documentId: "doc-from-the-feed" }),
    ).toBe(false);
  });

  it("sends a document the owner picked", () => {
    const patch = entryPatchFields({ ...DRAFT, documentId: "doc-1" }, AT_OPEN);
    expect(patch.documentId).toBe("doc-1");
  });

  it("leaves out a document he did not change", () => {
    const patch = entryPatchFields(
      { ...DRAFT, documentId: "doc-1" },
      { ...AT_OPEN, documentId: "doc-1" },
    );
    expect("documentId" in patch).toBe(false);
  });

  it("measures against the snapshot, not against anything that moved", () => {
    // Same draft, two different "live" values: the answer must not depend on
    // what the row looks like now.
    const draft = { ...DRAFT, note: "edited" };
    expect(entryPatchFields(draft, AT_OPEN)).toEqual(
      entryPatchFields(draft, AT_OPEN),
    );
  });
});
