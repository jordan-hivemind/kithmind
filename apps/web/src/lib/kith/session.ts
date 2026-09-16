// The cookie signing configuration, built here and passed in.
//
// `@repo/kith-store`'s `webAuth.ts` never reads its own secret, by design: "a
// library that reads its own secret is a library that silently works with the
// wrong one". This is the other half of that decision. The route reads
// `KITH_SESSION_SECRET`, refuses a short one, and hands the library a
// `SessionConfig` per request.
//
// There is no default and there never may be one. A defaulted signing key means
// every deployment that forgot to configure one shares it, and a cookie signed
// under it verifies everywhere, which is indistinguishable from no signature at
// all. A missing secret is a 500, loudly, at the first request that needs it.

import type { SessionConfig } from "@repo/kith-store/identity";

/** The library's own floor, restated so the refusal happens at the edge. */
export const MIN_SESSION_SECRET_LENGTH = 32;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether the cookie carries `Secure`.
 *
 * True everywhere except an explicitly non-production build. Section 2.1 of the
 * surface plan leaves `secure` at its default so `Secure` is always set, and
 * allows a plain-HTTP local run to pass `secure: false` from a
 * development-only branch. This is that branch, and it is keyed on
 * `NODE_ENV === "development"`, which Next.js sets for `next dev` and never for
 * `next build`. Note that `__Host-` requires `Secure`, so a development run
 * without HTTPS is the only case where the cookie is not host-prefixed in
 * effect.
 */
function secureCookie(env: Environment): boolean {
  return env.NODE_ENV !== "development";
}

/**
 * The signing configuration for one request, or a thrown error.
 *
 * The message names the variable and its requirement and never its value, so it
 * is safe in a log or a 500 body.
 */
export function kithSessionConfig(
  env: Environment = process.env,
): SessionConfig {
  const secret = env.KITH_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `KITH_SESSION_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    );
  }
  return { secret, secure: secureCookie(env) };
}
