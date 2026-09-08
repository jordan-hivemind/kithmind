import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  doctor,
  doctorFromConfig,
  doctorFromPath,
  formatDoctorResult,
} from "../dist/doctor.js";

function config(root, journal, overrides = {}) {
  return {
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "SYNTHETIC_DOCTOR_TOKEN",
    roots: [{ alias: "test", path: root }],
    journalDir: journal,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
    ...overrides,
  };
}

function counts() {
  return {
    items: {
      ready: 1,
      pending: 0,
      failed: 0,
      needsReview: 0,
      explicitGap: 0,
      unavailable: 0,
      ignoredForgotten: 0,
    },
    unresolvedEntries: { needsReview: 0, ignoredForgotten: 0 },
  };
}

function source(overrides = {}) {
  return {
    operation: "source.status",
    sourceAccountId: "source",
    inventoryEpoch: 0,
    completedInventoryEpoch: 0,
    manifestVersion: 0,
    enumeration: { state: "never" },
    processing: { state: "not_assessed" },
    recordCoverage: "not_established",
    ...overrides,
  };
}

function diagnostics(overrides = {}) {
  return {
    operation: "diagnostics.status",
    diagnosticsVersion: 1,
    sourceAccountId: "source",
    source: "enabled",
    watcher: {
      state: "current",
      watcherId: "11111111-1111-4111-8111-111111111111",
      lastSeenAt: 1,
      nextExpectedAt: 180_001,
    },
    incident: { state: "none" },
    ...overrides,
  };
}

function terminalSource(state = "complete", overrides = {}) {
  return source({
    inventoryEpoch: 3,
    completedInventoryEpoch: 3,
    manifestVersion: 4,
    enumeration: { state: "complete", scanId: "scan", completedAt: 10 },
    processing: {
      state,
      assessmentId: "assessment",
      scanId: "scan",
      inventoryEpoch: 3,
      manifestVersion: 4,
      completedAt: 11,
      counts: counts(),
    },
    ...overrides,
  });
}

const isolated = {
  inspectRoots: async () => undefined,
  inspectJournal: async () => ({ state: "not_initialized" }),
};

function transport(value, diagnostic = diagnostics()) {
  return {
    call: async (request) =>
      request.operation === "diagnostics.status" ? diagnostic : value,
  };
}

function check(result, id) {
  return result.checks.find((candidate) => candidate.id === id);
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "doctor-"));
  const root = join(base, "root");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return { base, root, journal: join(base, "journal") };
}

test("fresh scoped setup is operationally ready before coverage exists", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));

  const result = await doctor(
    config(files.root, files.journal),
    transport(source()),
    "synthetic-token",
  );

  assert.equal(result.state, "ready");
  assert.equal(result.version, 2);
  assert.deepEqual(
    result.checks.map(({ id, state }) => [id, state]),
    [
      ["config", "pass"],
      ["credential", "pass"],
      ["deployment", "pass"],
      ["heartbeat", "pass"],
      ["roots", "pass"],
      ["journal", "pass"],
    ],
  );
  assert.deepEqual(result.source, {
    enumeration: "not_started",
    processing: "not_assessed",
    recordCoverage: "not_established",
    warnings: ["record_coverage_not_established"],
  });
  assert.deepEqual(result.capabilities, {
    embeddings: "unverified",
    daemon: "unverified",
  });
  assert.deepEqual(check(result, "heartbeat"), {
    id: "heartbeat",
    state: "pass",
    code: "current",
  });
  assert.deepEqual(await readdir(files.base), ["root"]);
  assert.equal(JSON.stringify(result).includes(files.base), false);
});

test("missing credential still runs local root and journal diagnostics", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  delete process.env.SYNTHETIC_DOCTOR_TOKEN;
  let transportCreated = false;

  const result = await doctorFromConfig(
    config(files.root, files.journal, { sourceAccountId: "source-missing" }),
    () => {
      transportCreated = true;
      return transport(source());
    },
  );

  assert.equal(transportCreated, false);
  assert.equal(result.state, "blocked");
  assert.deepEqual(check(result, "credential"), {
    id: "credential",
    state: "fail",
    code: "missing_credential",
  });
  assert.deepEqual(check(result, "deployment"), {
    id: "deployment",
    state: "warn",
    code: "not_checked",
  });
  assert.equal(check(result, "roots").code, "safe");
  assert.equal(check(result, "journal").code, "not_initialized");
  assert.deepEqual(await readdir(files.base), ["root"]);
});

test("typed denial, wrong source, and unavailable transport use separate diagnostics", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const pipelineConfig = config(files.root, files.journal);

  for (const code of ["not_authenticated", "not_authorized"]) {
    const denied = await doctor(
      pipelineConfig,
      transport({ error: { code } }),
      "synthetic-token",
      isolated,
    );
    assert.equal(check(denied, "credential").code, code);
    assert.equal(check(denied, "deployment").code, "available");
    assert.equal(denied.state, "blocked");
  }

  const mismatch = await doctor(
    pipelineConfig,
    transport(source({ sourceAccountId: "different" })),
    "synthetic-token",
    isolated,
  );
  assert.equal(check(mismatch, "credential").code, "authorization_unverified");
  assert.equal(check(mismatch, "deployment").code, "source_mismatch");

  const unavailable = await doctor(
    pipelineConfig,
    { call: async () => Promise.reject(new Error("secret server detail")) },
    "synthetic-token",
    isolated,
  );
  assert.equal(check(unavailable, "deployment").code, "deployment_unavailable");
  assert.equal(JSON.stringify(unavailable).includes("secret"), false);
});

test("diagnostics status has a fixed deadline even when transport ignores abort", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  let aborted = false;
  const result = await doctor(
    config(files.root, files.journal),
    {
      call: async (request, signal) => {
        if (request.operation === "source.status") return source();
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise(() => undefined);
      },
    },
    "synthetic-token",
    { ...isolated, diagnosticDeadlineMs: 1 },
  );
  assert.equal(aborted, true);
  assert.deepEqual(check(result, "heartbeat"), {
    id: "heartbeat",
    state: "warn",
    code: "unavailable",
  });
});

test("injected status responses receive the released strict parser", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const pipelineConfig = config(files.root, files.journal);
  const malformed = [
    { ...source(), extra: "private value" },
    source({ inventoryEpoch: -1 }),
    terminalSource("complete", {
      processing: {
        ...terminalSource().processing,
        counts: {
          ...counts(),
          items: { ...counts().items, ready: -1 },
        },
      },
    }),
    terminalSource("complete", {
      processing: {
        ...terminalSource().processing,
        counts: {
          ...counts(),
          items: { ...counts().items, pending: 1 },
        },
      },
    }),
    { error: { code: "not_authorized", message: "reflected secret" } },
    { ...source(), padding: "x".repeat(512 * 1024) },
  ];

  for (const response of malformed) {
    const result = await doctor(
      pipelineConfig,
      transport(response),
      "synthetic-token",
      isolated,
    );
    assert.equal(check(result, "deployment").code, "deployment_unavailable");
    assert.equal(JSON.stringify(result).includes("private value"), false);
    assert.equal(JSON.stringify(result).includes("reflected"), false);
  }
});

test("current complete and incomplete assessments retain validated snapshot counts", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  for (const state of ["complete", "incomplete"]) {
    const result = await doctor(
      config(files.root, files.journal),
      transport(terminalSource(state)),
      "synthetic-token",
      isolated,
    );
    assert.equal(result.state, "ready");
    assert.equal(result.source.enumeration, "complete");
    assert.equal(result.source.processing, state);
    assert.deepEqual(result.source.counts, counts());
    assert.equal(result.source.warnings.includes("assessment_stale"), false);
  }

  const ignored = counts();
  ignored.items.ignoredForgotten = 2;
  ignored.unresolvedEntries.ignoredForgotten = 1;
  const completeWithIgnored = terminalSource("complete", {
    processing: { ...terminalSource().processing, counts: ignored },
  });
  const ignoredResult = await doctor(
    config(files.root, files.journal),
    transport(completeWithIgnored),
    "synthetic-token",
    isolated,
  );
  assert.equal(ignoredResult.source.processing, "complete");
  assert.deepEqual(ignoredResult.source.counts, ignored);
});

test("every stale terminal assessment becomes count-free incomplete", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const staleStatuses = [
    terminalSource("complete", {
      processing: { ...terminalSource().processing, inventoryEpoch: 2 },
    }),
    terminalSource("incomplete", {
      processing: {
        ...terminalSource("incomplete").processing,
        manifestVersion: 3,
      },
    }),
    terminalSource("complete", {
      processing: { ...terminalSource().processing, scanId: "older-scan" },
    }),
    terminalSource("complete", { completedInventoryEpoch: 2 }),
  ];

  for (const status of staleStatuses) {
    const result = await doctor(
      config(files.root, files.journal),
      transport(status),
      "synthetic-token",
      isolated,
    );
    assert.equal(result.source.processing, "incomplete");
    assert.equal(result.source.counts, undefined);
    assert.equal(result.source.warnings[0], "assessment_stale");
  }
  const unequalInventory = await doctor(
    config(files.root, files.journal),
    transport(staleStatuses.at(-1)),
    "synthetic-token",
    isolated,
  );
  assert.equal(unequalInventory.source.enumeration, "in_progress");
});

test("missing, overlapping, and unreadable roots return fixed redacted codes", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const journalAdapter = {
    inspectJournal: async () => ({ state: "not_initialized" }),
  };

  const missing = await doctor(
    config(join(files.base, "missing"), files.journal),
    transport(source()),
    "synthetic-token",
    journalAdapter,
  );
  assert.equal(check(missing, "roots").code, "root_missing");

  const nested = join(files.root, "nested");
  await mkdir(nested, { mode: 0o700 });
  const overlap = await doctor(
    config(files.root, files.journal, {
      roots: [
        { alias: "first", path: files.root },
        { alias: "second", path: nested },
      ],
    }),
    transport(source()),
    "synthetic-token",
    journalAdapter,
  );
  assert.equal(check(overlap, "roots").code, "root_overlap");

  const badRoot = join(files.base, "unsafe");
  await mkdir(badRoot, { mode: 0o777 });
  await chmod(badRoot, 0o777);
  const unsafe = await doctor(
    config(badRoot, files.journal),
    transport(source()),
    "synthetic-token",
    journalAdapter,
  );
  assert.equal(check(unsafe, "roots").code, "root_permission_denied");
  assert.equal(
    JSON.stringify([missing, overlap, unsafe]).includes(files.base),
    false,
  );
});

test("future journal containment is rejected without creating the journal", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const journal = join(files.root, "future", "journal");
  const result = await doctor(
    config(files.root, journal),
    transport(source()),
    "synthetic-token",
    { inspectJournal: async () => ({ state: "not_initialized" }) },
  );
  assert.equal(check(result, "roots").code, "journal_overlap");
  assert.deepEqual(await readdir(files.root), []);
});

test("bounded discovery proves readability and reports content failures without writes", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const bad = join(files.root, "bad.txt");
  await writeFile(bad, Buffer.from([0xff]));
  const invalidUtf8 = await doctor(
    config(files.root, files.journal),
    transport(source()),
    "synthetic-token",
    { inspectJournal: async () => ({ state: "not_initialized" }) },
  );
  assert.equal(check(invalidUtf8, "roots").code, "root_unsupported");
  assert.deepEqual(await readdir(files.root), ["bad.txt"]);

  await writeFile(bad, "");
  const empty = await doctor(
    config(files.root, files.journal),
    transport(source()),
    "synthetic-token",
    { inspectJournal: async () => ({ state: "not_initialized" }) },
  );
  assert.equal(check(empty, "roots").code, "root_empty_file");

  await writeFile(bad, "first");
  await writeFile(join(files.root, "second.txt"), "second");
  const capacity = await doctor(
    config(files.root, files.journal, { maxFiles: 1 }),
    transport(source()),
    "synthetic-token",
    { inspectJournal: async () => ({ state: "not_initialized" }) },
  );
  assert.equal(check(capacity, "roots").code, "root_capacity_exceeded");
});

test("bounded PDF discovery is accepted when the PDF profile is configured", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  await writeFile(
    join(files.root, "document.pdf"),
    "%PDF-1.7\nsynthetic\n%%EOF\n",
  );
  const result = await doctor(
    config(files.root, files.journal, { pdfDocQa: {} }),
    transport(source()),
    "synthetic-token",
    { inspectJournal: async () => ({ state: "not_initialized" }) },
  );
  assert.equal(check(result, "roots").state, "pass");
  assert.equal(check(result, "roots").code, "safe");
});

test("journal activity degrades while recovery hazards block", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const pipelineConfig = config(files.root, files.journal);
  const baseInspection = {
    state: "safe",
    activity: "idle",
    pending: false,
    cachedResult: false,
    credentialSessionActive: false,
    credentialBinding: "current",
    recoveryArtifactCount: 0,
    manualRecoveryRequired: false,
  };
  const cases = [
    [{ state: "contended" }, "degraded", "contended"],
    [{ ...baseInspection, activity: "scan" }, "degraded", "recovery_pending"],
    [{ ...baseInspection, pending: true }, "degraded", "recovery_pending"],
    [
      { ...baseInspection, recoveryArtifactCount: 1 },
      "degraded",
      "recovery_pending",
    ],
    [
      { ...baseInspection, credentialBinding: "changed_quiescent" },
      "degraded",
      "credential_rebind_pending",
    ],
    [
      { ...baseInspection, credentialBinding: "changed_active" },
      "blocked",
      "credential_recovery_required",
    ],
    [
      { ...baseInspection, manualRecoveryRequired: true },
      "blocked",
      "manual_recovery_required",
    ],
    [
      { ...baseInspection, pending: true, credentialBinding: "unverified" },
      "blocked",
      "credential_comparison_unavailable",
    ],
    [
      { state: "unsafe", code: "invalid_permissions" },
      "blocked",
      "invalid_permissions",
    ],
  ];

  for (const [inspection, state, code] of cases) {
    const result = await doctor(
      pipelineConfig,
      transport(source()),
      "synthetic-token",
      {
        inspectRoots: async () => undefined,
        inspectJournal: async () => inspection,
      },
    );
    assert.equal(result.state, state);
    assert.equal(check(result, "journal").code, code);
    assert.equal(result.capabilities.daemon, "unverified");
  }
});

test("invalid and oversized config files return the same closed bounded object", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const invalid = join(files.base, "owner-private-invalid-config.json");
  const oversized = join(files.base, "owner-private-oversized-config.json");
  await writeFile(invalid, "{not-json");
  await writeFile(oversized, "x".repeat(64 * 1024 + 1));

  for (const path of [invalid, oversized, join(files.base, "missing.json")]) {
    const result = await doctorFromPath(path, () => transport(source()));
    assert.equal(result.state, "blocked");
    assert.equal(result.checks.length, 6);
    assert.equal(check(result, "config").code, "invalid_config");
    assert.equal(JSON.stringify(result).includes(files.base), false);
  }
});

test("a FIFO config fails closed without blocking", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const fifo = join(files.base, "private-config-fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);

  const startedAt = Date.now();
  const result = await doctorFromPath(fifo, () => transport(source()));
  assert.equal(result.state, "blocked");
  assert.equal(check(result, "config").code, "invalid_config");
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(JSON.stringify(result).includes(fifo), false);
});

test("symlinked and prototype-shaped configs fail closed", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const target = join(files.base, "config-target.json");
  const link = join(files.base, "config-link.json");
  const polluted = join(files.base, "prototype-config.json");
  const value = JSON.stringify(config(files.root, files.journal));
  await writeFile(target, value);
  await symlink(target, link);
  await writeFile(polluted, value.replace("{", '{"__proto__":{},'));

  for (const path of [link, polluted]) {
    const result = await doctorFromPath(path, () => transport(source()));
    assert.equal(result.state, "blocked");
    assert.equal(check(result, "config").code, "invalid_config");
  }
});

test("human output is a bounded rendering of fixed diagnostics", async (context) => {
  const files = await fixture();
  context.after(() => rm(files.base, { recursive: true, force: true }));
  const result = await doctor(
    config(files.root, files.journal),
    transport(source()),
    "synthetic-token",
    isolated,
  );
  assert.equal(
    formatDoctorResult(result),
    [
      "doctor: ready",
      "config: pass valid",
      "credential: pass authorized",
      "deployment: pass available",
      "heartbeat: pass current",
      "roots: pass safe",
      "journal: pass not_initialized",
      "source: enumeration=not_started processing=not_assessed recordCoverage=not_established",
      "capabilities: embeddings=unverified daemon=unverified",
    ].join("\n"),
  );
});
