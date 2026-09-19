// `PATCH /api/kith/thoughts/:id` edits a thought through the existing
// supersession mechanism (`memory.updateThought`); `DELETE` soft-deletes it
// through the existing retraction mechanism (`memory.deleteThought`), which
// preserves the row and clears the embedding target rather than destroying
// anything. Owner or editor only -- `writableThought` in
// `lib/kith/memory-write.ts` applies the same `requireSpaceAccess(write)`
// rule every other `/api/kith/*` write does, and a thought in a space this
// principal may not write answers the same "not found" a missing id would.

import { memory } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  problem,
  readJsonBody,
  withPrincipal,
} from "@/lib/kith/api-route";
import { writableThought } from "@/lib/kith/memory-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THOUGHT_TYPES = new Set<string>([
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
]);

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const type = typeof body.type === "string" ? body.type : "";
    const topics = stringArray(body.topics);
    const people = stringArray(body.people);
    if (
      content === "" ||
      !THOUGHT_TYPES.has(type) ||
      topics === undefined ||
      people === undefined
    ) {
      return problem(400, "Invalid request", "invalid_input");
    }
    const target = await writableThought(ctx, principal, id);
    // The edit is a supersession (see `memory.updateThought`), so it stores
    // under a new id rather than this one. The caller needs that id back to
    // patch its own optimistic cache without a refetch.
    const thoughtId = await memory.updateThought(
      ctx,
      principal.userId,
      target.spaceId,
      id,
      {
        content,
        type: type as memory.ThoughtType,
        topics,
        people,
      },
    );
    return noStoreJson({ thoughtId });
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const target = await writableThought(ctx, principal, id);
    await memory.deleteThought(ctx, target.spaceId, id);
    return noContent();
  });
}
