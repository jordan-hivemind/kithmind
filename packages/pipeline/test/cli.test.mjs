import assert from "node:assert/strict";
import test from "node:test";

import { argumentsFor } from "../dist/cli.js";

test("the root pnpm alias forwarding separator is consumed exactly once", () => {
  assert.deepEqual(
    argumentsFor(["--", "run", "--config", "/tmp/config.json"]),
    {
      command: "run",
      configPath: "/tmp/config.json",
    },
  );
  assert.deepEqual(argumentsFor(["watch", "--config", "/tmp/config.json"]), {
    command: "watch",
    configPath: "/tmp/config.json",
  });
  assert.throws(() =>
    argumentsFor(["--", "--", "run", "--config", "/tmp/config.json"]),
  );
});
