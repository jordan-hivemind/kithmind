// Synthetic-fixture unit tests for `loadBindings`: filters the old
// filesystem worker's identity registry to one root alias, validates the
// shape the way `packages/pipeline/src/runnerState.ts`'s own journal codec
// would (UUID external ids, unique paths, unique external ids), and fails
// closed with a clear message on a malformed or foreign file. No database.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadBindings } from "../dist/bindings.js";

async function tempJson(t, value) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-bindings-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("loadBindings keeps only entries for the given root alias", async (t) => {
  const idA = randomUUID();
  const idB = randomUUID();
  const idOther = randomUUID();
  const path = await tempJson(t, {
    version: 1,
    binding: { endpoint: "https://example.test", spaceId: "s", sourceAccountId: "a" },
    credentialSalt: "salt",
    credentialFingerprint: "fp",
    credentialSessionActive: false,
    checkpoint: {
      version: 1,
      phase: "terminal",
      outcome: "complete",
      credentialSessionActive: false,
      scanned: 3,
      published: 3,
      bindings: [
        { rootAlias: "dropbox", relativePath: "Statements/2025/january.pdf", externalId: idA },
        { rootAlias: "dropbox", relativePath: "Statements/2025/february.pdf", externalId: idB, providerFileId: "id:abc123" },
        { rootAlias: "other-root", relativePath: "Statements/2025/january.pdf", externalId: idOther },
      ],
    },
  });

  const result = await loadBindings(path, "dropbox");
  assert.equal(result.loaded, 2);
  assert.equal(result.map.size, 2);
  assert.equal(result.map.get("Statements/2025/january.pdf"), idA);
  assert.equal(result.map.get("Statements/2025/february.pdf"), idB);
  assert.equal(result.map.has("Statements/2025/march.pdf"), false);

  const empty = await loadBindings(path, "no-such-root");
  assert.equal(empty.loaded, 0);
  assert.equal(empty.map.size, 0);
});

test("loadBindings returns zero entries for a checkpoint with no bindings field", async (t) => {
  const path = await tempJson(t, {
    version: 1,
    binding: { endpoint: "https://example.test", spaceId: "s", sourceAccountId: "a" },
    credentialSalt: "salt",
    credentialFingerprint: "fp",
    credentialSessionActive: false,
    checkpoint: { version: 1, phase: "idle" },
  });

  const result = await loadBindings(path, "dropbox");
  assert.equal(result.loaded, 0);
});

test("loadBindings accepts a bare checkpoint object (no journal envelope)", async (t) => {
  const id = randomUUID();
  const path = await tempJson(t, {
    version: 1,
    phase: "terminal",
    bindings: [{ rootAlias: "dropbox", relativePath: "note.txt", externalId: id }],
  });

  const result = await loadBindings(path, "dropbox");
  assert.equal(result.loaded, 1);
  assert.equal(result.map.get("note.txt"), id);
});

test("loadBindings fails closed on a non-UUID externalId", async (t) => {
  const path = await tempJson(t, {
    checkpoint: {
      bindings: [{ rootAlias: "dropbox", relativePath: "note.txt", externalId: "not-a-uuid" }],
    },
  });
  await assert.rejects(() => loadBindings(path, "dropbox"), /is not valid/);
});

test("loadBindings fails closed on a duplicate path within one root alias", async (t) => {
  const path = await tempJson(t, {
    checkpoint: {
      bindings: [
        { rootAlias: "dropbox", relativePath: "note.txt", externalId: randomUUID() },
        { rootAlias: "dropbox", relativePath: "note.txt", externalId: randomUUID() },
      ],
    },
  });
  await assert.rejects(() => loadBindings(path, "dropbox"), /duplicate binding/);
});

test("loadBindings fails closed on a duplicate externalId across roots", async (t) => {
  const sharedId = randomUUID();
  const path = await tempJson(t, {
    checkpoint: {
      bindings: [
        { rootAlias: "dropbox", relativePath: "a.txt", externalId: sharedId },
        { rootAlias: "other", relativePath: "b.txt", externalId: sharedId },
      ],
    },
  });
  await assert.rejects(() => loadBindings(path, "dropbox"), /duplicate externalId/);
});

test("loadBindings fails closed on an unrecognized key", async (t) => {
  const path = await tempJson(t, {
    checkpoint: {
      bindings: [{ rootAlias: "dropbox", relativePath: "a.txt", externalId: randomUUID(), extra: "nope" }],
    },
  });
  await assert.rejects(() => loadBindings(path, "dropbox"), /unexpected shape/);
});

test("loadBindings fails closed on invalid JSON", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-bindings-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, "state.json");
  await writeFile(path, "{ not json");
  await assert.rejects(() => loadBindings(path, "dropbox"), /not valid JSON/);
});

test("loadBindings fails with a clear message when the file does not exist", async () => {
  await assert.rejects(
    () => loadBindings("/nonexistent/path/state.json", "dropbox"),
    /Cannot read bindings file/,
  );
});
