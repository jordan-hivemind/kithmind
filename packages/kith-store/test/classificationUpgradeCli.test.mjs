import assert from "node:assert/strict";
import test from "node:test";

import { argumentsFor } from "../dist/extraction/classificationUpgradeCli.js";

test("classification upgrade CLI is a dry run unless apply is explicit", () => {
  assert.deepEqual(argumentsFor([]), { spaceId: null, apply: false });
  assert.deepEqual(argumentsFor(["--apply"]), { spaceId: null, apply: true });
  assert.deepEqual(
    argumentsFor(["--", "--space", "aaaaaaaaaaaaaaaaaaaaaaaaaa"]),
    {
      spaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      apply: false,
    },
  );
});
