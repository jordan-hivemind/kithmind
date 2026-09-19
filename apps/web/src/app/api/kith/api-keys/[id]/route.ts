// `DELETE /api/kith/api-keys/:id`: the settings page's revoke button.
//
// `identity.revokeApiKey` is the single revocation path required by section 6
// row i5: it checks the key belongs to the caller before it calls
// `deleteApiKey`, so this route never reaches a raw delete.

import {
  revokeApiKey,
  setApiKeyMaxSensitivity,
} from "@repo/kith-store/identity";

import {
  noContent,
  problem,
  readJsonBody,
  withPrincipal,
} from "@/lib/kith/api-route";

/** SENS-1. The closed ceiling set, as `POST /api/kith/api-keys` has it. */
type SensitivityChoice = "normal" | "sensitive" | "restricted";
const SENSITIVITY_CHOICES: readonly SensitivityChoice[] = [
  "normal",
  "sensitive",
  "restricted",
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    await revokeApiKey(ctx, { principal, id });
    return noContent();
  });
}

/**
 * `PATCH /api/kith/api-keys/:id`: change one key's sensitivity ceiling.
 *
 * SENS-1. Without this the only way to narrow a key that already exists is to
 * delete it and re-authorize every client using it, which in practice means
 * nobody ever narrows one.
 *
 * Owner session only. `withPrincipal` reads the session cookie and this route
 * family has no bearer path, and `setApiKeyMaxSensitivity` independently
 * refuses any principal carrying a `credentialId` -- so a bearer-authenticated
 * caller cannot reach it even if a future route wires it up wrong. A credential
 * that could raise its own ceiling would make the ceiling decorative.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await readJsonBody(request);
    if (body === null) return problem(400, "Invalid request");
    const maxSensitivity = body.maxSensitivity;
    if (
      typeof maxSensitivity !== "string" ||
      !SENSITIVITY_CHOICES.includes(maxSensitivity as SensitivityChoice)
    ) {
      return problem(400, "Invalid request");
    }
    await setApiKeyMaxSensitivity(ctx, {
      principal,
      id,
      maxSensitivity: maxSensitivity as SensitivityChoice,
    });
    return noContent();
  });
}
