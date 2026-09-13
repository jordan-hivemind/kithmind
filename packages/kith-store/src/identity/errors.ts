// One error type for the whole identity surface, carrying what a Convex
// function carries today.
//
// The Convex code throws two different things and the difference is load
// bearing, so both survive the port:
//
//   * `new Error("Not authenticated")` / `new Error("Space not found")`. A bare
//     message, deliberately non-enumerating: every authorization failure on a
//     space returns the same words whether the space is missing, the membership
//     is gone, the role is too low or the credential was never granted it. The
//     web and MCP surfaces match on that message today, so it is kept verbatim.
//   * `ConvexError({ code, message })`. A typed payload the client branches on:
//     `space_not_found`, `invalid_grant`, `invitation_expired` and the rest.
//
// `IdentityError` is both. `message` is what the bare-Error callers compare and
// `data` is what the typed callers read, so a caller ported in P2-39i keeps the
// comparison it already has.

export type IdentityErrorData = { code: string; message: string };

export class IdentityError extends Error {
  readonly data?: IdentityErrorData;

  constructor(message: string, data?: IdentityErrorData) {
    super(message);
    this.name = "IdentityError";
    if (data) this.data = data;
  }
}

/** `throw new Error("Not authenticated")`, the port's only spelling of it. */
export function notAuthenticated(): never {
  throw new IdentityError("Not authenticated");
}

/**
 * The one space-authorization failure. Missing space, missing membership,
 * duplicated membership, insufficient role and ungranted credential are all
 * this, on purpose: a caller must not be able to tell a space it may not see
 * from a space that does not exist.
 */
export function spaceNotFound(): never {
  throw new IdentityError("Space not found");
}

/**
 * The typed read denial (`lib/spaceReadErrors.ts`). Same words as
 * `spaceNotFound`, plus the payload the client matches on, which is why
 * `rethrowSpaceReadError` below can convert one into the other.
 */
export function spaceReadNotFound(): never {
  throw new IdentityError("Space not found", {
    type: "space_read_error",
    code: "space_not_found",
    message: "Space not found",
  } as IdentityErrorData);
}

/**
 * Passes a typed read denial through and promotes a bare "Space not found" into
 * one. Anything else is a bug and is rethrown unchanged rather than being
 * relabelled as an authorization failure.
 */
export function rethrowSpaceReadError(error: unknown): never {
  if (
    error instanceof IdentityError &&
    error.data?.code === "space_not_found"
  ) {
    throw error;
  }
  if (error instanceof IdentityError && error.message === "Space not found") {
    spaceReadNotFound();
  }
  throw error;
}

/** Builds a `code`-throwing helper over a fixed message table. */
export function errorThrower<Messages extends Record<string, string>>(
  messages: Messages,
): (code: keyof Messages & string) => never {
  return (code) => {
    throw new IdentityError(messages[code]!, {
      code,
      message: messages[code]!,
    });
  };
}

/** True when `error` is one of `messages`' codes, for a caller that rethrows. */
export function hasErrorCode(
  error: unknown,
  messages: Record<string, string>,
): boolean {
  return (
    error instanceof IdentityError &&
    error.data !== undefined &&
    Object.hasOwn(messages, error.data.code) &&
    error.data.message === messages[error.data.code]
  );
}
