import assert from "node:assert/strict";
import test from "node:test";

import {
  planTargetedTaxPages,
  targetedTaxCoverage,
  targetedTaxFields,
  targetedTaxNavigationClosed,
} from "../dist/targetedTaxController.js";

function pages(count, overrides = new Map()) {
  return Array.from({ length: count }, (_, index) => {
    const originalPage = index + 1;
    return {
      originalPage,
      text:
        overrides.get(originalPage) ?? `Supporting appendix ${originalPage}`,
    };
  });
}

test("1040 navigation stops at evidence completion instead of appendix length", () => {
  const headings = new Map([
    [1, "Form 1040 U.S. Individual Income Tax Return"],
    [2, "Form 1040 page 2"],
    [3, "Schedule 1 (Form 1040) Additional Income"],
    [4, "Schedule 1 (Form 1040) continued"],
    [5, "Form W-2 Wage and Tax Statement"],
  ]);
  const short = pages(20, headings);
  const long = pages(500, headings);
  assert.deepEqual(
    planTargetedTaxPages("form_1040_totals_v1", short),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    planTargetedTaxPages("form_1040_totals_v1", long),
    [1, 2, 3, 4],
  );
  assert.equal(
    targetedTaxNavigationClosed("form_1040_totals_v1", short, 20),
    true,
  );
});

test("K-1 navigation keeps original page numbers and batches beyond twelve", () => {
  const headers = Array.from({ length: 15 }, (_, index) => ({
    originalPage: 137 + index,
    text:
      index === 0
        ? "Schedule K-1 (Form 1065) Partner's Share. Box 1 Ordinary business income. See attached statement"
        : index === 1
          ? "Schedule K-1 (Form 1065) continued"
          : `Statement continuation ${index - 1}`,
  }));
  headers.push({ originalPage: 152, text: "Form 1099 supporting attachment" });
  const planned = planTargetedTaxPages("schedule_k1_key_fields_v1", headers);
  assert.deepEqual(planned.slice(0, 2), [137, 138]);
  assert.equal(planned.length, 15);
  assert.deepEqual(
    planned.slice(0, 12),
    Array.from({ length: 12 }, (_, i) => 137 + i),
  );
  assert.deepEqual(planned.slice(12), [149, 150, 151]);
  assert.equal(
    targetedTaxNavigationClosed("schedule_k1_key_fields_v1", headers, 152),
    true,
  );
  assert.deepEqual(
    targetedTaxCoverage(
      "schedule_k1_key_fields_v1",
      { requestedRegionsClosed: true, continuationsClosed: true },
      false,
    ),
    {
      formFamily: "schedule_k1_1065",
      requestedRegionsClosed: false,
      continuationsClosed: false,
    },
  );
  assert.equal(
    targetedTaxFields("schedule_k1_key_fields_v1").optionalFields.includes(
      "box_1_ordinary_business_income",
    ),
    true,
  );
});

test("missing pages, identity-only K-1s, and unknown continuation drift stay incomplete", () => {
  assert.equal(
    targetedTaxNavigationClosed(
      "form_1040_totals_v1",
      [
        {
          originalPage: 1,
          text: "Form 1040 U.S. Individual Income Tax Return",
        },
        { originalPage: 2, text: "Form W-2 Wage and Tax Statement" },
      ],
      2,
    ),
    false,
  );
  assert.equal(
    targetedTaxNavigationClosed(
      "schedule_k1_key_fields_v1",
      [
        { originalPage: 1, text: "Schedule K-1 (Form 1065) Partner identity" },
        { originalPage: 2, text: "Form 1099 supporting attachment" },
      ],
      2,
    ),
    false,
  );
  assert.equal(
    targetedTaxNavigationClosed(
      "schedule_k1_key_fields_v1",
      [
        {
          originalPage: 1,
          text:
            "Schedule K-1 (Form 1065) Partner's Share of Income, Deductions, Credits, etc.",
        },
        {
          originalPage: 2,
          text: "Schedule K-1 (Form 1065) continued",
        },
        { originalPage: 3, text: "Form 1099 supporting attachment" },
      ],
      3,
    ),
    false,
    "the standard K-1 title does not prove that the Part III key-box region was inspected",
  );
  assert.equal(
    targetedTaxNavigationClosed(
      "schedule_k1_key_fields_v1",
      [
        {
          originalPage: 1,
          text: "Schedule K-1 (Form 1065) Box 1 Ordinary business income. See attached statement",
        },
        { originalPage: 2, text: "unlabelled continuation content" },
        { originalPage: 3, text: "Form 1099 supporting attachment" },
      ],
      3,
    ),
    false,
  );
  assert.deepEqual(
    targetedTaxCoverage(
      "schedule_k1_key_fields_v1",
      { requestedRegionsClosed: false, continuationsClosed: false },
      true,
    ),
    {
      formFamily: "schedule_k1_1065",
      requestedRegionsClosed: false,
      continuationsClosed: false,
    },
  );
});

test("1040 closure requires actual distinct page one and page two headings", () => {
  assert.equal(
    targetedTaxNavigationClosed(
      "form_1040_totals_v1",
      [
        { originalPage: 1, text: "Contents\nForm 1040 ........ page 8" },
        {
          originalPage: 2,
          text: "Contents\nForm 1040 page 2 ........ page 9",
        },
        { originalPage: 3, text: "Form W-2 Wage and Tax Statement" },
      ],
      3,
    ),
    false,
  );
  assert.equal(
    targetedTaxNavigationClosed(
      "form_1040_totals_v1",
      [
        {
          originalPage: 1,
          text: "Form 1040 U.S. Individual Income Tax Return",
        },
        {
          originalPage: 2,
          text: "Form 1040 U.S. Individual Income Tax Return",
        },
        { originalPage: 3, text: "Form W-2 Wage and Tax Statement" },
      ],
      3,
    ),
    false,
    "a repeated page-one heading does not prove page-two coverage",
  );
});

test("unsupported K-1 families do not masquerade as 1065", () => {
  assert.deepEqual(
    planTargetedTaxPages("schedule_k1_key_fields_v1", [
      { originalPage: 1, text: "Schedule K-1 (Form 1041)" },
      { originalPage: 2, text: "Beneficiary's Share" },
    ]),
    [],
  );
  assert.deepEqual(
    planTargetedTaxPages("form_1040_totals_v1", [
      {
        originalPage: 1,
        text: "Contents: see Form 1040 on page 8 and Schedule 1 on page 10",
      },
      { originalPage: 2, text: "General filing instructions for Form 1040" },
    ]),
    [],
  );
});
