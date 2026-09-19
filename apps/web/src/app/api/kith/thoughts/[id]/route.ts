// `PATCH /api/kith/thoughts/:id` edits a thought through the existing
// supersession mechanism (`memory.updateThought`); `DELETE` soft-deletes it
// through the existing retraction mechanism (`memory.deleteThought`), which
// preserves the row and clears the embedding target rather than destroying
// anything. Owner or editor only -- `writableThought` in
// `lib/kith/memory-write.ts` applies the same `requireSpaceAccess(write)`
// rule every other `/api/kith/*` write does, and a thought in a space this
// principal may not write answers the same "not found" a missing id would.
//
// `content` is bounded by `memory.normalizeCaptureContent`, the same 2,000
// character cap and empty-string refusal `POST .../thoughts/capture` applies
// -- an edit is not exempt from the bound a fresh capture has always had.
// `topics`/`people` are bounded by `memory.uniqueStrings`, the same
// dedup/trim/200-characters-per-item/count-capped (3 topics, 10 people) rule
// `normalizeThoughtMetadata` uses for a captured thought's own metadata.

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

const MAX_TOPICS = 3;
const MAX_PEOPLE = 10;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const type = typeof body.type === "string" ? body.type : "";
    if (typeof body.content !== "string" || !THOUGHT_TYPES.has(type)) {
      return problem(400, "Invalid request", "invalid_input");
    }
    const content = memory.normalizeCaptureContent(body.content);
    const topics = memory.uniqueStrings(body.topics, MAX_TOPICS);
    const people = memory.uniqueStrings(body.people, MAX_PEOPLE);
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
