// Why an extraction failed, without anyone reading the document.
//
// The live trials stalled twice on the same wall: a correction said
// `value_not_in_quote` and carried the scalar the model returned, and nobody
// who could look at the receipt was allowed to, so there was no way to tell a
// model citing the wrong line from a page layout the reader cannot handle.
// ADM-5f records the citation; this turns it into an answer.
//
// **Everything this emits is a number, a boolean, an enum value or a field
// name.** No page text, no quote, no value. The one thing that comes close is
// `signature`, which is the *shape* of the returned value with every letter
// folded to `a` and every digit to `9` -- enough to tell `$9,999.99` from
// `aaa 99` and not enough to read anything. Field names and correction
// reasons are schema, not content.
//
// The checks it runs are the gate's own, so "does the value occur on the
// cited page" means exactly what the gate means by it.

import type { ClientBase } from "pg";

import {
  amountsInText,
  CORRECTION_REASONS,
  valueSignature,
  compareDecimalsSafely,
  foldTextForMatch,
  parseAmount,
  readPrintedDate,
  type DateOrder,
} from "./gate.js";
import { areContiguous, pageLines } from "./lines.js";

export { valueSignature } from "./gate.js";

type RecordedCitation = {
  shownPage?: unknown;
  pageOrdinal?: unknown;
  lines?: unknown;
  pageLineCount?: unknown;
  contiguous?: unknown;
};

function integers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isInteger(entry))
    : [];
}

function integer(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

/** One failed statement, as integers and enums. */
export type StatementDiagnosis = {
  field: string | null;
  reason: string | null;
  shownPage: number | null;
  pageOrdinal: number | null;
  citedLines: number[];
  pageLineCount: number | null;
  contiguous: boolean;
  /** The shape of what the model returned. Never its content. */
  signature: string;
  /**
   * For a list, each entry's amount and description shapes on their own.
   *
   * The whole-list signature reads as one run of folded JSON, which is how a
   * live trial could see that something was wrong with the line items and not
   * what: `aaaaaa:9999,aaaaaaaaaaa:` hides that the amount had lost its
   * decimal point. Split out, `{amount: "9999"}` says it at a glance.
   */
  itemSignatures?: Array<{
    amount: string;
    description: string;
    lines: number[];
    reason?: string;
  }>;
  /** Whether the value occurs anywhere on the page it cited. */
  onCitedPage: boolean;
  /** Which line ids of that page carry it. The answer to "did it cite the
   * wrong line" is this list against `citedLines`. */
  onLines: number[];
  /** Whether it occurs on some other page of the document instead. */
  onOtherPage: boolean;
};

export type DocumentDiagnosis = {
  kind: string;
  /** The model that produced this extraction, so kinds can be compared after
   * an override is set. */
  model: string;
  pagesRead: number;
  pagesTotal: number;
  storedStatements: number;
  storedObservations: number;
  openCorrections: number;
  /** Line-length shape of the pages, which is what a column layout shows up
   * as: a low median with a high maximum. */
  lineCount: number;
  medianLineChars: number;
  maxLineChars: number;
  failures: StatementDiagnosis[];
};

export type DiagnosisSummary = {
  documents: DocumentDiagnosis[];
  /** How many failures carried each reason, over the documents inspected. */
  reasonCounts: Record<string, number>;
  /** How many failures carried each reason, per kind. */
  byKind: Record<string, Record<string, number>>;
};

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Where a value occurs on a page, by line id.
 *
 * Run through the gate's own readers rather than a substring search, so the
 * answer means what the gate means. A money value is matched as an amount, a
 * date as a date, anything else as folded text.
 */
function linesCarrying(
  text: string,
  value: unknown,
  dateOrder?: DateOrder,
): number[] {
  const lines = pageLines(text);
  const literal =
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  if (!literal) return [];
  const amount = parseAmount(literal);
  const printed = readPrintedDate(literal, dateOrder);
  const folded = foldTextForMatch(literal);
  const found: number[] = [];
  for (const line of lines) {
    const asAmount =
      amount !== undefined &&
      amountsInText(line.text, {
        cutStart: line.cutStart,
        cutEnd: line.cutEnd,
      }).some(
        (candidate) => compareDecimalsSafely(candidate, amount) === 0,
      );
    const asDate =
      printed.kind === "date" &&
      pageLines(line.text).some((piece) =>
        piece.text.includes(printed.iso),
      );
    const asText =
      folded.length > 0 && foldTextForMatch(line.text).includes(folded);
    if (asAmount || asDate || asText) found.push(line.id);
  }
  return found;
}

export type DiagnoseInput = {
  spaceIds?: readonly string[];
  kind?: string;
  limit?: number;
};

/**
 * Reads the recorded extractions and their open corrections and reports why
 * each failure failed, in numbers.
 *
 * Bounded by construction: at most `limit` documents, and each one's pages are
 * read once. It opens no transaction of its own -- the caller owns that.
 */
export async function diagnoseExtractions(
  client: ClientBase,
  input: DiagnoseInput = {},
): Promise<DiagnosisSummary> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
  const extractions = (
    await client.query<Record<string, unknown>>(
      `SELECT e.id, e.space_id, e.source_item_id, e.kind, e.model,
              e.pages_read, e.pages_total, e.statements,
              e.processing_generation_id
         FROM kith.document_extractions e
        WHERE ($1::text IS NULL OR e.kind = $1)
        ORDER BY e.extracted_at DESC, e.id
        LIMIT $2`,
      [input.kind ?? null, limit],
    )
  ).rows;

  const documents: DocumentDiagnosis[] = [];
  const reasonCounts: Record<string, number> = {};
  const byKind: Record<string, Record<string, number>> = {};

  for (const extraction of extractions) {
    const spaceId = String(extraction.space_id);
    if (input.spaceIds && !input.spaceIds.includes(spaceId)) continue;
    const generationId = String(extraction.processing_generation_id);
    const textVersion = (
      await client.query<{ source_text_version_id: string }>(
        `SELECT source_text_version_id FROM kith.processing_generations
          WHERE id = $1 LIMIT 1`,
        [generationId],
      )
    ).rows[0];
    const pages = textVersion
      ? (
          await client.query<Record<string, unknown>>(
            `SELECT ordinal, text FROM kith.source_pages
              WHERE source_text_version_id = $1 AND space_id = $2
              ORDER BY ordinal, id LIMIT 512`,
            [textVersion.source_text_version_id, spaceId],
          )
        ).rows.map((row) => ({
          ordinal: Number(row.ordinal),
          text: String(row.text ?? ""),
        }))
      : [];
    const shownPages = pages.filter((page) => page.text.trim().length > 0);
    const dateOrder = (
      await client.query<{ examples: unknown }>(
        `SELECT examples FROM kith.document_types
          WHERE space_id = $1 AND kind = $2
          ORDER BY version DESC LIMIT 1`,
        [spaceId, String(extraction.kind)],
      )
    ).rows[0];
    const order = orderFrom(dateOrder?.examples);

    const allLines = shownPages.flatMap((page) =>
      pageLines(page.text).map((line) => line.text.length),
    );
    const observations = (
      await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM kith.observations
          WHERE space_id = $1 AND source_item_id = $2
            AND event_type = 'document_statement'`,
        [spaceId, String(extraction.source_item_id)],
      )
    ).rows[0];
    const corrections = (
      await client.query<Record<string, unknown>>(
        `SELECT field_name, reason, original_value FROM kith.corrections
          WHERE space_id = $1 AND target_kind = 'document' AND target_id = $2
            AND state = 'open'
          ORDER BY reason, field_name LIMIT 256`,
        [spaceId, String(extraction.source_item_id)],
      )
    ).rows;

    const failures: StatementDiagnosis[] = [];
    for (const correction of corrections) {
      const reason = correction.reason === null ? null : String(correction.reason);
      // A scalar here is every correction row written before ADM-5f, and
      // this version's own document-level rows (an unknown field, a truncated
      // input, a refused model). `in` throws on a string, so the first such
      // row used to abort the whole run.
      const raw = correction.original_value;
      const structured =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { value?: unknown; citation?: RecordedCitation })
          : null;
      const citation = structured?.citation ?? {};
      const value =
        structured && "value" in structured ? structured.value : raw;
      const shownPage = integer(citation.shownPage);
      const cited = integers(citation.lines);
      const page =
        shownPage === null ? undefined : shownPages[shownPage - 1];
      const onLines = page ? linesCarrying(page.text, value, order) : [];
      const onOtherPage = shownPages.some(
        (candidate, index) =>
          index + 1 !== shownPage &&
          linesCarrying(candidate.text, value, order).length > 0,
      );
      // A list records the shape of each entry that failed, because a whole
      // list folded into one signature hides which half of an entry was
      // wrong. A reading that is itself a list is folded entry by entry here.
      const recorded = (value ?? null) as { failedShapes?: unknown } | null;
      const shapes =
        recorded !== null &&
        typeof recorded === "object" &&
        Array.isArray(recorded.failedShapes)
          ? recorded.failedShapes
          : Array.isArray(value)
            ? value
            : undefined;
      const items = shapes
        ? shapes.slice(0, 32).map((entry) => {
            const item = (entry ?? {}) as Record<string, unknown>;
            // Both fields always fold. The recorded shapes are already
            // folded, so folding them again is a no-op; an entry read off an
            // untrusted array is not, and a `reason` it carries is only
            // honoured when it is one this code knows -- otherwise a stored
            // description could have printed itself as a reason.
            const reason =
              typeof item.reason === "string" &&
              (CORRECTION_REASONS as readonly string[]).includes(item.reason)
                ? item.reason
                : undefined;
            return {
              amount: valueSignature(item.amount),
              description: valueSignature(item.description),
              lines: integers(item.lines),
              ...(reason ? { reason } : {}),
            };
          })
        : undefined;
      const diagnosis: StatementDiagnosis = {
        field: correction.field_name === null ? null : String(correction.field_name),
        reason,
        shownPage,
        pageOrdinal: integer(citation.pageOrdinal),
        citedLines: cited,
        pageLineCount: integer(citation.pageLineCount),
        contiguous:
          typeof citation.contiguous === "boolean"
            ? citation.contiguous
            : areContiguous(cited),
        signature: valueSignature(value),
        ...(items ? { itemSignatures: items } : {}),
        onCitedPage: onLines.length > 0,
        onLines,
        onOtherPage,
      };
      failures.push(diagnosis);
      if (reason) {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        const kind = String(extraction.kind);
        byKind[kind] = byKind[kind] ?? {};
        byKind[kind]![reason] = (byKind[kind]![reason] ?? 0) + 1;
      }
    }

    documents.push({
      kind: String(extraction.kind),
      model: String(extraction.model),
      pagesRead: Number(extraction.pages_read),
      pagesTotal: Number(extraction.pages_total),
      storedStatements: Array.isArray(extraction.statements)
        ? extraction.statements.length
        : 0,
      storedObservations: Number(observations?.n ?? 0),
      openCorrections: corrections.length,
      lineCount: allLines.length,
      medianLineChars: median(allLines),
      maxLineChars: allLines.length === 0 ? 0 : Math.max(...allLines),
      failures,
    });
  }
  return { documents, reasonCounts, byKind };
}

function orderFrom(examples: unknown): DateOrder | undefined {
  if (!Array.isArray(examples)) return undefined;
  for (const entry of examples) {
    if (!entry || typeof entry !== "object") continue;
    const setting = entry as { setting?: unknown; value?: unknown };
    if (
      setting.setting === "date_order" &&
      (setting.value === "MDY" || setting.value === "DMY")
    ) {
      return setting.value;
    }
  }
  return undefined;
}
