// `POST /api/kith/source-accounts`: the settings page's "Add source account"
// form, wired to `sources.createSourceAccount`.

import { sources } from "@repo/kith-store";

import { noStoreJson, problem, readJsonBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const connector = body === null ? undefined : text(body.connector);
  const accountId = body === null ? undefined : text(body.accountId);
  const name = body === null ? undefined : text(body.name);
  if (connector === undefined || accountId === undefined || name === undefined) {
    return problem(400, "Invalid request");
  }
  const spaceId = body === null ? undefined : text(body.spaceId);
  const freshnessMs = body === null ? undefined : num(body.freshnessMs);
  return withPrincipal(request, async ({ ctx, principal }) => {
    const id = await sources.createSourceAccount(ctx, {
      principal,
      connector,
      accountId,
      name,
      ...(spaceId === undefined ? {} : { spaceId }),
      ...(freshnessMs === undefined ? {} : { freshnessMs }),
    });
    return noStoreJson({ id }, 201);
  });
}
