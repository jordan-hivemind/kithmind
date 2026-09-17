import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { redactAuditReport, redactCitationSample, buildSummary } from "./cutover-report.mjs";

const execute = promisify(execFile);

const ROOT = new URL("..", import.meta.url).pathname;
// The same variable the rest of this repo's Postgres suites use. Without it
// there is no throwaway server to create databases on, so the rehearsal skips
// rather than fails, exactly as the kith-store and kith-migrate suites do.
const DATABASE_URL = process.env.KITH_STORE_DATABASE_URL;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test(
  "the local cutover rehearsal runs every workflow command end to end and writes publishable reports",
  { skip: DATABASE_URL ? false : "KITH_STORE_DATABASE_URL is not set" },
  async (t) => {
    const stage = await mkdtemp(join(tmpdir(), "kith-cutover-test-"));
    t.after(() => rm(stage, { recursive: true, force: true }));

    const { stdout } = await execute("bash", [join(ROOT, "scripts/cutover-local.sh"), "--stage", stage], {
      cwd: ROOT,
      env: { ...process.env, KITH_STORE_DATABASE_URL: DATABASE_URL },
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.match(stdout, /step 3.5: audit against a throwaway database/);

    const reports = join(stage, "reports");

    const manifest = await readJson(join(reports, "manifest.json"));
    assert.equal(manifest.schemaVersion > 0, true);
    // The deployment slug names the owner's deployment and the manifest is
    // published, so the workflow passes `redacted` and so does the rehearsal.
    assert.equal(manifest.deploymentIdentity, "redacted");
    assert.equal(Object.keys(manifest.tables).length > 0, true);
    for (const entry of Object.values(manifest.tables)) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.equal(Number.isSafeInteger(entry.rowCount), true);
    }

    const verification = await readJson(join(reports, "manifest-verification.json"));
    assert.deepEqual(verification, { ok: true, problems: [] });

    const transform = await readJson(join(reports, "transform-report.json"));
    assert.deepEqual(transform.unmapped, []);
    assert.equal(Object.keys(transform.rowCounts).length > 0, true);
    assert.equal(transform.retainedTextHashes.length > 0, true);
    // The two rules that keep the audit clean, end to end: pointers into the
    // drained worker tables and a pointer to a deleted API key are cleared,
    // and nothing else is.
    assert.deepEqual(Object.keys(transform.clearedReferences).sort(), [
      "ingest_jobs.worker_discovery_work_id",
      "source_inventory.first_seen_scan_id",
      "source_inventory.last_seen_scan_id",
      "worker_reservation_receipts.actor_credential_id",
    ]);

    const audit = await readJson(join(reports, "audit-report.json"));
    assert.equal(audit.redacted, true);
    assert.equal(audit.ok, true);
    assert.equal(audit.violationCount, 0);
    assert.equal(Object.keys(audit.rowsAudited).length > 0, true);

    const parity = await readJson(join(reports, "parity-isolated.json"));
    assert.equal(parity.ok, true);
    const byName = Object.fromEntries(parity.results.map((r) => [r.name, r.status]));
    assert.equal(byName.counts, "pass");
    assert.equal(byName.retained_text_hashes, "pass");
    assert.equal(byName.provenance_chains_sample, "pass");
    assert.equal(byName.space_isolation_data, "pass");

    const proof = await readJson(join(reports, "rehearsal-proof.json"));
    assert.equal(proof.ok, true);
    assert.equal(proof.parityCapture.tables.length > 0, true);
    assert.equal(proof.parityCapture.invalidConstraints, 0);
    // The published copy carries the verdict, never the document it sampled.
    assert.deepEqual(Object.keys(proof.citationSample).sort(), [
      "attempted",
      "available",
      "citationHashMatched",
      "reason",
    ]);
    assert.match(proof.datedBackup, /^skipped: /);

    const appRole = await readJson(join(reports, "app-role.json"));
    assert.equal(appRole.ok, true, JSON.stringify(appRole.problems));
    assert.equal(appRole.role, "kith_app");
    assert.equal(appRole.appRoleCanRead, true);
    assert.equal(appRole.appRoleCannotCreate, true);
    assert.deepEqual(appRole.problems, []);
    // No password and no connection string ever reach a published report.
    const appRoleText = await readFile(join(reports, "app-role.json"), "utf8");
    assert.equal(/password/i.test(appRoleText), false);
    assert.equal(appRoleText.includes("postgres://"), false);

    const summary = await readFile(join(stage, "summary.md"), "utf8");
    for (const heading of [
      "## Step 2. Export manifest",
      "## Step 3. Transform",
      "## Step 3.5. Audit",
      "## Steps 4 and 5. Isolated load and parity",
      "## Step 10. Backup-shape rehearsal",
      "## Runbook step 9, role half. App role",
      "## What stays manual",
    ]) {
      assert.equal(summary.includes(heading), true, `summary is missing ${heading}`);
    }
  },
);

test("the audit redaction keeps the shape of a violation and drops the value", () => {
  const redacted = redactAuditReport({
    ok: false,
    rowsAudited: { users: 2 },
    violations: [
      {
        table: "users",
        id: "id00000000000000000000000",
        constraint: "users_email_check",
        kind: "check",
        detail: "email = 'someone@example.test'",
      },
      {
        table: "users",
        id: "id11111111111111111111111",
        constraint: "users_email_check",
        kind: "check",
        detail: "email = 'other@example.test'",
      },
    ],
    skipped: [],
  });
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.violationCount, 2);
  assert.deepEqual(redacted.violationsByConstraint, { "users.users_email_check": 2 });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("example.test"), false);
  assert.equal(serialized.includes("users_email_check"), true);
  assert.equal(serialized.includes("id00000000000000000000000"), true);
  assert.match(redacted.violations[0].detail, /^redacted:\d+ characters$/);
});

test("the citation sample redaction drops the document title and the question built from it", () => {
  const redacted = redactCitationSample({
    attempted: true,
    available: true,
    reason: null,
    documentId: "id00000000000000000000000",
    documentTitle: "A private document title",
    question: 'What does the citation for "A private document title" say?',
    citationHashMatched: true,
  });
  assert.deepEqual(redacted, {
    attempted: true,
    available: true,
    reason: null,
    citationHashMatched: true,
  });
  assert.equal(JSON.stringify(redacted).includes("private document title"), false);
});

test("the summary names the finance comparison and the two things the workflow never does", () => {
  const summary = buildSummary(
    { mode: "live", run: "1", revision: "abc1234" },
    {
      financeComparison: {
        ok: true,
        differences: [],
        financeSchemaVersion: 12,
        financeTables: [{ name: "transactions", rowCount: 7, rowCountAfter: 7 }],
        kithSchemaVersionAfter: 19,
      },
    },
  );
  assert.equal(summary.includes("never writes the `finance` schema"), true);
  assert.equal(summary.includes("the export and the CSV directory stay on the runner"), true);
  assert.equal(summary.includes("**unchanged**"), true);
  assert.equal(summary.includes("| transactions | 7 | 7 |"), true);
});

test("the summary names every cleared reference column, and says none when there are none", () => {
  const withCleared = buildSummary(
    { mode: "rehearsal" },
    {
      transform: {
        rowCounts: { ingest_jobs: 90 },
        childRowCounts: {},
        retainedTextHashes: [],
        unmapped: [],
        clearedReferences: {
          "ingest_jobs.worker_discovery_work_id": {
            count: 90,
            reason: "target drained",
          },
        },
      },
    },
  );
  assert.equal(withCleared.includes("Cleared references:"), true);
  assert.equal(
    withCleared.includes("| ingest_jobs.worker_discovery_work_id | 90 | target drained |"),
    true,
  );

  const withoutCleared = buildSummary(
    { mode: "rehearsal" },
    {
      transform: {
        rowCounts: { users: 2 },
        childRowCounts: {},
        retainedTextHashes: [],
        unmapped: [],
        clearedReferences: {},
      },
    },
  );
  assert.match(withoutCleared, /Cleared references:\n\nnone\n/);
});

test(
  "the host check reads the live host without writing it, and proves finance unchanged across a kith load",
  { skip: DATABASE_URL ? false : "KITH_STORE_DATABASE_URL is not set" },
  async (t) => {
    const [pg, { applyKithSchema }, { applyPgSchema }, { captureHostState, compareFinance }] =
      await Promise.all([
        import("../packages/kith-store/node_modules/pg/esm/index.mjs"),
        import("../packages/kith-store/dist/index.js"),
        import("../packages/finance-archive/dist/index.js"),
        import("./cutover-host-check.mjs"),
      ]);

    const name = `kith_cutover_host_${Math.random().toString(16).slice(2, 12)}`;
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    const target = url.toString();

    const admin = new pg.default.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    t.after(async () => {
      const cleaner = new pg.default.Client({ connectionString: DATABASE_URL });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await cleaner.end();
    });

    // A host shaped like the real one: `finance` already there, `kith` not yet.
    const client = new pg.default.Client({ connectionString: target });
    await client.connect();
    await applyPgSchema(client, "finance");
    await client.end();

    const before = await captureHostState(target, { expectEmptyKith: true });
    assert.equal(before.ok, true, JSON.stringify(before.problems));
    assert.equal(before.kith.schemaVersion, 0, "kith is absent before the load");
    assert.equal(before.finance.schemaVersion > 0, true);
    assert.equal(before.finance.tables.length > 0, true);

    // The live load's only effect: `kith` arrives. No statement the loader runs
    // names `finance`.
    const loader = new pg.default.Client({ connectionString: target });
    await loader.connect();
    await applyKithSchema(loader);
    await loader.end();

    const after = await captureHostState(target);
    assert.equal(after.kith.schemaVersion, after.kith.expectedVersion);
    assert.equal(after.vector.installed, true, "migration 015 installs pgvector");

    const comparison = compareFinance(before, after);
    assert.equal(comparison.ok, true, JSON.stringify(comparison.differences));
    assert.deepEqual(comparison.differences, []);
    assert.equal(comparison.kithSchemaVersionAfter, after.kith.expectedVersion);

    // The guard that stops a second live load from duplicating the archive.
    const second = await captureHostState(target, { expectEmptyKith: true });
    assert.equal(second.kith.nonEmptyTables.length, 0, "an empty kith is still empty");
    assert.equal(second.ok, true);
  },
);
