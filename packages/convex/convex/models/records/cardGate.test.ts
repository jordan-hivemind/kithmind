import { describe, expect, test } from "vitest";

import {
  CARD_GATE_VERSION,
  gateCard,
  type CardGateCandidate,
  type CardGateReport,
} from "./cardGate";

// Synthetic fixtures only. Nothing here describes a real document, and no
// test in this file calls a model: the gate is the whole subject.

function codeOf(report: CardGateReport, key: string): string | "pass" {
  const result = report.results.find((entry) => entry.key === key);
  if (!result) throw new Error(`no gate result for ${key}`);
  return result.status === "pass" ? "pass" : result.code;
}

function field(
  name: string,
  value: CardGateCandidate["value"],
  spanText: string,
  extra: Partial<CardGateCandidate> = {},
): CardGateCandidate {
  return { field: name, value, spanTexts: [spanText], ...extra };
}

/** The four required fields of a SAFE card, all correct. */
function safeNoteBase(): CardGateCandidate[] {
  return [
    field(
      "company",
      { type: "text", value: "Northwind Supply" },
      "between Northwind Supply and the investor",
    ),
    field(
      "investor_entity",
      { type: "text", value: "Acme Research" },
      "Acme Research",
    ),
    field(
      "instrument_date",
      { type: "date", value: "2025-03-04" },
      "2025-03-04",
    ),
    field(
      "principal_amount",
      { type: "money", amount: "250000", currency: "USD" },
      "$250,000.00",
    ),
  ];
}

function gateSafeNote(...extra: CardGateCandidate[]): CardGateReport {
  return gateCard({
    recordKind: "safe_note_card",
    fields: [...safeNoteBase(), ...extra],
  });
}

describe("card evidence gate", () => {
  test("a correct card passes every field with no model in the loop", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field(
          "card_title",
          { type: "text", value: "Mutual Non-Disclosure Agreement" },
          "Mutual Non-Disclosure Agreement",
        ),
        field("card_date", { type: "date", value: "2025-03-04" }, "2025-03-04"),
        field(
          "card_summary",
          { type: "text", value: "both sides keep it confidential" },
          "both sides keep it confidential",
        ),
        {
          field: "card_party",
          ordinal: 0,
          value: { type: "text", value: "Acme Research" },
          spanTexts: ["between Acme Research and the other side"],
        },
      ],
    });
    expect(report.failed).toEqual([]);
    expect(report.requiredFailed).toBe(false);
    expect(report.passedKeys.sort()).toEqual([
      "card_date",
      "card_party:0",
      "card_summary",
      "card_title",
    ]);
    expect(report.gateVersion).toBe(CARD_GATE_VERSION);
  });

  test("card_kind passes with no span at all, proven by the anchor rather than a quote", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        {
          field: "card_kind",
          value: { type: "text", value: "contract" },
          spanTexts: [],
        },
      ],
    });
    expect(codeOf(report, "card_kind")).toBe("pass");
  });

  test("card_kind fails when the value is not one of the declared choices", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        {
          field: "card_kind",
          value: { type: "text", value: "not a real kind" },
          spanTexts: [],
        },
      ],
    });
    expect(codeOf(report, "card_kind")).toBe("value_not_normalizable");
  });

  test("a wrong value on a correct span fails", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field(
          "card_title",
          { type: "text", value: "Mutual Non-Disclosure Agreement" },
          "Mutual Non-Disclosure Agreement",
        ),
        field(
          "card_summary",
          { type: "text", value: "the parties agreed to arbitrate" },
          "both sides keep it confidential",
        ),
      ],
    });
    expect(codeOf(report, "card_summary")).toBe("value_not_in_span");
  });

  test("a correct value on a wrong span fails", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field(
          "card_title",
          { type: "text", value: "Mutual Non-Disclosure Agreement" },
          "Dated 2025-03-04 between the parties",
        ),
      ],
    });
    expect(codeOf(report, "card_title")).toBe("value_not_in_span");
  });

  test("a rule 1 failure is reported under its own code and stops rule 2", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field(
          "card_title",
          { type: "text", value: "Mutual Non-Disclosure Agreement" },
          "Mutual Non-Disclosure Agreement",
          { evidenceFailure: "quote_hash_mismatch" },
        ),
      ],
    });
    expect(codeOf(report, "card_title")).toBe("quote_hash_mismatch");
  });

  test("a date ambiguous across two declared formats fails rather than picking", () => {
    const report = gateSafeNote();
    const ambiguous = gateCard({
      recordKind: "safe_note_card",
      fields: [
        ...safeNoteBase().filter((entry) => entry.field !== "instrument_date"),
        field(
          "instrument_date",
          { type: "date", value: "2025-03-04" },
          "03/04/2025",
        ),
      ],
    });
    expect(report.requiredFailed).toBe(false);
    expect(codeOf(ambiguous, "instrument_date")).toBe("date_ambiguous");
    // The same slash format is unambiguous when only one reading is a real
    // calendar date, and then it resolves rather than failing.
    const unambiguous = gateCard({
      recordKind: "safe_note_card",
      fields: [
        ...safeNoteBase().filter((entry) => entry.field !== "instrument_date"),
        field(
          "instrument_date",
          { type: "date", value: "2025-04-13" },
          "13/04/2025",
        ),
      ],
    });
    expect(codeOf(unambiguous, "instrument_date")).toBe("pass");
    // A month name is one reading in every declared format.
    const written = gateCard({
      recordKind: "safe_note_card",
      fields: [
        ...safeNoteBase().filter((entry) => entry.field !== "instrument_date"),
        field(
          "instrument_date",
          { type: "date", value: "2025-03-04" },
          "March 4, 2025",
        ),
      ],
    });
    expect(codeOf(written, "instrument_date")).toBe("pass");
  });

  test("P2-82: the added common date renderings all normalize", () => {
    const parses = (spanText: string, value: string): string =>
      codeOf(
        gateCard({
          recordKind: "safe_note_card",
          fields: [
            ...safeNoteBase().filter(
              (entry) => entry.field !== "instrument_date",
            ),
            field("instrument_date", { type: "date", value }, spanText),
          ],
        }),
        "instrument_date",
      );

    // Long month name, with and without a comma (already covered by
    // month_name_mdy, asserted here so the coverage is not accidental).
    expect(parses("March 4, 2025", "2025-03-04")).toBe("pass");
    expect(parses("March 4 2025", "2025-03-04")).toBe("pass");
    // Abbreviated month name.
    expect(parses("Mar 4, 2025", "2025-03-04")).toBe("pass");
    // Day-first with a month name.
    expect(parses("4 March 2025", "2025-03-04")).toBe("pass");
    // ISO with a time, and with a timezone offset, both trimmed to the date.
    expect(parses("2025-03-04T10:30:00Z", "2025-03-04")).toBe("pass");
    expect(parses("2025-03-04T00:00:00-05:00", "2025-03-04")).toBe("pass");
    // A two-digit year, unambiguous because only one reading (13 as the day)
    // is a real calendar date; 13 can never be a month.
    expect(parses("13/04/25", "2025-04-13")).toBe("pass");
  });

  test("P2-82: a two-digit year is ambiguous exactly like a four-digit one", () => {
    const report = gateCard({
      recordKind: "safe_note_card",
      fields: [
        ...safeNoteBase().filter((entry) => entry.field !== "instrument_date"),
        field(
          "instrument_date",
          { type: "date", value: "2020-01-02" },
          "01/02/20",
        ),
      ],
    });
    expect(codeOf(report, "instrument_date")).toBe("date_ambiguous");
  });

  test("money with grouping separators and a symbol normalizes and matches", () => {
    expect(codeOf(gateSafeNote(), "principal_amount")).toBe("pass");
    const variants: Array<[string, string, string]> = [
      ["$1,250,000.00", "1250000", "USD"],
      ["$1 250 000", "1250000", "USD"],
      ["EUR 1,000.50", "1000.5", "EUR"],
      ["1,000.50 EUR", "1000.50", "EUR"],
      ["£2,000", "2000", "GBP"],
      ["($1,250.00)", "-1250", "USD"],
      ["$(1,250.00)", "-1250", "USD"],
      ["-$1,250.00", "-1250", "USD"],
    ];
    for (const [spanText, amount, currency] of variants) {
      const report = gateCard({
        recordKind: "safe_note_card",
        fields: [
          ...safeNoteBase(),
          field("valuation_cap", { type: "money", amount, currency }, spanText),
        ],
      });
      expect([spanText, codeOf(report, "valuation_cap")]).toEqual([
        spanText,
        "pass",
      ]);
    }
  });

  test("money never proves a currency the span does not carry", () => {
    const wrongCurrency = gateSafeNote(
      field(
        "valuation_cap",
        { type: "money", amount: "1000", currency: "EUR" },
        "$1,000.00",
      ),
    );
    expect(codeOf(wrongCurrency, "valuation_cap")).toBe("currency_mismatch");
    const noIndicator = gateSafeNote(
      field(
        "valuation_cap",
        { type: "money", amount: "1000", currency: "USD" },
        "1,000.00",
      ),
    );
    expect(codeOf(noIndicator, "valuation_cap")).toBe("currency_mismatch");
    const wrongAmount = gateSafeNote(
      field(
        "valuation_cap",
        { type: "money", amount: "1000.01", currency: "USD" },
        "$1,000.00",
      ),
    );
    expect(codeOf(wrongAmount, "valuation_cap")).toBe("value_not_in_span");
  });

  test("a percentage canonicalizes with an explicit unit code", () => {
    expect(
      codeOf(
        gateSafeNote(
          field(
            "discount_rate",
            { type: "decimal", value: "20", unitCode: "%" },
            "20%",
          ),
        ),
        "discount_rate",
      ),
    ).toBe("pass");
    // No implicit conversion: `20%` does not prove `0.2` dimensionless.
    expect(
      codeOf(
        gateSafeNote(
          field(
            "discount_rate",
            { type: "decimal", value: "0.2", unitCode: "1" },
            "20%",
          ),
        ),
        "discount_rate",
      ),
    ).toBe("unit_code_invalid");
    expect(
      codeOf(
        gateSafeNote(
          field(
            "discount_rate",
            { type: "decimal", value: "20", unitCode: "mg" },
            "20%",
          ),
        ),
        "discount_rate",
      ),
    ).toBe("unit_code_invalid");
  });

  test("a boolean with no span is absent, not false", () => {
    const report = gateSafeNote();
    expect(report.results.some((entry) => entry.field === "mfn_clause")).toBe(
      false,
    );
    expect(report.requiredFailed).toBe(false);
    expect(report.failed).toEqual([]);
  });

  test("a boolean is true only from an asserting span and false only from a negating one", () => {
    const asserted = gateSafeNote(
      field(
        "mfn_clause",
        { type: "boolean", value: true },
        "The Investor shall have most favored nation rights.",
      ),
    );
    expect(codeOf(asserted, "mfn_clause")).toBe("pass");
    const negated = gateSafeNote(
      field(
        "mfn_clause",
        { type: "boolean", value: false },
        "The Investor shall have no most favored nation rights.",
      ),
    );
    expect(codeOf(negated, "mfn_clause")).toBe("pass");
    const contradicted = gateSafeNote(
      field(
        "mfn_clause",
        { type: "boolean", value: true },
        "The Investor shall have no most favored nation rights.",
      ),
    );
    expect(codeOf(contradicted, "mfn_clause")).toBe("value_not_in_span");
    const silent = gateSafeNote(
      field(
        "mfn_clause",
        { type: "boolean", value: false },
        "Governing law is Delaware.",
      ),
    );
    expect(codeOf(silent, "mfn_clause")).toBe("boolean_unsupported_span");
  });

  test("an integer reads through grouping separators", () => {
    const report = gateCard({
      recordKind: "tax_return_card",
      fields: [
        field("tax_year", { type: "integer", value: "2024" }, "2024"),
        field(
          "adjusted_gross_income",
          { type: "money", amount: "62000", currency: "USD" },
          "62,000.00",
        ),
        {
          field: "w2_employer",
          ordinal: 0,
          value: { type: "text", value: "Northwind Supply" },
          spanTexts: ["Employer: Northwind Supply, EIN redacted"],
        },
      ],
    });
    expect(report.failed).toEqual([]);
  });

  test("a required failure refuses the whole card, an optional one drops a field", () => {
    const requiredMissing = gateCard({
      recordKind: "document_card",
      fields: [
        field(
          "card_summary",
          { type: "text", value: "a summary" },
          "a summary",
        ),
      ],
    });
    expect(requiredMissing.requiredFailed).toBe(true);
    expect(requiredMissing.passedKeys).toEqual([]);
    expect(requiredMissing.dropped).toEqual([]);
    expect(codeOf(requiredMissing, "card_title")).toBe("required_field_absent");

    const optionalFailed = gateCard({
      recordKind: "document_card",
      fields: [
        field("card_title", { type: "text", value: "A Title" }, "A Title"),
        field(
          "card_date",
          { type: "date", value: "2025-03-04" },
          "sometime in March",
        ),
      ],
    });
    expect(optionalFailed.requiredFailed).toBe(false);
    expect(optionalFailed.passedKeys).toEqual(["card_title"]);
    expect(optionalFailed.dropped).toEqual([
      { key: "card_date", code: "value_not_normalizable" },
    ]);
  });

  test("an entity value is not provable until binding exists", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field("card_title", { type: "text", value: "A Title" }, "A Title"),
        {
          field: "card_party",
          ordinal: 0,
          value: {
            type: "entity",
            entityId: "synthetic" as unknown as never,
          },
          spanTexts: ["Acme Research"],
        },
      ],
    });
    expect(codeOf(report, "card_party:0")).toBe("entity_value_unsupported");
  });

  test("an ordinal that contradicts the declared field shape fails", () => {
    const report = gateCard({
      recordKind: "document_card",
      fields: [
        field("card_title", { type: "text", value: "A Title" }, "A Title"),
        field(
          "card_party",
          { type: "text", value: "Acme Research" },
          "Acme Research",
        ),
      ],
    });
    expect(codeOf(report, "card_party")).toBe("field_not_declared");
  });

  test("a bare amount defaults to USD on a tax return but not on a generic card", () => {
    const bare = { type: "money", amount: "50000", currency: "USD" } as const;
    const taxReturn = gateCard({
      recordKind: "tax_return_card",
      fields: [
        field("tax_year", { type: "integer", value: "2021" }, "2021"),
        field("adjusted_gross_income", bare, "50,000.00"),
      ],
    });
    expect(codeOf(taxReturn, "adjusted_gross_income")).toBe("pass");

    const generic = gateCard({
      recordKind: "safe_note_card",
      fields: [...safeNoteBase(), field("valuation_cap", bare, "50,000.00")],
    });
    expect(codeOf(generic, "valuation_cap")).toBe("currency_mismatch");
  });

  test("account_identifier_last_four refuses a value longer than four characters", () => {
    const tooLong = gateCard({
      recordKind: "brokerage_tax_package_card",
      fields: [
        field("tax_year", { type: "integer", value: "2024" }, "2024"),
        field(
          "account_identifier_last_four",
          { type: "text", value: "12345678" },
          "12345678",
        ),
      ],
    });
    expect(codeOf(tooLong, "account_identifier_last_four")).toBe(
      "value_too_long",
    );

    const lastFour = gateCard({
      recordKind: "brokerage_tax_package_card",
      fields: [
        field("tax_year", { type: "integer", value: "2024" }, "2024"),
        field(
          "account_identifier_last_four",
          { type: "text", value: "6789" },
          "6789",
        ),
      ],
    });
    expect(codeOf(lastFour, "account_identifier_last_four")).toBe("pass");
  });
});
