import type { ClientBase } from "pg";

import {
  requireSpaceAccess,
  type Principal,
} from "../identity/authorization.js";
import type { IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorColumn,
  keysetCursorPredicate,
} from "../keyset.js";
import { scheduleDocumentExtractionRepair } from "./model.js";

const DEFAULT_SCHEMA_LIMIT = 20;
const MAX_SCHEMA_LIMIT = 50;
const MAX_REPAIR_ITEMS = 100;

export type DocumentSchemaPage = {
  rows: Array<{
    id: string;
    spaceId: string;
    kind: string;
    version: number;
    description: string | null;
    area: string | null;
    guidance: string | null;
    sensitivity: string;
    fields: Array<{
      name: string;
      valueType: string;
      required: boolean;
      check: string | null;
      example: string | null;
      sensitivity: string;
    }>;
  }>;
  cursor?: string;
  isDone: boolean;
};

/** Lists only the current active version of each kind in authorized spaces. */
export async function listDocumentSchemas(
  client: ClientBase,
  spaceIds: readonly string[],
  input: { cursor?: string; limit?: number } = {},
): Promise<DocumentSchemaPage> {
  if (spaceIds.length === 0) return { rows: [], isDone: true };
  const limit = input.limit ?? DEFAULT_SCHEMA_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCHEMA_LIMIT) {
    throw new IdentityError(
      `limit must be an integer from 1 to ${MAX_SCHEMA_LIMIT}`,
    );
  }
  const values: unknown[] = [spaceIds];
  let cursorClause = "";
  if (input.cursor !== undefined) {
    const cursor = decodeKeysetCursor(input.cursor);
    values.push(cursor.keysetAt, cursor.id);
    cursorClause = `WHERE ${keysetCursorPredicate(2, 3, "created_at", "id")}`;
  }
  const current = (
    await client.query<Record<string, unknown>>(
      `WITH latest AS (
         SELECT DISTINCT ON (space_id, kind)
                id, space_id, created_at, kind, version, description, area,
                guidance, sensitivity
           FROM kith.document_types
          WHERE space_id = ANY($1::kith.kith_id[]) AND active
          ORDER BY space_id, kind, version DESC
       )
       SELECT *, ${keysetCursorColumn()}
         FROM latest ${cursorClause}
        ORDER BY created_at, id LIMIT ${limit + 1}`,
      values,
    )
  ).rows;
  const isDone = current.length <= limit;
  const page = current.slice(0, limit);
  const rows: DocumentSchemaPage["rows"] = [];
  for (const row of page) {
    const fields = (
      await client.query<Record<string, unknown>>(
        `SELECT name, value_type, required, check_kind, example, sensitivity
           FROM kith.document_type_fields
          WHERE document_type_id = $1 AND space_id = $2
          ORDER BY created_at, id`,
        [row.id, row.space_id],
      )
    ).rows;
    rows.push({
      id: String(row.id),
      spaceId: String(row.space_id),
      kind: String(row.kind),
      version: Number(row.version),
      description: (row.description ?? null) as string | null,
      area: (row.area ?? null) as string | null,
      guidance: (row.guidance ?? null) as string | null,
      sensitivity: String(row.sensitivity ?? "normal"),
      fields: fields.map((field) => ({
        name: String(field.name),
        valueType: String(field.value_type),
        required: field.required === true,
        check: (field.check_kind ?? null) as string | null,
        example: (field.example ?? null) as string | null,
        sensitivity: String(field.sensitivity ?? "normal"),
      })),
    });
  }
  const last = page.at(-1);
  return {
    rows,
    isDone,
    ...(!isDone && last
      ? {
          cursor: encodeKeysetCursor(String(last.keyset_at), String(last.id)),
        }
      : {}),
  };
}

export type DocumentExtractionStatus = {
  sourceItemId: string;
  state:
    | "unavailable"
    | "not_ready"
    | "not_extracted"
    | "queued"
    | "running"
    | "failed"
    | "extracted";
  ownerDocumentKind: string | null;
  processingGenerationId: string | null;
  documentIds: string[];
  extraction: null | {
    kind: string;
    processingGenerationId: string;
    extractedAt: number;
    storedStatements: number;
    partial: boolean;
  };
  job: null | {
    id: string;
    state: string;
    attempts: number;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
  };
  openCorrections: Array<{
    id: string;
    fieldName: string | null;
    reason: string | null;
  }>;
  unresolvedReasons: string[];
};

/** One bounded status read over stable source item ids. */
export async function getDocumentExtractionStatuses(
  client: ClientBase,
  spaceIds: readonly string[],
  sourceItemIds: readonly string[],
): Promise<DocumentExtractionStatus[]> {
  if (sourceItemIds.length < 1 || sourceItemIds.length > MAX_REPAIR_ITEMS) {
    throw new IdentityError(
      `sourceItemIds must contain from 1 to ${MAX_REPAIR_ITEMS} items`,
    );
  }
  if (spaceIds.length === 0) {
    return sourceItemIds.map(unavailableStatus);
  }
  const unique = [...new Set(sourceItemIds)];
  const rows = (
    await client.query<Record<string, unknown>>(
      `SELECT i.id, i.lifecycle, i.active_generation_id,
              i.owner_document_kind, g.state AS generation_state,
              x.processing_generation_id AS extraction_generation_id,
              x.kind AS extraction_kind, x.extracted_at, x.pages_read,
              x.pages_total, x.statements,
              coalesce(d.document_ids, ARRAY[]::text[]) AS document_ids,
              coalesce(c.open_corrections, '[]'::jsonb) AS open_corrections,
              j.id AS job_id, j.state AS job_state, j.attempts AS job_attempts,
              j.last_error AS job_last_error, j.created_at AS job_created_at,
              j.updated_at AS job_updated_at,
              CASE WHEN i.owner_document_kind IS NULL THEN true ELSE EXISTS (
                SELECT 1 FROM kith.document_types dt
                 WHERE dt.space_id = i.space_id AND dt.active
                   AND dt.kind = i.owner_document_kind
              ) END AS owner_schema_active
         FROM kith.source_items i
         LEFT JOIN kith.processing_generations g
           ON g.id = i.active_generation_id AND g.space_id = i.space_id
         LEFT JOIN kith.document_extractions x
           ON x.source_item_id = i.id AND x.space_id = i.space_id
         LEFT JOIN LATERAL (
           SELECT array_agg(doc.id::text ORDER BY doc.document_key, doc.id) AS document_ids
             FROM kith.documents doc
            WHERE doc.space_id = i.space_id
              AND doc.source_item_id = i.id
              AND doc.processing_generation_id = i.active_generation_id
              AND doc.publication_state = 'active'
         ) d ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
                    'id', correction.id,
                    'fieldName', correction.field_name,
                    'reason', correction.reason)
                    ORDER BY correction.created_at, correction.id) AS open_corrections
             FROM kith.corrections correction
            WHERE correction.space_id = i.space_id
              AND correction.target_kind = 'document'
              AND correction.target_id = i.id
              AND correction.state = 'open'
         ) c ON true
         LEFT JOIN LATERAL (
           SELECT work.id, work.state, work.attempts, work.last_error,
                  work.created_at, work.updated_at
             FROM kith.deferred_work work
            WHERE work.space_id = i.space_id
              AND work.kind = 'document_extraction'
              AND work.payload->>'sourceItemId' = i.id::text
            ORDER BY work.created_at DESC, work.id DESC LIMIT 1
         ) j ON true
        WHERE i.space_id = ANY($1::kith.kith_id[])
          AND i.id = ANY($2::kith.kith_id[])`,
      [spaceIds, unique],
    )
  ).rows;
  const found = new Map(rows.map((row) => [String(row.id), row]));
  return sourceItemIds.map((sourceItemId) => {
    const row = found.get(sourceItemId);
    if (!row) return unavailableStatus(sourceItemId);
    return statusFromRow(sourceItemId, row);
  });
}

function unavailableStatus(sourceItemId: string): DocumentExtractionStatus {
  return {
    sourceItemId,
    state: "unavailable",
    ownerDocumentKind: null,
    processingGenerationId: null,
    documentIds: [],
    extraction: null,
    job: null,
    openCorrections: [],
    unresolvedReasons: ["not_found_or_forbidden"],
  };
}

function statusFromRow(
  sourceItemId: string,
  row: Record<string, unknown>,
): DocumentExtractionStatus {
  const generationId = (row.active_generation_id ?? null) as string | null;
  const jobState = (row.job_state ?? null) as string | null;
  const corrections = Array.isArray(row.open_corrections)
    ? (row.open_corrections as DocumentExtractionStatus["openCorrections"])
    : [];
  const reasons = corrections.map(
    (correction) => correction.reason ?? "open_correction",
  );
  let state: DocumentExtractionStatus["state"];
  if (row.lifecycle !== "available") {
    state = "unavailable";
    reasons.push(`source_${String(row.lifecycle)}`);
  } else if (generationId === null || row.generation_state !== "ready") {
    state = "not_ready";
    reasons.push(
      generationId === null
        ? "no_active_processing_generation"
        : `processing_generation_${String(row.generation_state)}`,
    );
  } else if (jobState === "queued" || jobState === "running") {
    state = jobState;
  } else if (jobState === "failed") {
    state = "failed";
    reasons.push(String(row.job_last_error ?? "extraction_failed"));
  } else if (
    row.extraction_kind === null ||
    row.extraction_kind === undefined
  ) {
    state = "not_extracted";
    reasons.push("not_extracted");
  } else if (row.extraction_generation_id !== generationId) {
    state = "not_extracted";
    reasons.push("extraction_generation_stale");
  } else {
    state = "extracted";
  }
  if (row.owner_schema_active === false) {
    reasons.push("owner_classification_schema_inactive");
  }
  const statements = Array.isArray(row.statements) ? row.statements : [];
  return {
    sourceItemId,
    state,
    ownerDocumentKind: (row.owner_document_kind ?? null) as string | null,
    processingGenerationId: generationId,
    documentIds: Array.isArray(row.document_ids)
      ? row.document_ids.map(String)
      : [],
    extraction:
      row.extraction_kind === null || row.extraction_kind === undefined
        ? null
        : {
            kind: String(row.extraction_kind),
            processingGenerationId: String(row.extraction_generation_id),
            extractedAt: (row.extracted_at as Date).getTime(),
            storedStatements: statements.length,
            partial: Number(row.pages_read) < Number(row.pages_total),
          },
    job:
      row.job_id === null || row.job_id === undefined
        ? null
        : {
            id: String(row.job_id),
            state: String(row.job_state),
            attempts: Number(row.job_attempts),
            lastError: (row.job_last_error ?? null) as string | null,
            createdAt: (row.job_created_at as Date).getTime(),
            updatedAt: (row.job_updated_at as Date).getTime(),
          },
    openCorrections: corrections,
    unresolvedReasons: [...new Set(reasons)],
  };
}

export type RepairScheduleOutcome = {
  sourceItemId: string;
  state:
    | "queued"
    | "already_queued"
    | "followup_queued"
    | "already_followup_queued"
    | "not_ready"
    | "not_found_or_forbidden";
  jobId?: string;
  processingGenerationId?: string;
  reason?: string;
};

async function scheduleCurrent(
  ctx: IdentityCtx,
  spaceId: string,
  sourceItemId: string,
): Promise<RepairScheduleOutcome> {
  const row = (
    await ctx.client.query<{
      lifecycle: string;
      active_generation_id: string | null;
      generation_state: string | null;
    }>(
      `SELECT i.lifecycle, i.active_generation_id,
              g.state AS generation_state
         FROM kith.source_items i
         LEFT JOIN kith.processing_generations g
           ON g.id = i.active_generation_id AND g.space_id = i.space_id
        WHERE i.id = $1 AND i.space_id = $2 LIMIT 1`,
      [sourceItemId, spaceId],
    )
  ).rows[0];
  if (!row) return { sourceItemId, state: "not_found_or_forbidden" };
  if (
    row.lifecycle !== "available" ||
    row.active_generation_id === null ||
    row.generation_state !== "ready"
  ) {
    return {
      sourceItemId,
      state: "not_ready",
      reason:
        row.lifecycle !== "available"
          ? `source_${row.lifecycle}`
          : row.active_generation_id === null
            ? "no_active_processing_generation"
            : `processing_generation_${String(row.generation_state)}`,
    };
  }
  const scheduled = await scheduleDocumentExtractionRepair(ctx, {
    spaceId,
    sourceItemId,
    processingGenerationId: row.active_generation_id,
  });
  return {
    sourceItemId,
    state: scheduled.state,
    jobId: scheduled.id,
    processingGenerationId: row.active_generation_id,
  };
}

/** Sets or clears the durable classification and schedules the resulting read. */
export async function setDocumentClassification(
  ctx: IdentityCtx,
  input: {
    principal: Principal;
    spaceId: string;
    sourceItemId: string;
    kind: string | null;
  },
): Promise<RepairScheduleOutcome & { ownerDocumentKind: string | null }> {
  await requireSpaceAccess(ctx, input.principal, input.spaceId, "write");
  if (input.kind !== null) {
    const schema = await ctx.client.query(
      `SELECT 1 FROM kith.document_types
        WHERE space_id = $1 AND kind = $2 AND active LIMIT 1`,
      [input.spaceId, input.kind],
    );
    if (schema.rows.length === 0) {
      throw new IdentityError("Document schema not found");
    }
  }
  const changed = await ctx.client.query(
    `UPDATE kith.source_items SET owner_document_kind = $3
      WHERE id = $1 AND space_id = $2`,
    [input.sourceItemId, input.spaceId, input.kind],
  );
  if (changed.rowCount === 0) throw new IdentityError("Source item not found");
  return {
    ...(await scheduleCurrent(ctx, input.spaceId, input.sourceItemId)),
    ownerDocumentKind: input.kind,
  };
}

/** Schedules selected current ready items, including never-extracted items. */
export async function reprocessDocuments(
  ctx: IdentityCtx,
  input: {
    principal: Principal;
    spaceId: string;
    sourceItemIds: readonly string[];
  },
): Promise<{ outcomes: RepairScheduleOutcome[] }> {
  await requireSpaceAccess(ctx, input.principal, input.spaceId, "write");
  if (
    input.sourceItemIds.length < 1 ||
    input.sourceItemIds.length > MAX_REPAIR_ITEMS
  ) {
    throw new IdentityError(
      `sourceItemIds must contain from 1 to ${MAX_REPAIR_ITEMS} items`,
    );
  }
  const outcomes: RepairScheduleOutcome[] = [];
  for (const sourceItemId of [...new Set(input.sourceItemIds)]) {
    outcomes.push(await scheduleCurrent(ctx, input.spaceId, sourceItemId));
  }
  return { outcomes };
}
