// `kith-deferred-work`'s argument parser (`src/deferred/cli.ts`). The parser
// tests need no database, so they run in every clone including one with no
// Postgres configured -- the same reasoning `serializationBackoff.test.mjs`
// gives for its own database-free tests.
//
// The last test is the exception and skips without one. P2-39j2 gave the
// daemon a second thing to wire besides the connection string -- the provider
// environment the `embedding_fill` handler embeds with -- and a registry built
// without it would leave every fill failing on a daemon whose provider is
// configured correctly. Only running `main` proves that wiring.

import assert from "node:assert/strict";
import test from "node:test";

import { createKithPool, withKithTransaction } from "../dist/index.js";
import { argumentsFor, main } from "../dist/deferred/cli.js";
import { EMBEDDING_PROVIDER_REQUEST_ERROR } from "../dist/embeddings/index.js";
import { identityCtx } from "../dist/identity/index.js";
import { captureThought } from "../dist/memory/index.js";
import { seedActiveEmbeddingIndex } from "./helpers/embeddingFixture.mjs";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

/**
 * `argumentsFor` rejects a bad flag through `usage()`, which writes to
 * stderr and calls `process.exit(2)` -- fine for the real CLI, fatal for a
 * test process. This runs `fn` with `process.exit` and `process.stderr.write`
 * replaced so the call is observed instead of actually tearing down the test
 * runner, and returns the exit code `fn` triggered, or `null` if it never
 * called `process.exit`.
 */
function exitCodeOf(fn) {
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  let code = null;
  process.exit = (status) => {
    code = status;
    throw new Error(`process.exit(${status})`);
  };
  process.stderr.write = () => true;
  try {
    fn();
    return null;
  } catch {
    return code;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalWrite;
  }
}

test("once takes no flags", () => {
  assert.deepEqual(argumentsFor(["once"]), { command: "once" });
});

test("tick and drain default --interval-ms to null (run once)", () => {
  assert.deepEqual(argumentsFor(["tick"]), {
    command: "tick",
    intervalMs: null,
  });
  assert.deepEqual(argumentsFor(["drain"]), {
    command: "drain",
    intervalMs: null,
    maxJobs: null,
  });
});

test("--interval-ms accepts a value at or above the 1000ms floor", () => {
  assert.deepEqual(argumentsFor(["tick", "--interval-ms", "1000"]), {
    command: "tick",
    intervalMs: 1000,
  });
  assert.deepEqual(argumentsFor(["drain", "--interval-ms", "5000"]), {
    command: "drain",
    intervalMs: 5000,
    maxJobs: null,
  });
});

test("--interval-ms below the 1000ms floor exits rather than busy-looping the pool", () => {
  for (const value of ["1", "999"]) {
    const code = exitCodeOf(() =>
      argumentsFor(["tick", "--interval-ms", value]),
    );
    assert.equal(code, 2, `--interval-ms ${value} should exit(2)`);
  }
});

test("--max-jobs is unaffected by the --interval-ms floor", () => {
  assert.deepEqual(argumentsFor(["drain", "--max-jobs", "1"]), {
    command: "drain",
    intervalMs: null,
    maxJobs: 1,
  });
  // --max-jobs itself still has to be a positive integer, just not subject to
  // the 1000ms floor that only applies to --interval-ms.
  const code = exitCodeOf(() => argumentsFor(["drain", "--max-jobs", "0"]));
  assert.equal(code, 2);
});

/**
 * Runs `main` with `process.env` standing in for the daemon's own: this
 * throwaway database, and no provider at all.
 *
 * Every `BRAIN_EMBED_*` name and `OPENAI_API_KEY` are removed for the call.
 * That is what makes the assertion below deterministic and, more importantly,
 * what guarantees this test cannot reach a provider on a machine that happens
 * to have a key exported: `requestEmbedding` refuses a keyless default
 * endpoint before it calls `fetch`.
 */
async function runDaemon(databaseUrl, argv) {
  const overridden = {
    KITH_STORE_DATABASE_URL: databaseUrl,
    BRAIN_EMBED_ENDPOINT: undefined,
    BRAIN_EMBED_API_KEY: undefined,
    BRAIN_EMBED_PROVIDER_ID: undefined,
    BRAIN_EMBED_MODEL: undefined,
    BRAIN_EMBED_MODEL_REVISION: undefined,
    BRAIN_EMBED_DIMENSIONS: undefined,
    OPENAI_API_KEY: undefined,
  };
  const saved = new Map();
  for (const [name, value] of Object.entries(overridden)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const written = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, summary: JSON.parse(written.join("").trim()) };
  } finally {
    process.stdout.write = originalWrite;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test(
  "drain runs embedding_fill through an embedder built from the daemon's environment",
  { skip },
  async (t) => {
    const database = await identityDatabase(t);
    const pool = createKithPool(database.databaseUrl, 2);
    pool.on("error", () => {});
    // A capture is what queues the job, and it also makes the space owe a
    // target: without one the fill returns on its first read page and never
    // reaches an embedder at all, which would make this test pass for the
    // wrong reason.
    await withKithTransaction(pool, async (client) => {
      const ctx = identityCtx(client, Date.now());
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      await seedActiveEmbeddingIndex(ctx, spaceId, {
        eligible: { thought: 0, chunk: 0, card: 0 },
      });
      await captureThought(ctx, userId, spaceId, {
        content: "alpha memory",
        metadata: {
          type: "reference",
          topics: ["synthetic"],
          people: [],
          actionItems: [],
          summary: "alpha memory",
        },
      });
    });
    await pool.end();

    const { code, summary } = await runDaemon(database.databaseUrl, ["drain"]);

    // The round itself succeeded; the job inside it failed, which is ordinary
    // operation and not a nonzero exit.
    assert.equal(code, 0);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.unregisteredKind, 0);
    assert.equal(summary.retrying, 1);
    assert.equal(summary.outcomes[0].kind, "embedding_fill");

    // The handler ran and reached the environment-built embedder, which failed
    // because this process configures no provider. Registered but unconfigured
    // is a different outcome from unregistered, and the fixed error text is
    // what says which one happened -- and that it carries nothing from a
    // provider.
    const failed = await database.client.query(
      "SELECT last_error FROM kith.deferred_work WHERE kind = 'embedding_fill'",
    );
    assert.equal(failed.rows[0].last_error, EMBEDDING_PROVIDER_REQUEST_ERROR);
  },
);
