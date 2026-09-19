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
  const corrected = new Map(
    corrections
      .filter((item) => item.state === "resolved" && item.fieldName !== null)
      .map((item) => [item.fieldName!, item.correctedValue]),
  );
  const statements: ExtractionStatement[] = stored.map((statement) => {
    const read =
      statement.observationKeys.length === 1
        ? values.get(statement.observationKeys[0]!)
        : statement.observationKeys.map((key) => values.get(key));
    const fix = corrected.get(statement.field);
    return {
      field: statement.field,
      valueType: statement.valueType,
      // The correction wins. `read` is the observation, which the correction
      // was written through to, so the two agree; the correction row is read
      // anyway because a field the owner settled before it was ever extracted
      // has no observation to carry it.
      value: fix === undefined ? read : fix,
      page: statement.page,
      quote: statement.quote,
      evidenceSpanId: statement.evidenceSpanId,
      ...(statement.currencyAssumed ? { currencyAssumed: true as const } : {}),
      // The model's own reading, from the extraction row rather than from the
      // observation: the observation now carries the correction, so it is no
      // longer a record of what was corrected.
      ...(fix === undefined
        ? {}
        : { corrected: true as const, originalValue: statement.modelValue }),
    };
  });
  // A corrected field the model never read at all is still a fact the owner
  // asserted, so it belongs in the reply.
  for (const [field, value] of corrected) {
    if (statements.some((statement) => statement.field === field)) continue;
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
