// The session cookie's MAC check, restated on Web Crypto for the edge runtime.
//
// Section 2.3 of the web and MCP surface plan puts a cookie check in the
// middleware and nothing else: no database, because Next.js middleware runs on
// the edge runtime and `pg` does not. The same sentence rules out calling
// `parseSessionToken` from `@repo/kith-store/identity` directly, for two
// reasons that both have to be fixed at once:
//
//   - `parseSessionToken` verifies with `node:crypto`'s `createHmac` and
//     `timingSafeEqual`, neither of which the edge runtime provides.
//   - importing anything from `@repo/kith-store/identity` pulls the store's
//     `pg` pool into the middleware bundle, which is the thing the plan is
//     avoiding.
//
// So this is a second implementation of one security check, which is a drift
// risk and is treated as one. `cookie.test.ts` runs in Node, imports both this
// module and the real serializer and production/development cookie names from
// the store, and asserts that this accepts exactly what the store produces and
// rejects everything else. The two cannot diverge without that test failing.
//
// `crypto.subtle.verify` rather than recomputing the MAC and comparing strings:
// it compares in constant time internally, which is the property
// `timingSafeEqual` supplies on the Node side.

/**
 * The cookie names, restated. `cookie.test.ts` asserts that both equal the
 * store's names, so they cannot drift from what the routes actually set.
 */
export const KITH_SESSION_COOKIE_NAME = "__Host-kith_session";
export const KITH_DEVELOPMENT_SESSION_COOKIE_NAME = "kith_session";

/** 32 random bytes as hex, which is what `createSession` issues. */
const TOKEN = /^[0-9a-f]{64}$/;

/** HMAC-SHA-256 as base64url: 32 bytes, unpadded. */
const MAC = /^[A-Za-z0-9_-]{43}$/;

/**
 * The session cookie's raw value out of a `Cookie` header.
 *
 * The same rules as the store's `readSessionCookie`, and written out for the
 * same reason: the header is a trust boundary. Only the exact cookie name
 * matches, a repeated cookie takes the first value as browsers send it, and
 * nothing else in the header is read.
 */
export function readKithSessionCookie(
  header: string | null | undefined,
  development = false,
): string | null {
  if (typeof header !== "string") return null;
  const name = development
    ? KITH_DEVELOPMENT_SESSION_COOKIE_NAME
    : KITH_SESSION_COOKIE_NAME;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The token inside a cookie value, or null when the MAC does not verify.
 *
 * A valid MAC over an unknown, expired or revoked token returns the token here
 * and is refused later by `requireWebPrincipal`, which does read the database.
 * That split is deliberate and is section 2.3's: the middleware is a cheap
 * forgery filter, not the authorization boundary, and no page or route may
 * treat having passed it as having been authenticated.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function verifyKithSessionCookie(
  secret: string,
  value: string | null | undefined,
): Promise<string | null> {
  if (typeof secret !== "string" || secret.length < 32) return null;
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, token, mac] = parts as [string, string, string];
  if (!TOKEN.test(token) || !MAC.test(mac)) return null;
  const signature = base64UrlToBytes(mac);
  if (signature === null || signature.length !== 32) return null;
  // The store compares the MAC as text. A 43-character base64url string
  // carries two padding bits in its last character, so several strings
  // decode to the same 32 bytes; Web Crypto would verify all of them, the
  // store accepts exactly one. Requiring the presented text to be the
  // canonical encoding of its own bytes keeps the two checks equivalent, and
  // it compares public data, so timing does not matter here.
  if (bytesToBase64Url(signature) !== mac) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    new TextEncoder().encode(token),
  );
  return verified ? token : null;
}
