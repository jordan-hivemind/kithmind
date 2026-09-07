import { ConvexError } from "convex/values";

export type SpaceReadErrorData = {
  type: "space_read_error";
  code: "space_not_found";
  message: "Space not found";
};

const SPACE_NOT_FOUND: SpaceReadErrorData = {
  type: "space_read_error",
  code: "space_not_found",
  message: "Space not found",
};

const SPACE_READ_ERROR_KEYS = ["code", "message", "type"] as const;

export function parseSpaceReadErrorData(
  value: unknown,
): SpaceReadErrorData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== SPACE_READ_ERROR_KEYS.length ||
    SPACE_READ_ERROR_KEYS.some((key) => !Object.hasOwn(value, key))
  ) {
    return undefined;
  }
  const data = Object.fromEntries(
    SPACE_READ_ERROR_KEYS.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return [
        key,
        descriptor && "value" in descriptor ? descriptor.value : undefined,
      ];
    }),
  );
  if (
    data.type !== SPACE_NOT_FOUND.type ||
    data.code !== SPACE_NOT_FOUND.code ||
    data.message !== SPACE_NOT_FOUND.message
  ) {
    return undefined;
  }
  return SPACE_NOT_FOUND;
}

export function spaceReadNotFound(): never {
  throw new ConvexError(SPACE_NOT_FOUND);
}

function errorData(error: unknown): unknown {
  return typeof error === "object" && error !== null && "data" in error
    ? error.data
    : undefined;
}

export function rethrowSpaceReadError(error: unknown): never {
  if (parseSpaceReadErrorData(errorData(error))) throw error;
  if (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    !("data" in error) &&
    error.message === SPACE_NOT_FOUND.message
  ) {
    spaceReadNotFound();
  }
  throw error;
}
