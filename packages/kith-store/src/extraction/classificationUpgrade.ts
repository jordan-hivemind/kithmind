// Narrow, guarded upgrades for shipped document-classification guidance.
//
// `seedDocumentTypes` deliberately never changes an existing space. That is
// the right default for owner configuration, but it also means a corrected
// starter description would otherwise reach only new spaces. This module is
// the explicit operator path: recognize the exact guidance Kith Mind shipped,
// clone its current row and fields as a new version, and change only the two
// classifier texts. Owner-edited guidance is reported and left alone.

import type { DeferredCtx } from "../deferred/core.js";
import { newKithId } from "../ids.js";
import { STARTER_DOCUMENT_TYPES } from "./seed.js";

const KIND = "investment_agreement";

const LEGACY_DESCRIPTION =
  "A subscription agreement, SAFE, or convertible note for an investment.";
const LEGACY_GUIDANCE =
  "An agreement to invest in a company. Read the parties, the date it was signed, the amount committed, and the instrument terms if they are stated.";

const TARGET = (() => {
  const found = STARTER_DOCUMENT_TYPES.find((type) => type.kind === KIND);
  if (!found) throw new Error(`Starter schema ${KIND} is missing`);
  return found;
})();

type TypeRow = {
  id: string;
  description: string | null;
  area: string | null;
  guidance: string | null;
  examples: unknown;
  version: number;
  sensitivity: string;
  next_version: number;
};

type FieldRow = {
  name: string;
  value_type: string;
  required: boolean;
  check_kind: string | null;
  example: string | null;
};

export type InvestmentClassificationUpgradeResult = {
  kind: typeof KIND;
  status: "missing" | "eligible" | "applied" | "current" | "customized";
  fromVersion: number | null;
  toVersion: number | null;
};

/**
 * Version the shipped investment classifier without replacing owner text.
 *
 * Fields, model settings, bounds, locale settings, area and sensitivity are
 * copied from the space's current row. This makes the upgrade compose with an
 * independent field-schema change: only the exact legacy description and
 * guidance are the precondition, and only those two values change.
 */
export async function upgradeInvestmentAgreementClassification(
  ctx: DeferredCtx,
  input: { spaceId: string; apply: boolean },
): Promise<InvestmentClassificationUpgradeResult> {
  const current = (
    await ctx.client.query<TypeRow>(
      `SELECT dt.id, dt.description, dt.area, dt.guidance, dt.examples,
              dt.version, dt.sensitivity,
              (SELECT coalesce(max(all_versions.version), 0) + 1
                 FROM kith.document_types all_versions
                WHERE all_versions.space_id = dt.space_id
                  AND all_versions.kind = dt.kind) AS next_version
         FROM kith.document_types dt
        WHERE dt.space_id = $1 AND dt.kind = $2 AND dt.active
        ORDER BY dt.version DESC, dt.id DESC LIMIT 1`,
      [input.spaceId, KIND],
    )
  ).rows[0];
  if (!current) {
    return {
      kind: KIND,
      status: "missing",
      fromVersion: null,
      toVersion: null,
    };
  }
  if (
    current.description === TARGET.description &&
    current.guidance === TARGET.guidance
  ) {
    return {
      kind: KIND,
      status: "current",
      fromVersion: current.version,
      toVersion: current.version,
    };
  }
  if (
    current.description !== LEGACY_DESCRIPTION ||
    current.guidance !== LEGACY_GUIDANCE
  ) {
    return {
      kind: KIND,
      status: "customized",
      fromVersion: current.version,
      toVersion: null,
    };
  }
  if (!input.apply) {
    return {
      kind: KIND,
      status: "eligible",
      fromVersion: current.version,
      toVersion: current.next_version,
    };
  }

  const fields = (
    await ctx.client.query<FieldRow>(
      `SELECT name, value_type, required, check_kind, example
         FROM kith.document_type_fields
        WHERE space_id = $1 AND document_type_id = $2
        ORDER BY created_at, id`,
      [input.spaceId, current.id],
    )
  ).rows;
  const nextId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.document_types
       (id, space_id, kind, description, area, guidance, examples, version,
        active, sensitivity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
    [
      nextId,
      input.spaceId,
      KIND,
      TARGET.description,
      current.area,
      TARGET.guidance,
      JSON.stringify(current.examples ?? []),
      current.next_version,
      current.sensitivity,
    ],
  );
  for (const field of fields) {
    await ctx.client.query(
      `INSERT INTO kith.document_type_fields
         (id, space_id, document_type_id, name, value_type, required,
          check_kind, example)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newKithId(),
        input.spaceId,
        nextId,
        field.name,
        field.value_type,
        field.required,
        field.check_kind,
        field.example,
      ],
    );
  }
  return {
    kind: KIND,
    status: "applied",
    fromVersion: current.version,
    toVersion: current.next_version,
  };
}
