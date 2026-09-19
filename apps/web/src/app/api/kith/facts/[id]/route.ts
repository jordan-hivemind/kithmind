// `PATCH /api/kith/facts/:id` edits a fact's value through the existing
// versioning path (`memory.updateFact`), defaulting to `changeKind: "changed"`
// (the old value stays reachable as history) with `"corrected"` available for
// a value that was simply wrong (the old value is withheld even from
// history) -- see `memory.UpdateFactArgs`'s own comment for exactly what each
// one preserves. `DELETE` retires the fact -- ends its validity without
// erasing it (`memory.retireFact`), distinct from either edit branch because
// nothing about the value was wrong. Owner or editor only, the same rule
// every other `/api/kith/*` write applies; `writableFact` in
// `lib/kith/memory-write.ts` answers the same "not found" for a fact this
// principal may not write and one that does not exist.
//
// The value's `type` is read from the stored fact, never from the request
// body: the edit form only ever offers the fact's own type back, and an
// entity- or datetime-valued fact has no editable form yet (`validFactValue`
// returns null for both, which becomes 400 rather than a silent type change).

import { memory } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  problem,
  readJsonBody,
  withPrincipal,
} from "@/lib/kith/api-route";
import { writableFact } from "@/lib/kith/memory-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANGE_KINDS = new Set(["changed", "corrected"]);

/** The one editable value for `fact.value.type`, or null when the shape is
 * wrong or the type has no editable form (`entity`, `datetime`). */
function validFactValue(
  type: memory.FactValue["type"],
  body: Record<string, unknown>,
): memory.FactValueInput | null {
  const raw = body.value;
  switch (type) {
    case "text":
      return typeof raw === "string" && raw.trim() !== ""
        ? { type: "text", value: raw }
        : null;
    case "date":
      return typeof raw === "string" ? { type: "date", value: raw } : null;
    case "boolean":
      return typeof raw === "boolean" ? { type: "boolean", value: raw } : null;
    case "number": {
      if (typeof raw !== "number") return null;
      const unit = typeof body.unit === "string" ? body.unit : undefined;
      return {
        type: "number",
        value: raw,
        ...(unit === undefined ? {} : { unit }),
      };
    }
    default:
      return null;
  }
}

/** `undefined` (no date given), an epoch millisecond, or `"invalid"`. The
 * drawer converts its date input to an epoch millisecond client-side, so this
 * only has to check the shape -- `memory.rememberFact`'s own
 * `assertValidMemoryValidity` is what actually validates the value. */
function parseOptionalValidFrom(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : "invalid";
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const changeKind = body.changeKind === undefined ? "changed" : body.changeKind;
    if (typeof changeKind !== "string" || !CHANGE_KINDS.has(changeKind)) {
      return problem(400, "Invalid request", "invalid_input");
    }
    const validFrom = parseOptionalValidFrom(body.validFrom);
    if (validFrom === "invalid") return problem(400, "Invalid request", "invalid_input");
    const target = await writableFact(ctx, principal, id);
    const value = validFactValue(target.value.type, body);
    if (value === null) return problem(400, "Invalid request", "invalid_input");
    const result = await memory.updateFact(ctx, principal.userId, target.spaceId, id, {
      value,
      sourceType: "user_confirmed",
      changeKind: changeKind as "changed" | "corrected",
      ...(validFrom === undefined ? {} : { validFrom }),
    });
    return noStoreJson({ factId: result.factId, operation: result.operation });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const target = await writableFact(ctx, principal, id);
    await memory.retireFact(ctx, target.spaceId, id);
    return noContent();
  });
}
