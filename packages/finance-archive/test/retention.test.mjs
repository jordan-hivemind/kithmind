// F1-23: the credential-free projection, and the negative tests that are the
// point of it.
//
// Every assertion here is a count, a hash, a path name or a boolean. No test
// in this file prints a payload, and the credential-shaped fixture material
// is one obviously-fake canary string with a prefix naming the shape it
// stands for -- no real token format, nothing that could be mistaken for a
// live secret, no real institution, account, person or path.
//
// The load-bearing assertions run against the **bytes on disk**, not against
// what the projection function returned. A projection that returns clean
// output while something else writes the original is exactly the bug this
// task exists to prevent, so the tests read the raw tree back.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  adapterPullToImportDocuments,
  createSyntheticSession,
  openArchive,
  persistAcquiredDocument,
  readCaptureManifest,
  resolveRawTreeRoot,
  retainPayload,
  RetentionShapeError,
  sha256HexOf,
  syntheticAdapter,
  SYNTHETIC_INSTITUTION_NAME,
  SYNTHETIC_INSTITUTION_SLUG,
  SYNTHETIC_LEAK_CANARY,
  writeRawDocument,
} from "../dist/index.js";

import { archive as pgArchive, skip } from "./helpers/pgArchive.mjs";

const INSTITUTION = {
  id: "inst_synthetic_f1_23",
  name: SYNTHETIC_INSTITUTION_NAME,
  slug: SYNTHETIC_INSTITUTION_SLUG,
};
const ACCOUNT = { id: "acct_synthetic_f1_23", last4: "0000" };

// Synthetic space id (F1-28): not a real space, just what exercises the
// shared-root prefix this suite writes and reads through.
const SPACE_ID = "space_synthetic_test";

function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-retention-db-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", "USD");
  return db;
}

/**
 * The Postgres half. `persistAcquiredDocument` is still on a SQLite handle
 * (F1-24 owns that path and is changing it concurrently), while
 * `adapterPullToImportDocuments` is on the archive client, so the one test
 * below that spans both seams holds both. It collapses to one handle when
 * F1-24 lands.
 */
async function pgSeeded(t) {
  const client = await pgArchive(t);
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, "Synthetic account", "USD"],
  );
  return client;
}

function rawRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-retention-raw-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: directory,
    FINANCE_ARCHIVE_SPACE_ID: SPACE_ID,
  });
}

/** Every file under `directory`, recursively. `directory` itself may not
 * exist yet -- the scoped archive/v1/<spaceId> root is only created lazily
 * on a first write (rawTree.ts), so a refused write that landed nothing on
 * disk can mean the directory was never created at all, which is still
 * zero files, not an error. */
function everyFile(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...everyFile(path));
    else found.push(path);
  }
  return found;
}

/**
 * How many files under the raw tree contain `needle` in their bytes. Reads
 * as a Buffer and reports a count: the answer this suite needs is a number,
 * and a leak test that prints the leak is not a fix.
 */
function filesContaining(root, needle) {
  const target = Buffer.from(needle, "utf8");
  return everyFile(root).filter((path) => readFileSync(path).includes(target))
    .length;
}

async function acquireEchoedActivity(session) {
  return syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
}

test("the provider fixture really does echo credential-shaped material, so the leak tests below are not vacuous", async () => {
  const echoing = createSyntheticSession({ echoCredentialShapedFields: true });
  const clean = createSyntheticSession();
  assert.equal(
    (await echoing.fetchText("/activity", { page: "1" })).includes(
      SYNTHETIC_LEAK_CANARY,
    ),
    true,
    "the echoing session's own response carries the canary",
  );
  assert.equal(
    (await clean.fetchText("/activity", { page: "1" })).includes(
      SYNTHETIC_LEAK_CANARY,
    ),
    false,
    "the ordinary session does not, so the canary can only come from the echo",
  );
});

test("credential-shaped material a provider echoes back is absent from every byte written to the raw tree", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );

  const persisted = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    acquired,
  });

  // The assertion that matters: the written bytes, not the projection's
  // return value. A bearer token, a Set-Cookie value, an Authorization
  // header echo, a refresh token, a device id, a long opaque session id and
  // a user profile all carry the same canary; none of them reached disk.
  assert.equal(
    readFileSync(persisted.filePath).includes(
      Buffer.from(SYNTHETIC_LEAK_CANARY, "utf8"),
    ),
    false,
    "the retained document holds none of the credential-shaped material",
  );
  assert.equal(
    filesContaining(root, SYNTHETIC_LEAK_CANARY),
    0,
    "and neither does any other file in the raw tree, manifest sidecar included",
  );

  // The bytes on disk are the bytes that were hashed. Not the original.
  assert.equal(
    sha256HexOf(readFileSync(persisted.filePath)),
    acquired.manifest.contentHash,
    "the content hash is the hash of the retained bytes on disk",
  );
});

test("the business payload survives the projection intact: an echoed pull parses to exactly what a clean pull does", async () => {
  const echoed = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );
  const clean = await acquireEchoedActivity(createSyntheticSession());

  assert.equal(
    echoed.manifest.contentHash,
    clean.manifest.contentHash,
    "dropping only undeclared fields leaves byte-identical retained output",
  );
  const echoedRows = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: echoed.bytes,
  });
  const cleanRows = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: clean.bytes,
  });
  assert.deepEqual(echoedRows, cleanRows);
  assert.ok(
    echoedRows.activity.length > 0,
    "the projection kept the transactions",
  );
});

test("the manifest records that a projection was applied, which declaration produced it, and what it dropped", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );
  const persisted = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    acquired,
  });

  const { retention } = readCaptureManifest(persisted.capturePath);
  assert.equal(retention.policy.kind, "json_allowlist");
  assert.equal(retention.policy.version, "thistlebrook-activity-1");
  assert.equal(retention.projectionVersion, "1");

  // Path names only, never values -- which is what makes this record safe to
  // keep in the raw tree and safe to assert against here.
  assert.deepEqual(retention.droppedPaths, [
    "pages.*.authorization",
    "pages.*.deviceId",
    "pages.*.items.*.rowAuthorization",
    "pages.*.items.*.rowSessionToken",
    "pages.*.opaqueSessionId",
    "pages.*.refreshToken",
    "pages.*.sessionToken",
    "pages.*.setCookie",
    "pages.*.userProfile",
  ]);
  assert.equal(
    retention.droppedPaths.some((path) => path.includes(SYNTHETIC_LEAK_CANARY)),
    false,
    "the record names paths, never the values that sat at them",
  );
});

test("a dropped undeclared field opens a review item: safe, but never silent", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );
  persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    acquired,
  });

  const opened = db
    .prepare(
      "SELECT COUNT(*) AS n FROM review_items WHERE kind = 'retention_dropped_fields'",
    )
    .get().n;
  assert.equal(opened, 1);

  const leaked = db
    .prepare(
      "SELECT COUNT(*) AS n FROM review_items WHERE raw_value LIKE ? OR reason LIKE ?",
    )
    .get(`%${SYNTHETIC_LEAK_CANARY}%`, `%${SYNTHETIC_LEAK_CANARY}%`).n;
  assert.equal(
    leaked,
    0,
    "the review item names paths, not the material it dropped",
  );
});

test("a payload that matches its declaration exactly drops nothing and opens no review item", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(createSyntheticSession());
  assert.deepEqual(acquired.retention.droppedPaths, []);

  persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    acquired,
  });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_items WHERE kind = 'retention_dropped_fields'",
      )
      .get().n,
    0,
  );
});

test("an adapter that hashed the provider's response instead of the projection is refused, and nothing lands on disk", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );

  // The unprojected response, presented with a hash of itself: the exact
  // "hash the original, store the projection" mistake, backwards.
  const session = createSyntheticSession({ echoCredentialShapedFields: true });
  const responseBytes = new TextEncoder().encode(
    JSON.stringify({
      pages: [JSON.parse(await session.fetchText("/activity", { page: "1" }))],
    }),
  );

  assert.throws(
    () =>
      persistAcquiredDocument(db, root, {
        institutionId: INSTITUTION.id,
        accountId: ACCOUNT.id,
        docType: "activity_pull",
        acquired: {
          bytes: responseBytes,
          retention: acquired.retention,
          manifest: {
            ...acquired.manifest,
            contentHash: sha256HexOf(responseBytes),
          },
        },
      }),
    /does not match the sha256 .* of its retained bytes/,
  );
  assert.equal(
    everyFile(root).length,
    0,
    "the refusal happened before anything was written",
  );
});

test("the raw tree writer accepts nothing but a payload the projection produced", (t) => {
  const root = rawRoot(t);
  const bytes = new TextEncoder().encode(
    "synthetic bytes that never went through a projection",
  );

  assert.throws(() => writeRawDocument(root, bytes), TypeError);
  // A hand-built object with the right shape is not a RetainedPayload either:
  // the brand is a run-time WeakSet, not a structural convention.
  assert.throws(
    () =>
      writeRawDocument(root, {
        bytes,
        sha256: sha256HexOf(bytes),
        record: {
          policy: { kind: "opaque", version: "x", note: "x" },
          projectionVersion: "1",
          droppedPaths: [],
        },
      }),
    TypeError,
  );
  assert.equal(everyFile(root).length, 0);
});

test("a structured_api payload may not declare itself opaque: the tier that echoes session state must name its fields", () => {
  const bytes = new TextEncoder().encode('{"items":[]}');
  assert.throws(
    () =>
      retainPayload(
        { kind: "opaque", version: "v1", note: "would rather not" },
        bytes,
        "structured_api",
      ),
    RetentionShapeError,
  );
  // The document tiers may, because a rendered document has no fields to
  // allowlist -- with a stated reason, never a bare opt-out.
  assert.equal(
    retainPayload(
      {
        kind: "opaque",
        version: "v1",
        note: "a rendered document has no addressable fields",
      },
      bytes,
      "pdf_statement",
    ).record.policy.kind,
    "opaque",
  );
  assert.throws(
    () =>
      retainPayload(
        { kind: "opaque", version: "v1", note: "  " },
        bytes,
        "pdf_statement",
      ),
    RetentionShapeError,
  );
});

test("a PDF-tier artifact is retained whole and says so, so no reader mistakes it for a filtered payload", async (t) => {
  const db = archive(t);
  const root = rawRoot(t);
  const session = createSyntheticSession();
  const { documents } = await syntheticAdapter.discover(session);
  const statement = documents.items.find(
    (item) => item.kind === "pdf_statement",
  );
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });

  const persisted = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "pdf_statement",
    acquired,
  });
  const { retention } = readCaptureManifest(persisted.capturePath);
  assert.equal(retention.policy.kind, "opaque");
  assert.notEqual(retention.policy.note.trim(), "");
  assert.deepEqual(retention.droppedPaths, []);
  assert.equal(
    sha256HexOf(readFileSync(persisted.filePath)),
    acquired.manifest.contentHash,
  );
});

test("a payload shape the declaration does not describe is an error, never a silent pass-through", () => {
  const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
  const policy = (fields) => ({
    kind: "json_allowlist",
    version: "v1",
    fields,
  });

  // A declaration that stops above a nested value would retain an object
  // nobody described. That is the pass-through, so it is refused.
  assert.throws(
    () =>
      retainPayload(
        policy(["holder"]),
        encode({ holder: { nested: "x" } }),
        "structured_api",
      ),
    RetentionShapeError,
  );
  // An array the declaration describes without "*".
  assert.throws(
    () =>
      retainPayload(
        policy(["items.id"]),
        encode({ items: [{ id: "1" }] }),
        "structured_api",
      ),
    RetentionShapeError,
  );
  // A declaration naming fields where the payload holds a scalar.
  assert.throws(
    () =>
      retainPayload(
        policy(["items.*.id"]),
        encode({ items: "not-an-array" }),
        "structured_api",
      ),
    RetentionShapeError,
  );
  // A JSON allowlist declared over bytes that are not JSON at all.
  assert.throws(
    () =>
      retainPayload(
        policy(["a"]),
        new TextEncoder().encode("not json"),
        "structured_api",
      ),
    RetentionShapeError,
  );
  // A declaration that retains nothing is a bug, not a policy.
  assert.throws(
    () => retainPayload(policy([]), encode({}), "structured_api"),
    RetentionShapeError,
  );
  // A declared subtree the provider states as null is absent, not malformed.
  assert.equal(
    new TextDecoder().decode(
      retainPayload(
        policy(["items.*.instrument.symbol"]),
        encode({ items: [{ instrument: null }] }),
        "structured_api",
      ).bytes,
    ),
    '{"items":[{"instrument":null}]}',
  );
});

test("the projection is idempotent and preserves a provider's exact digits, so re-projecting at the write seam costs nothing", () => {
  const policy = {
    kind: "json_allowlist",
    version: "v1",
    fields: ["amount", "count"],
  };
  // A decimal with more precision than a double holds, stated by the
  // provider as a JSON number. Re-serializing must not round it: the money
  // policy says binary floating point appears nowhere in the path.
  const source = new TextEncoder().encode(
    '{"amount":1.00000000000000000001,"count":3,"extra":"dropped"}',
  );

  const once = retainPayload(policy, source, "structured_api");
  assert.equal(
    new TextDecoder().decode(once.bytes),
    '{"amount":1.00000000000000000001,"count":3}',
  );
  assert.deepEqual(once.record.droppedPaths, ["extra"]);

  const twice = retainPayload(policy, once.bytes, "structured_api");
  assert.equal(twice.sha256, once.sha256);
  assert.deepEqual(twice.record.droppedPaths, []);
});

test("a projected pull still imports: the document rows the archive records cite the retained bytes", { skip }, async (t) => {
  const db = archive(t);
  const client = await pgSeeded(t);
  const root = rawRoot(t);
  const acquired = await acquireEchoedActivity(
    createSyntheticSession({ echoCredentialShapedFields: true }),
  );
  const { activity: rows } = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: acquired.bytes,
  });
  const persisted = persistAcquiredDocument(db, root, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    acquired,
  });

  const documents = await adapterPullToImportDocuments(client, {
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    acquired,
    rows,
    docType: "activity_pull",
    docDate: null,
    persisted,
  });
  assert.ok(documents.length > 0);
  assert.equal(
    documents.every((document) =>
      document.filePath.startsWith(persisted.filePath),
    ),
    true,
    "every document row points at the retained file that actually exists",
  );
  assert.equal(filesContaining(root, SYNTHETIC_LEAK_CANARY), 0);
});
