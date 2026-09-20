// The synthetic investment document a matcher test scores.
//
// Extracted from `test/investmentLinks.test.mjs` by ADM-8c, which needs the
// same fixtures to prove that the deferred kind reaches the same decisions
// through a drain. One seeder, so a shape that drifts drifts for both suites
// at once rather than for one of them silently.

import { newKithId } from "../../dist/index.js";


/**
 * A document with a typed extraction: the provenance chain, an evidence span
 * per statement, the `document_statement` event and its observations, and the
 * `document_extractions` row that names them.
 *
 * Written with SQL rather than by running the extraction pipeline, because
 * what is under test is the matcher, not the reader. The shapes are the ones
 * `src/extraction/model.ts` writes: a scalar statement's `observationKeys` is
 * its own field name, and the observation's `value` is an `ObservationValue`.
 */
export async function seedDocument(ctx, spaceId, input) {
  const sourceAccountId = newKithId();
  const sourceItemId = newKithId();
  const generationId = newKithId();
  const documentId = newKithId();
  const eventId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts (id, space_id, created_at, connector, enabled)
       VALUES ($1, $2, transaction_timestamp(), 'synthetic', true)`,
    [sourceAccountId, spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id_hash, title, uri,
        lifecycle, original_link_available, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'available', true, 0)`,
    [
      sourceItemId,
      spaceId,
      sourceAccountId,
      `${sourceItemId}`.padEnd(64, "a").slice(0, 64),
      input.title ?? "Synthetic document",
      input.uri ?? null,
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
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, $7,
               transaction_timestamp(), '[]'::jsonb, 'active')`,
    [
      documentId,
      spaceId,
      generationId,
      sourceItemId,
      `doc-${documentId}`,
      input.title ?? "Synthetic document",
      input.kind,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.events
       (id, space_id, created_at, source_account_id, source_item_id, event_key)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5)`,
    [eventId, spaceId, sourceAccountId, sourceItemId, `document_statement:${eventId}`],
  );
  const statements = [];
  for (const statement of input.statements) {
    const spanId = newKithId();
    await ctx.client.query(
      `INSERT INTO kith.evidence_spans (id, space_id, created_at)
         VALUES ($1, $2, transaction_timestamp())`,
      [spanId, spaceId],
    );
    await ctx.client.query(
      `INSERT INTO kith.observations
         (id, space_id, created_at, source_item_id, event_id, event_type,
          observation_key, observation_type, value, value_evidence)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, 'document_statement',
               $5, $5, $6::jsonb, $7::jsonb)`,
      [
        newKithId(),
        spaceId,
        sourceItemId,
        eventId,
        statement.field,
        JSON.stringify(statement.value),
        JSON.stringify([spanId]),
      ],
    );
    statements.push({
      field: statement.field,
      valueType: statement.valueType,
      page: 1,
      quote: "synthetic quote",
      observationKeys: [statement.field],
      evidenceSpanId: spanId,
      citation: { shownPage: 1, pageOrdinal: 1, lines: [1], pageLineCount: 1, contiguous: true },
      modelValue: statement.value,
    });
  }
  await ctx.client.query(
    `INSERT INTO kith.document_extractions
       (id, space_id, created_at, source_item_id, processing_generation_id,
        event_id, kind, model, extracted_at, pages_read, pages_total, statements)
     VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'synthetic-model',
             transaction_timestamp(), 1, 1, $7::jsonb)`,
    [
      newKithId(),
      spaceId,
      sourceItemId,
      generationId,
      eventId,
      input.kind,
      JSON.stringify(statements),
    ],
  );
  return { sourceItemId, documentId, generationId };
}

export const org = (field, value) => ({
  field,
  valueType: "organization",
  value: { type: "text", value },
});
export const money = (field, amount, currency = "USD") => ({
  field,
  valueType: "money",
  value: { type: "money", amount, currency },
});
export const date = (field, value, precision) => ({
  field,
  valueType: "date",
  value:
    precision === undefined
      ? { type: "date", value }
      : { type: "date", value, precision },
});

