// The read side: what `get_document` adds to its reply.
//
// Deliberately one function and one shape. MCP exposure gets a second-model
// review, so the whole surface is: an extraction block on a tool that already
// exists, reached through that tool's existing authorization, carrying no id
// the caller could not already see. No new tool, no new route, no new
// permission.
//
// Two invariants this function owes its caller:
//
//   * **Space isolation.** `spaceId` is the authorized space the caller's own
//     `getDocument` already resolved; every statement below is filtered on it
//     as well as on the source item, so a source item id from another space
//     returns nothing rather than another household's reading.
//   * **Decimal exactness.** Money and numbers are returned as the decimal
//     strings they are stored as. Nothing here parses one into a float.

import type { ClientBase } from "pg";

import { listDocumentCorrections } from "./corrections.js";
import type { StoredStatement } from "./model.js";

export type ExtractionStatement = {
  field: string;
  valueType: string;
  value: unknown;
  page: number;
  quote: string;
  evidenceSpanId: string;
  /** Present and true when the page stated no currency, so the default was
   * used. Never omitted silently. */
  currencyAssumed?: true;
  /** Present when a human corrected this field. The `value` above is then the
   * corrected one and this is what the model read. */
  originalValue?: unknown;
  corrected?: true;
};

export type DocumentExtraction = {
  kind: string;
  summary: string | null;
  model: string;
  documentTypeId: string | null;
  documentTypeVersion: number | null;
  extractedAt: Date;
  pagesRead: number;
  pagesTotal: number;
  /** True when the document was longer than the extraction bound. The
   * statements below then cover only `pagesRead` pages. */
  partial: boolean;
  statements: ExtractionStatement[];
  openCorrections: Array<{
    id: string;
    field: string | null;
    reason: string | null;
    reading: unknown;
  }>;
};

export async function readDocumentExtraction(
  client: ClientBase,
  spaceId: string,
  sourceItemId: string,
): Promise<DocumentExtraction | null> {
  const row = (
    await client.query<Record<string, unknown>>(
      `SELECT kind, summary, model, document_type_id, document_type_version,
              extracted_at, pages_read, pages_total, statements, event_id
         FROM kith.document_extractions
        WHERE space_id = $1 AND source_item_id = $2 LIMIT 1`,
      [spaceId, sourceItemId],
    )
  ).rows[0];
  if (!row) return null;
  const stored = (row.statements ?? []) as StoredStatement[];
  const values = new Map<string, unknown>();
  if (typeof row.event_id === "string") {
    const observations = (
      await client.query<{ observation_key: string; value: unknown }>(
        `SELECT observation_key, value FROM kith.observations
          WHERE space_id = $1 AND event_id = $2
            AND event_type = 'document_statement' LIMIT 512`,
        [spaceId, row.event_id],
      )
    ).rows;
    for (const observation of observations) {
      values.set(observation.observation_key, observation.value);
    }
  }
  const corrections = await listDocumentCorrections(
    client,
    spaceId,
    sourceItemId,
  );
  // `correctedValue !== null` excludes a row `supersedeOpenCorrections`
  // auto-resolved (reason `cleared`) rather than the owner: that row is
  // `resolved` with no correction to show, and without this it would read as
  // "the owner fixed this field" with a null value (ADM-8a).
  const corrected = new Map(
    corrections
      .filter(
        (item) =>
          item.state === "resolved" &&
          item.fieldName !== null &&
          item.correctedValue !== null,
      )
      .map((item) => [item.fieldName!, item.correctedValue]),
  );
  // A correction targets one observation, so it is looked up by observation
  // key first. A scalar field's key is its own name, so the fallback to the
  // field name is the same lookup said the other way -- and it is what finds a
  // correction the owner made before the field was ever extracted, which has
  // no key to be found by.
  const used = new Set<string>();
  const fixFor = (key: string, field?: string): unknown => {
    for (const candidate of field === undefined ? [key] : [key, field]) {
      if (!corrected.has(candidate)) continue;
      used.add(candidate);
      return corrected.get(candidate);
    }
    return undefined;
  };

  const statements: ExtractionStatement[] = stored.map((statement) => {
    const scalar = statement.observationKeys.length === 1;
    const fixes = statement.observationKeys.map((key) =>
      fixFor(key, scalar ? statement.field : undefined),
    );
    const readings = statement.observationKeys.map((key) => values.get(key));
    const merged = readings.map((reading, index) =>
      fixes[index] === undefined ? reading : fixes[index],
    );
    const anyFix = fixes.some((fix) => fix !== undefined);
    return {
      field: statement.field,
      valueType: statement.valueType,
      // The correction wins. `readings` are the observations, which the
      // correction was written through to, so the two already agree; the
      // correction row is consulted anyway, because a line the owner fixed
      // that the newest run gated out has only the row to carry it.
      value: scalar ? merged[0] : merged,
      page: statement.page,
      quote: statement.quote,
      evidenceSpanId: statement.evidenceSpanId,
      ...(statement.currencyAssumed ? { currencyAssumed: true as const } : {}),
      // The model's own reading, from the extraction row rather than from the
      // observation: the observation now carries the correction, so it is no
      // longer a record of what was corrected.
      ...(anyFix
        ? { corrected: true as const, originalValue: statement.modelValue }
        : {}),
    };
  });
  // A correction the model's reading never covered is still a fact the owner
  // asserted, so it belongs in the reply.
  for (const [field, value] of corrected) {
    if (used.has(field)) continue;
    statements.push({
      field,
      valueType: "text",
      value,
      page: 0,
      quote: "",
      evidenceSpanId: "",
      corrected: true,
    });
  }
  return {
    kind: String(row.kind),
    summary: (row.summary ?? null) as string | null,
    model: String(row.model),
    documentTypeId: (row.document_type_id ?? null) as string | null,
    documentTypeVersion:
      row.document_type_version === null ||
      row.document_type_version === undefined
        ? null
        : Number(row.document_type_version),
    extractedAt: row.extracted_at as Date,
    pagesRead: Number(row.pages_read),
    pagesTotal: Number(row.pages_total),
    partial: Number(row.pages_read) < Number(row.pages_total),
    statements,
    openCorrections: corrections
      .filter((item) => item.state === "open")
      .map((item) => ({
        id: item.id,
        field: item.fieldName,
        reason: item.reason,
        reading: item.originalValue,
      })),
  };
}
