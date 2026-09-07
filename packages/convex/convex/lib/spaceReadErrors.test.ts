import { describe, expect, test } from "vitest";

import {
  parseSpaceReadErrorData,
  rethrowSpaceReadError,
} from "./spaceReadErrors";

const validError = {
  type: "space_read_error",
  code: "space_not_found",
  message: "Space not found",
} as const;

describe("space read errors", () => {
  test("accepts only the exact closed error payload", () => {
    expect(parseSpaceReadErrorData(validError)).toEqual(validError);

    const hiddenExtra = { ...validError };
    Object.defineProperty(hiddenExtra, "detail", {
      value: "sensitive-space-id",
    });
    const accessorField = {
      code: validError.code,
      message: validError.message,
      get type() {
        return validError.type;
      },
    };

    for (const value of [
      undefined,
      null,
      [],
      { ...validError, detail: "sensitive-space-id" },
      { code: validError.code, message: validError.message },
      { ...validError, type: "other_error" },
      { ...validError, code: "not_authenticated" },
      { ...validError, message: "Space sensitive-space-id not found" },
      hiddenExtra,
      accessorField,
    ]) {
      expect(parseSpaceReadErrorData(value)).toBeUndefined();
    }
  });

  test("does not convert malformed structured errors with a safe-looking message", () => {
    const malformed = Object.assign(new Error("Space not found"), {
      data: { ...validError, detail: "sensitive-space-id" },
    });
    let rejected: unknown;

    try {
      rethrowSpaceReadError(malformed);
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBe(malformed);
  });
});
