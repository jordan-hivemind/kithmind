// TAXES-1. The Taxes screen's readers, against real PostgreSQL: a tax year
// derived from extraction beats a title parse, a title parse is the fallback
// when extraction never reached the document, a document with neither is
// still returned (grouped as "Unknown year" rather than dropped), historical
// and active documents are both counted and tagged correctly, tax payment
// totals sum as exact decimals, and `taxContribution`/`mergeTaxIntoAreas`
// fold the same inventory into the `taxes` coverage row. Synthetic ids and
// values only.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaxPayment,
  listAllTaxPayments,
  listTaxOverview,
  mergeTaxIntoAreas,
  taxContribution,
} from "../dist/admin/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-25T12:00:00Z");

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Synthetic Tax Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return {
    ...database,
    ctx,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
  };
}

function decimalValue(value) {
  return { type: "decimal", value: String(value), unitCode: "1" };
}

function textValue(value) {
  return { type: "text", value };
}

/** A `tax_return`/`k1`/`tax_support` document, its provenance chain, and
 * optionally a full-document `document_statement` extraction (`observations`)
 * or a K-1's targeted extraction (`k1Outcomes`, written straight onto
 * `kith.document_targeted_extractions.outcomes` the shape
 * `extraction/read.ts` reads back). */
async function seedTaxDocument(ctx, spaceId, userId, input) {
  const sourceAccountId = newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title,
        lifecycle, original_link_available, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, 'available', true, 0)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      `${sourceItemId}`.padEnd(64, "a").slice(0, 64),
      input.title,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id,
        desired_processing_epoch, card_generation, state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 0, false, 'ready')`,
    [generationId, spaceId, sourceAccountId, sourceItemId],
  );
  await ctx.client.query(
    `INSERT INTO kith.documents
       (id, space_id, created_at, processing_generation_id, source_item_id,
        document_key, title, doc_type, captured_at, evidence_span_ids,
        publication_state)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7, $8,
               '[]'::jsonb, $9)`,
    [
      documentId,
      spaceId,
      generationId,
      sourceItemId,
      `doc-${documentId}`,
      input.title,
      input.docType,
      new Date(input.capturedAt),
      input.publicationState ?? "active",
    ],
  );

  if (input.observations) {
    const eventId = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.events
         (id, space_id, created_at, source_account_id, source_item_id, event_key)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, $5)`,
      [eventId, spaceId, sourceAccountId, sourceItemId, `document_statement:${eventId}`],
    );
    for (const observation of input.observations) {
      await ctx.client.query(
        `INSERT INTO kith.observations
           (id, space_id, created_at, source_item_id, event_id, event_type,
            observation_key, observation_type, value)
         VALUES ($1, $2, transaction_timestamp(), $3, $4, 'document_statement',
                 $5, $5, $6::jsonb)`,
        [
          newKithId(),
          spaceId,
          sourceItemId,
          eventId,
          observation.key,
          JSON.stringify(observation.value),
        ],
      );
    }
  }

  if (input.k1Outcomes) {
    const revisionId = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.source_revisions
         (id, space_id, created_at, source_item_id, content_hash, byte_length,
          media_type, captured_at, user_id)
       VALUES ($1, $2, transaction_timestamp(), $3, 'x', 1, 'application/pdf',
               transaction_timestamp(), $4)`,
      [revisionId, spaceId, sourceItemId, userId],
    );
    await ctx.client.query(
      `INSERT INTO kith.document_targeted_extractions
         (id, space_id, source_account_id, source_item_id, source_revision_id,
          goal_kind, goal_version, instance_key, request_digest,
          source_page_count, required_fields, optional_fields, status, outcomes)
       VALUES ($1, $2, $3, $4, $5, 'schedule_k1_key_fields_v1', 1, 'v1', $6, 1,
               $7::jsonb, '[]'::jsonb, 'complete', $8::jsonb)`,
      [
        newKithId(),
        spaceId,
        sourceAccountId,
        sourceItemId,
        revisionId,
        "a".repeat(64),
        JSON.stringify(["tax_year"]),
        JSON.stringify(input.k1Outcomes),
      ],
    );
  }

  return { sourceItemId, documentId };
}

function citedOutcome(field, value) {
  return { field, status: "cited", readings: [{ value }] };
}

test(
  "a tax_return's extracted tax year wins over its title, and its return_version tags the form type",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "Tax return 2020 · 2021 - 1040 - Synthetic Filer.pdf",
      docType: "tax_return",
      capturedAt: "2021-04-10",
      observations: [
        { key: "tax_year", value: decimalValue(2021) },
        { key: "return_version", value: textValue("1040") },
      ],
    });

    const overview = await listTaxOverview(f.ctx, { principal: f.principal });
    assert.equal(overview.documents.length, 1);
    const document = overview.documents[0];
    assert.equal(document.taxYear, 2021);
    assert.equal(document.yearSource, "extraction");
    assert.equal(document.formType, "1040");
    assert.equal(document.formTypeSource, "extraction");
    assert.equal(document.active, true);

    assert.equal(overview.years.length, 1);
    const year = overview.years[0];
    assert.equal(year.taxYear, 2021);
    assert.equal(year.returnCount, 1);
    assert.deepEqual(year.returnFormTypes, ["1040"]);
  },
);

test(
  "a tax_support document with no extraction falls back to its title's year, and a document with neither groups as Unknown year",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "2019 - Synthetic brokerage 1099 support.pdf",
      docType: "tax_support",
      capturedAt: "2020-02-01",
    });
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "Scanned receipt, no year printed.pdf",
      docType: "tax_support",
      capturedAt: "2020-02-02",
    });

    const overview = await listTaxOverview(f.ctx, { principal: f.principal });
    assert.equal(overview.documents.length, 2);
    const withYear = overview.documents.find((doc) => doc.title.includes("2019"));
    assert.equal(withYear.taxYear, 2019);
    assert.equal(withYear.yearSource, "title");
    const withoutYear = overview.documents.find((doc) => !doc.title.includes("2019"));
    assert.equal(withoutYear.taxYear, null);
    assert.equal(withoutYear.yearSource, null);

    const unknown = overview.years.find((year) => year.taxYear === null);
    assert.ok(unknown, "the Unknown year bucket must still be present");
    assert.equal(unknown.supportCount, 1);
    // Unknown year sorts last, after every known year.
    assert.equal(overview.years[overview.years.length - 1].taxYear, null);
    const known = overview.years.find((year) => year.taxYear === 2019);
    assert.equal(known.supportCount, 1);
  },
);

test(
  "a K-1's targeted extraction supplies its tax year and issuing partnership over a title guess",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "K-1 2022 · Some Other Name LLC.pdf",
      docType: "k1",
      capturedAt: "2023-03-01",
      k1Outcomes: [
        citedOutcome("tax_year", decimalValue(2022)),
        citedOutcome("partnership_name", textValue("Synthetic Partners LP")),
        citedOutcome("form_family", textValue("1065")),
      ],
    });
    // A second K-1 that only a title parse can name.
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "K-1 2022 · Untitled Holdings Trust.pdf",
      docType: "k1",
      capturedAt: "2023-03-02",
    });

    const overview = await listTaxOverview(f.ctx, { principal: f.principal });
    const extracted = overview.documents.find((doc) => doc.title.includes("Some Other"));
    assert.equal(extracted.taxYear, 2022);
    assert.equal(extracted.yearSource, "extraction");
    assert.equal(extracted.issuer, "Synthetic Partners LP");
    assert.equal(extracted.issuerSource, "extraction");
    assert.equal(extracted.formType, "1065");

    const titled = overview.documents.find((doc) => doc.title.includes("Untitled Holdings"));
    assert.equal(titled.taxYear, 2022);
    assert.equal(titled.yearSource, "title");
    assert.equal(titled.issuer, "Untitled Holdings Trust");
    assert.equal(titled.issuerSource, "title");

    const year = overview.years.find((row) => row.taxYear === 2022);
    assert.equal(year.k1Count, 2);
  },
);

test(
  "an active and a historical document for the same year are both counted, tagged correctly",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "2024 - 1040 - current copy.pdf",
      docType: "tax_return",
      capturedAt: "2025-04-01",
      publicationState: "active",
    });
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "2024 - 1040 - superseded copy.pdf",
      docType: "tax_return",
      capturedAt: "2025-03-01",
      publicationState: "historical",
    });

    const overview = await listTaxOverview(f.ctx, { principal: f.principal });
    assert.equal(overview.documents.length, 2);
    const active = overview.documents.find((doc) => doc.title.includes("current"));
    assert.equal(active.active, true);
    const historical = overview.documents.find((doc) => doc.title.includes("superseded"));
    assert.equal(historical.active, false);

    // The year table counts both -- a historical document is still a
    // document, and the screen shows a complete inventory.
    const year = overview.years.find((row) => row.taxYear === 2024);
    assert.equal(year.returnCount, 2);
    // The latest captured date is the active copy's, not the historical one's.
    assert.equal(year.latestCapturedAt.slice(0, 10), "2025-04-01");
  },
);

const payer = {
  key: "person:synthetic-tax-payer",
  kind: "person",
  name: "Synthetic Tax Payer",
};

function payment(f, overrides = {}) {
  return {
    principal: f.principal,
    spaceId: f.spaceId,
    payer,
    authority: "us_federal",
    paymentKind: "estimated_income",
    taxYear: 2025,
    amount: "1000.00",
    currency: "USD",
    submittedOn: "2025-09-01",
    confirmationNumber: "CONF-SYNTHETIC-A",
    ...overrides,
  };
}

test(
  "tax payments total by year as exact decimals, and list across every year regardless of documents",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await createTaxPayment(f.ctx, payment(f));
    await createTaxPayment(
      f.ctx,
      payment(f, { amount: "234.56", confirmationNumber: "CONF-SYNTHETIC-B" }),
    );
    await createTaxPayment(
      f.ctx,
      payment(f, {
        taxYear: 2024,
        amount: "50.00",
        confirmationNumber: "CONF-SYNTHETIC-C",
      }),
    );

    const overview = await listTaxOverview(f.ctx, { principal: f.principal });
    // No documents at all this run; both payment years still appear.
    assert.equal(overview.documents.length, 0);
    const y2025 = overview.years.find((row) => row.taxYear === 2025);
    assert.equal(y2025.paymentCount, 2);
    assert.deepEqual(y2025.paymentTotals, [{ currency: "USD", amount: "1234.56" }]);
    const y2024 = overview.years.find((row) => row.taxYear === 2024);
    assert.equal(y2024.paymentCount, 1);
    assert.deepEqual(y2024.paymentTotals, [{ currency: "USD", amount: "50" }]);
    // Newest year first.
    assert.equal(overview.years[0].taxYear, 2025);

    const all = await listAllTaxPayments(f.ctx, [f.spaceId]);
    assert.equal(all.length, 3);
    assert.ok(all.every((row) => row.statusHistory.length === 1));
  },
);

test(
  "taxContribution counts only active tax documents and every tax payment, and folds into the taxes coverage row",
  { skip },
  async (t) => {
    const f = await fixture(t);
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "2024 active return.pdf",
      docType: "tax_return",
      capturedAt: "2025-01-01",
      publicationState: "active",
    });
    await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
      title: "2023 historical return.pdf",
      docType: "tax_return",
      capturedAt: "2024-01-01",
      publicationState: "historical",
    });
    await createTaxPayment(f.ctx, payment(f));

    const contribution = await taxContribution(f.ctx, [f.spaceId]);
    assert.equal(contribution.documents, 1);
    assert.equal(contribution.records, 1);
    assert.equal(contribution.from, "2025-01-01");
    assert.equal(contribution.to, "2025-01-01");

    const merged = mergeTaxIntoAreas(
      [{ area: "taxes", sources: 0, documents: 0, records: 0, from: null, to: null, gaps: 0, gapReasons: {}, status: "empty" }],
      contribution,
    );
    const taxesRow = merged.find((row) => row.area === "taxes");
    assert.equal(taxesRow.documents, 1);
    assert.equal(taxesRow.records, 1);
    assert.notEqual(taxesRow.status, "empty");

    // A contribution of nothing leaves the row unchanged.
    assert.deepEqual(mergeTaxIntoAreas(merged, null), merged);
  },
);

test("another space's tax documents and payments never reach the caller's overview", { skip }, async (t) => {
  const f = await fixture(t);
  const otherUserId = await makeUser(f.ctx, { name: "Synthetic Other Owner" });
  const otherSpaceId = await makeSpace(f.ctx, {
    createdBy: otherUserId,
    memberId: otherUserId,
    role: "owner",
  });
  await seedTaxDocument(f.ctx, otherSpaceId, otherUserId, {
    title: "2024 - other space return.pdf",
    docType: "tax_return",
    capturedAt: "2025-01-01",
  });
  await createTaxPayment(f.ctx, {
    ...payment(f),
    spaceId: otherSpaceId,
    principal: { userId: otherUserId, credentialId: null },
  });

  const overview = await listTaxOverview(f.ctx, { principal: f.principal });
  assert.equal(overview.documents.length, 0);
  assert.equal(overview.years.length, 0);

  const contribution = await taxContribution(f.ctx, [f.spaceId]);
  assert.equal(contribution.documents, 0);
  assert.equal(contribution.records, 0);
});

test("a reader-role member administers nothing, so the Taxes overview is empty", { skip }, async (t) => {
  const f = await fixture(t);
  const readerId = await makeUser(f.ctx, { name: "Synthetic Reader" });
  await makeMember(f.ctx, { spaceId: f.spaceId, userId: readerId, role: "reader" });
  await seedTaxDocument(f.ctx, f.spaceId, f.userId, {
    title: "2024 - owner return.pdf",
    docType: "tax_return",
    capturedAt: "2025-01-01",
  });

  const overview = await listTaxOverview(f.ctx, {
    principal: { userId: readerId, credentialId: null },
  });
  assert.deepEqual(overview, { years: [], documents: [], payments: [] });
});
