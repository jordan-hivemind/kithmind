// The settings page's API key list and creation, on PostgreSQL.
//
// `GET` is the paginated read `identity.listApiKeysPage` already implements as
// a keyset cursor (section 2.3 of the surface plan); `POST` is
// `identity.createApiKey`. Both run inside `withPrincipal`, which reloads the
// session from the cookie rather than trusting the page that rendered the
// form, and both are the settings page's own transaction, separate from the
// one the page used to render its first paint.

import {
  type Capability,
  createApiKey,
  listApiKeysPage,
} from "@repo/kith-store/identity";

import {
  noStoreJson,
  problem,
  readJsonBody,
  withPrincipal,
} from "@/lib/kith/api-route";

const CAPABILITIES: readonly Capability[] = ["read", "write", "ingest"];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 50;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const numItemsRaw = Number(url.searchParams.get("numItems") ?? "25");
  const numItems =
    Number.isInteger(numItemsRaw) && numItemsRaw > 0 && numItemsRaw <= MAX_PAGE_SIZE
      ? numItemsRaw
      : 25;
  const cursor = url.searchParams.get("cursor");
  return withPrincipal(request, async ({ ctx, principal }) => {
    const page = await listApiKeysPage(ctx, {
      principal,
      numItems,
      cursor,
    });
    return noStoreJson(page);
  });
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}

/** `null` unless every entry is one of the three known capability literals. */
function capabilityArray(value: unknown): Capability[] | null {
  const strings = stringArray(value);
  if (strings === null) return null;
  return strings.every((item): item is Capability =>
    CAPABILITIES.includes(item as Capability),
  )
    ? strings
    : null;
}

export async function POST(request: Request): Promise<Response> {
  // The body is read and validated inside `withPrincipal`'s callback, not
  // before it: the second-model review of P2-39i5 found that reading it
  // first let a request with the wrong content type reach this route's own
  // validation and fail there with a 400 before `withPrincipal`'s same-origin
  // and content-type guard ever ran, which is the guard silently skipped for
  // every route shaped this way. The guard must run first regardless of what
  // the route needs from the body.
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const name = typeof body.name === "string" ? body.name : null;
    const spaceIds = stringArray(body.spaceIds);
    const capabilities = capabilityArray(body.capabilities);
    const sourceAccountIds = stringArray(body.sourceAccountIds) ?? [];
    if (name === null || spaceIds === null || capabilities === null) {
      return problem(400, "Invalid request");
    }
    // The service validates every capability and space against the
    // principal's own authority; the route's own check above only narrows the
    // capability strings to the closed set, never the spaces.
    const created = await createApiKey(ctx, {
      principal,
      name,
      capabilities,
      spaceIds,
      sourceAccountIds,
    });
    return noStoreJson(created, 201);
  });
}
