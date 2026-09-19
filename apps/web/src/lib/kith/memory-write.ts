// The write-authorization `/api/kith/thoughts/[id]` and `/api/kith/facts/[id]`
// share: resolve the row's own space, then require write access to it -- owner
// or editor, the same rule every other `/api/kith/*` write applies -- and fold
// "no such row" and "no access to its space" into the same denial so a
// stranger cannot tell them apart.
//
// `memory.updateThought`/`deleteThought`/`updateFact`/`retireFact` take an
// already-authorized `spaceId`, matching every function in
// `packages/kith-store/src/memory/{thoughts,facts}.ts` (see those modules'
// comments: space authorization is always the caller's job). This is where
// that authorization happens for these two routes, the way
// `lib/kith/capture.ts` does it for narrative capture -- at the web layer,
// not inside the memory domain, which stays reusable by the MCP tools and
// their own re-authorization.

import { memory } from "@repo/kith-store";
import {
  type IdentityCtx,
  IdentityError,
  type Principal,
  requireSpaceAccess,
} from "@repo/kith-store/identity";

function thoughtNotFound(): never {
  throw new IdentityError("Thought not found");
}

function factNotFound(): never {
  throw new IdentityError("Fact not found");
}

async function requireWrite(
  ctx: IdentityCtx,
  principal: Principal,
  spaceId: string,
  notFound: () => never,
): Promise<void> {
  try {
    await requireSpaceAccess(ctx, principal, spaceId, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      notFound();
    }
    throw error;
  }
}

/** The current thought this principal may write, or a non-enumerating denial. */
export async function writableThought(
  ctx: IdentityCtx,
  principal: Principal,
  thoughtId: string,
): Promise<memory.Thought> {
  const thought = await memory.getThoughtById(ctx, thoughtId);
  if (!thought || !memory.isCurrentMemory(thought.memoryStatus))
    thoughtNotFound();
  await requireWrite(ctx, principal, thought.spaceId, thoughtNotFound);
  return thought;
}

/** The current fact this principal may write, or a non-enumerating denial. */
export async function writableFact(
  ctx: IdentityCtx,
  principal: Principal,
  factId: string,
): Promise<memory.StoredFact> {
  const fact = await memory.getStoredFact(ctx, factId);
  if (!fact || fact.status !== "current") factNotFound();
  await requireWrite(ctx, principal, fact.spaceId, factNotFound);
  return fact;
}
