import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
} from "../dist/journal.js";

const codec = {
  parseCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("bad checkpoint");
    const keys = Object.keys(value);
    if (
      value.version !== 1 ||
      typeof value.phase !== "string" ||
      keys.some(
        (key) => !["version", "phase", "count", "outcome"].includes(key),
      )
    )
      throw new Error("bad checkpoint");
    if (
      value.count !== undefined &&
      (!Number.isSafeInteger(value.count) || value.count < 0)
    )
      throw new Error("bad count");
    return {
      version: 1,
      phase: value.phase,
      ...(value.count === undefined ? {} : { count: value.count }),
      ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
    };
  },
  parseResult(operation, value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("bad result");
    if (
      Object.keys(value).some((key) => !["operation", "state"].includes(key)) ||
      value.operation !== operation ||
      typeof value.state !== "string"
    )
      throw new Error("bad result");
    return { operation, state: value.state };
  },
};

function binding(sourceAccountId = randomUUID()) {
  return {
    protocolVersion: 1,
    endpoint: "https://worker.example/api/worker",
    spaceId: `space_${randomUUID()}`,
    sourceAccountId: `source_${sourceAccountId}`,
    configFingerprint: "a".repeat(64),
    credentialSlot: "KITHMIND_WORKER_KEY",
  };
}
const execFileAsync = promisify(execFile);

function request(authority, requestId = randomUUID()) {
  const value = {
    protocolVersion: 1,
    operation: "scan.begin",
    spaceId: authority.spaceId,
    sourceAccountId: authority.sourceAccountId,
    requestId,
    watcherId: "watcher",
    connectorVersion: "test",
    mode: "normal",
    expectedInventoryEpoch: 0,
  };
  return {
    operation: "scan.begin",
    requestId,
    requestBody: JSON.stringify(value),
    createdAt: 10,
  };
}
async function directory() {
  return await mkdtemp(join(tmpdir(), "kithmind-journal-test-"));
}
async function openJournal(path, options = {}) {
  return await Journal.open({
    directory: path,
    binding: options.binding ?? binding(),
    credential: options.credential ?? "km_test_high_entropy_credential",
    initialCheckpoint: options.initialCheckpoint ?? {
      version: 1,
      phase: "idle",
    },
    codec,
  });
}

test("journal heartbeat identity is stable on reopen and unique per journal", async () => {
  const firstPath = await directory();
  const secondPath = await directory();
  const authority = binding();
  const first = await openJournal(firstPath, { binding: authority });
  const firstWatcherId = first.watcherId;
  assert.match(
    firstWatcherId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await first.close();
  const reopened = await openJournal(firstPath, { binding: authority });
  try {
    assert.equal(reopened.watcherId, firstWatcherId);
  } finally {
    await reopened.close();
  }
  const second = await openJournal(secondPath, { binding: authority });
  try {
    assert.notEqual(second.watcherId, firstWatcherId);
  } finally {
    await second.close();
    await rm(firstPath, { recursive: true, force: true });
    await rm(secondPath, { recursive: true, force: true });
  }
});

test("persists one exact pending body with protected permissions", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  try {
    const planned = request(authority);
    await journal.planRequest(planned);
    assert.equal(journal.pending.requestBody, planned.requestBody);
    assert.match(journal.pending.requestDigest, /^[a-f0-9]{64}$/);
    const stored = await readFile(join(path, "state.json"), "utf8");
    assert.ok(stored.includes(planned.requestBody.replaceAll('"', '\\"')));
    assert.ok(!stored.includes("km_test_high_entropy_credential"));
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(path, "state.json"))).mode & 0o777, 0o600);
    await assert.rejects(
      () => journal.planRequest(request(authority)),
      JournalSafetyError,
    );
  } finally {
    await journal.close();
    await rm(path, { recursive: true, force: true });
  }
});

test("rejects malformed, over-permissive, and symlinked state", async () => {
  for (const corruption of ["extra", "mode", "symlink"]) {
    const path = await directory();
    const authority = binding();
    const journal = await openJournal(path, { binding: authority });
    await journal.close();
    const statePath = join(path, "state.json");
    if (corruption === "extra") {
      const value = JSON.parse(await readFile(statePath, "utf8"));
      value.unexpected = true;
      await writeFile(statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    } else if (corruption === "mode") {
      await chmod(statePath, 0o644);
    } else {
      const target = join(path, "target.json");
      await writeFile(target, await readFile(statePath), { mode: 0o600 });
      await rm(statePath);
      await symlink(target, statePath);
    }
    await assert.rejects(
      () => openJournal(path, { binding: authority }),
      JournalSafetyError,
    );
    await rm(path, { recursive: true, force: true });
  }
});

test("rejects unsafe request identities and prototype keys without writing", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  try {
    const before = await readFile(join(path, "state.json"), "utf8");
    const wrongSource = request(authority, "wrong-source");
    const wrongSourceBody = JSON.parse(wrongSource.requestBody);
    wrongSourceBody.sourceAccountId = `source_${randomUUID()}`;
    wrongSource.requestBody = JSON.stringify(wrongSourceBody);
    await assert.rejects(
      () => journal.planRequest(wrongSource),
      JournalSafetyError,
    );

    const prototypeRequest = request(authority, "prototype-key");
    prototypeRequest.requestBody = `${prototypeRequest.requestBody.slice(0, -1)},"__proto__":{"polluted":true}}`;
    await assert.rejects(
      () => journal.planRequest(prototypeRequest),
      JournalSafetyError,
    );
    assert.equal(await readFile(join(path, "state.json"), "utf8"), before);
    assert.equal(journal.pending, undefined);
  } finally {
    await journal.close();
    await rm(path, { recursive: true, force: true });
  }
});

test("rejects a stored pending body outside its journal authority", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await journal.planRequest(request(authority, "stored-wrong-source"));
  await journal.close();

  const statePath = join(path, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const body = JSON.parse(state.pending.requestBody);
  body.sourceAccountId = `source_${randomUUID()}`;
  state.pending.requestBody = JSON.stringify(body);
  state.pending.requestDigest = createHash("sha256")
    .update(state.pending.requestBody)
    .digest("hex");
  await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => openJournal(path, { binding: authority }),
    JournalSafetyError,
  );
  await rm(path, { recursive: true, force: true });
});

test("opens state nonblocking and bounds journal directory traversal", async () => {
  const fifoPath = await directory();
  const fifoAuthority = binding();
  const fifoJournal = await openJournal(fifoPath, { binding: fifoAuthority });
  await fifoJournal.close();
  await rm(join(fifoPath, "state.json"));
  await execFileAsync("mkfifo", [join(fifoPath, "state.json")]);
  await assert.rejects(
    () => openJournal(fifoPath, { binding: fifoAuthority }),
    JournalSafetyError,
  );
  await rm(fifoPath, { recursive: true, force: true });

  const unrelatedPath = await directory();
  await writeFile(join(unrelatedPath, ".DS_Store"), "unrelated");
  const unrelated = await openJournal(unrelatedPath);
  await unrelated.close();
  assert.equal(
    await readFile(join(unrelatedPath, ".DS_Store"), "utf8"),
    "unrelated",
  );
  await rm(unrelatedPath, { recursive: true, force: true });

  const crowdedPath = await directory();
  for (let index = 0; index < 65; index += 1) {
    await writeFile(
      join(crowdedPath, `.state.json.${randomUUID()}.tmp`),
      "temporary",
      { mode: 0o600 },
    );
  }
  await assert.rejects(() => openJournal(crowdedPath), JournalSafetyError);
  await rm(crowdedPath, { recursive: true, force: true });
});

test("detects credential rotation and permits only authorized quiescent rebinding", async () => {
  const path = await directory();
  const authority = binding();
  let journal = await openJournal(path, {
    binding: authority,
    credential: "credential-one",
  });
  await journal.close();
  journal = await openJournal(path, {
    binding: authority,
    credential: "credential-two",
  });
  assert.equal(journal.credentialStatus, "changed_quiescent");
  await assert.rejects(
    () => journal.planRequest(request(authority)),
    JournalCredentialChangedError,
  );
  await journal.acceptCredentialAfterAuthorizedStatus();
  assert.equal(journal.credentialStatus, "current");
  await journal.planRequest(request(authority));
  await journal.close();
  await assert.rejects(
    () =>
      openJournal(path, { binding: authority, credential: "credential-three" }),
    JournalCredentialChangedError,
  );
  await rm(path, { recursive: true, force: true });
});

test("an active credential session also blocks rotation", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, {
    binding: authority,
    credential: "credential-one",
  });
  await journal.transitionCheckpoint({
    checkpoint: { version: 1, phase: "leased" },
    credentialSessionActive: true,
  });
  await journal.close();
  await assert.rejects(
    () =>
      openJournal(path, { binding: authority, credential: "credential-two" }),
    JournalCredentialChangedError,
  );
  await rm(path, { recursive: true, force: true });
});

test("a result durability failure poisons memory and preserves the replayable intent", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await journal.planRequest(request(authority, "lost-result"));
  await chmod(path, 0o500);
  await assert.rejects(
    () =>
      journal.recordValidatedResult(
        { operation: "scan.begin", state: "open" },
        20,
      ),
    JournalSafetyError,
  );
  await chmod(path, 0o700);
  assert.throws(() => journal.pending, JournalSafetyError);
  await journal.close();
  const reopened = await openJournal(path, { binding: authority });
  assert.equal(reopened.pending.requestId, "lost-result");
  assert.equal(reopened.pending.result, undefined);
  await reopened.close();
  await rm(path, { recursive: true, force: true });
});

test("kernel source lock contends across journal paths and releases on close", async () => {
  const firstPath = await directory();
  const secondPath = await directory();
  const authority = binding();
  const first = await openJournal(firstPath, { binding: authority });
  await assert.rejects(
    () => openJournal(secondPath, { binding: authority }),
    JournalLockedError,
  );
  await first.close();
  const second = await openJournal(secondPath, { binding: authority });
  await second.close();
  await rm(firstPath, { recursive: true, force: true });
  await rm(secondPath, { recursive: true, force: true });
});

test("kernel path lock prevents concurrent initialization by different authorities", async () => {
  const path = await directory();
  const first = await openJournal(path, { binding: binding() });
  await assert.rejects(
    () => openJournal(path, { binding: binding() }),
    JournalLockedError,
  );
  await first.close();
  await rm(path, { recursive: true, force: true });
});

test("canonical path aliases contend and directory permission changes poison writes", async () => {
  const parent = await directory();
  const actualParent = join(parent, "actual");
  const aliasParent = join(parent, "alias");
  const actual = join(actualParent, "journal");
  const alias = join(aliasParent, "journal");
  await mkdir(actual, { recursive: true, mode: 0o700 });
  await symlink(actualParent, aliasParent);
  const first = await openJournal(actual, { binding: binding() });
  await assert.rejects(
    () => openJournal(alias, { binding: binding() }),
    JournalLockedError,
  );
  await chmod(actual, 0o755);
  await assert.rejects(
    () => first.planRequest(request(first.binding, "unsafe-directory")),
    JournalSafetyError,
  );
  assert.throws(() => first.pending, JournalSafetyError);
  await chmod(actual, 0o700);
  await first.close();
  await rm(parent, { recursive: true, force: true });
});

test("journal directory replacement poisons subsequent persistence", async () => {
  const path = await directory();
  const moved = `${path}-moved`;
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await rename(path, moved);
  await mkdir(path, { mode: 0o700 });
  await assert.rejects(
    () => journal.planRequest(request(authority, "replaced-directory")),
    JournalSafetyError,
  );
  assert.throws(() => journal.pending, JournalSafetyError);
  await journal.close();
  await rm(path, { recursive: true, force: true });
  await rm(moved, { recursive: true, force: true });
});

async function startKillFixture() {
  const moduleUrl = new URL("../dist/journal.js", import.meta.url).href;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const childPath = await directory();
    const restartPath = await directory();
    const authority = binding();
    const script = `
      import { Journal } from ${JSON.stringify(moduleUrl)};
      const codec = { parseCheckpoint: (value) => value, parseResult: (_operation, value) => value };
      try {
        await Journal.open({ directory: ${JSON.stringify(childPath)}, binding: ${JSON.stringify(authority)}, credential: "credential", initialCheckpoint: { version: 1, phase: "idle" }, codec });
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      } catch (error) {
        if (error?.name === "JournalLockedError") {
          process.stderr.write("fixture_locked\\n");
          process.exit(73);
        }
        process.stderr.write("fixture_failed\\n");
        process.exit(74);
      }
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 256) stderr += chunk.toString();
    });
    const outcome = await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        if (!chunk.toString().includes("ready")) return;
        child.stdout.off("data", onData);
        resolve({ ready: true });
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
      child.once("close", (code) => {
        child.stdout.off("data", onData);
        resolve({ ready: false, code });
      });
    });
    if (outcome.ready) return { authority, child, childPath, restartPath };
    await rm(childPath, { recursive: true, force: true });
    await rm(restartPath, { recursive: true, force: true });
    if (outcome.code === 73 && stderr === "fixture_locked\n" && attempt < 4)
      continue;
    throw new Error(`fixture child exited ${outcome.code}`);
  }
  throw new Error("fixture allocation exhausted");
}

test("SIGKILL releases the kernel source lock for automatic restart", async (t) => {
  const { authority, child, childPath, restartPath } = await startKillFixture();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(childPath, { recursive: true, force: true });
    await rm(restartPath, { recursive: true, force: true });
  });
  await assert.rejects(
    () =>
      openJournal(restartPath, {
        binding: authority,
        credential: "credential",
      }),
    JournalLockedError,
  );
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const restarted = await openJournal(restartPath, {
    binding: authority,
    credential: "credential",
  });
  await restarted.close();
});

// P2-104b: `configFingerprint` hashes the whole `pdfDocQa` block, so editing a
// parser path or fingerprint produced a binding the journal refused to open,
// locking the operator out of the directory that also holds the archive
// catalog. A configuration change over the same worker identity is now
// adopted when nothing is in flight.

function reconfigured(authority, fingerprint = "b".repeat(64)) {
  return { ...authority, configFingerprint: fingerprint };
}

test("a changed configuration reopens a quiescent journal and rewrites the binding", async () => {
  const path = await directory();
  const authority = binding();
  const first = await openJournal(path, { binding: authority });
  await first.transitionCheckpoint({
    checkpoint: { version: 1, phase: "idle", count: 3 },
    credentialSessionActive: false,
  });
  await first.close();

  const next = reconfigured(authority);
  const reopened = await openJournal(path, { binding: next });
  assert.equal(reopened.checkpoint.count, 3, "checkpoint survives the rebind");
  await reopened.close();

  const stored = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
  assert.equal(stored.binding.configFingerprint, next.configFingerprint);
  assert.equal(stored.checkpoint.count, 3);

  // The adopted binding is durable: the next open is an ordinary
  // equal-binding open.
  const again = await openJournal(path, { binding: next });
  await again.close();

  // Rolling back to the previous configuration is the same move in reverse,
  // and must also work: restoring the old config is how an operator recovers
  // from a bad parser paste without losing the journal.
  const rolledBack = await openJournal(path, { binding: authority });
  assert.equal(rolledBack.checkpoint.count, 3);
  await rolledBack.close();
  assert.equal(
    JSON.parse(await readFile(join(path, "state.json"), "utf8")).binding
      .configFingerprint,
    authority.configFingerprint,
  );
});

test("a changed configuration is refused while a request is pending", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await journal.planRequest(request(authority));
  await journal.close();

  await assert.rejects(
    () => openJournal(path, { binding: reconfigured(authority) }),
    (error) => error instanceof JournalSafetyError,
    "in-flight work must settle under the configuration that started it",
  );
  const stored = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
  assert.equal(stored.binding.configFingerprint, authority.configFingerprint);
});

test("a changed configuration is refused mid scan", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await journal.transitionCheckpoint({
    checkpoint: { version: 1, phase: "scan_begin" },
    credentialSessionActive: false,
  });
  await journal.close();
  await assert.rejects(
    () => openJournal(path, { binding: reconfigured(authority) }),
    (error) => error instanceof JournalSafetyError,
  );
});

test("a changed worker identity is still refused, however quiescent", async () => {
  const path = await directory();
  const authority = binding();
  const journal = await openJournal(path, { binding: authority });
  await journal.close();
  for (const changed of [
    { ...authority, spaceId: `space_${randomUUID()}` },
    { ...authority, sourceAccountId: `source_${randomUUID()}` },
    { ...authority, endpoint: "https://other.example/api/worker" },
    { ...authority, credentialSlot: "KITHMIND_OTHER_KEY" },
  ]) {
    await assert.rejects(
      () => openJournal(path, { binding: changed }),
      (error) => error instanceof JournalSafetyError,
      `identity field must not rebind: ${JSON.stringify(changed)}`,
    );
  }
});

test("a pass that ended incomplete is still between passes and rebinds", async () => {
  // A parked document ends a pass `incomplete`. Nothing is in flight, so the
  // next start may take a new parser. Requiring `complete` here would mean one
  // parked document could freeze the parser version forever.
  for (const outcome of ["complete", "incomplete", "failed"]) {
    const path = await directory();
    const authority = binding();
    const journal = await openJournal(path, { binding: authority });
    await journal.transitionCheckpoint({
      checkpoint: { version: 1, phase: "terminal", outcome },
      credentialSessionActive: false,
    });
    await journal.close();
    const reopened = await openJournal(path, {
      binding: reconfigured(authority),
    });
    assert.equal(reopened.checkpoint.outcome, outcome);
    await reopened.close();
    assert.equal(
      JSON.parse(await readFile(join(path, "state.json"), "utf8")).binding
        .configFingerprint,
      "b".repeat(64),
      `terminal ${outcome} must adopt the new configuration`,
    );
  }
});

// ADM-10. The watcher identity the heartbeat presents.
//
// The bug: `watcherId` hashed the whole binding, `configFingerprint` included,
// and `journalBindingForConfig` hashes the watched roots with their absolute
// paths and the whole `pdfDocQa` block into that fingerprint. So adding a root
// or moving the parser minted a new identity, `recordWorkerHeartbeat` refused
// it as a different watcher, and the host went on working while the server
// recorded it as missing.

test("the watcher identity survives every ordinary configuration change", async () => {
  const path = await directory();
  const authority = binding();
  const first = await openJournal(path, { binding: authority });
  const identity = first.watcherId;
  assert.match(
    identity,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(identity, first.legacyWatcherId);
  await first.close();

  // Three different configuration edits, each of which produces a different
  // `configFingerprint`: a new watched root, a moved parser executable, and a
  // rewritten `pdfDocQa` block. None of them is a new watcher.
  for (const fingerprint of ["b", "c", "d"]) {
    const reopened = await openJournal(path, {
      binding: reconfigured(authority, fingerprint.repeat(64)),
    });
    assert.equal(
      reopened.watcherId,
      identity,
      `configuration ${fingerprint} must not mint a new watcher identity`,
    );
    // The legacy id moves with the configuration, which is the whole problem
    // it is presented to solve: it is only ever the id the server may still be
    // holding, never the one this watcher claims.
    assert.notEqual(reopened.legacyWatcherId, identity);
    await reopened.close();
  }
});

test("a fresh journal is a new watcher and a copied one is not", async () => {
  const authority = binding();
  const first = await directory();
  const original = await openJournal(first, { binding: authority });
  const identity = original.watcherId;
  await original.close();

  // A copied journal keeps its salt, so it keeps its identity: the same
  // installation moved to a new host is the same watcher, which is exactly
  // what a host migration must not have to re-register.
  const copied = await directory();
  await writeFile(
    join(copied, "state.json"),
    await readFile(join(first, "state.json"), "utf8"),
    { mode: 0o600 },
  );
  const moved = await openJournal(copied, { binding: authority });
  assert.equal(moved.watcherId, identity);
  await moved.close();

  // A journal created from nothing mints a new salt, and that is a genuinely
  // new watcher the server has to be told about.
  const empty = await directory();
  const fresh = await openJournal(empty, { binding: authority });
  assert.notEqual(fresh.watcherId, identity);
  await fresh.close();
});

test("the watcher identity is bound to one account, space and credential slot", async () => {
  const authority = binding();
  const path = await directory();
  const journal = await openJournal(path, { binding: authority });
  const identity = journal.watcherId;
  const salt = JSON.parse(
    await readFile(join(path, "state.json"), "utf8"),
  ).credentialSalt;
  await journal.close();

  // Same salt, different authority: each of these names a different worker and
  // must not be able to present itself as this one.
  for (const change of [
    { spaceId: `space_${randomUUID()}` },
    { sourceAccountId: `source_${randomUUID()}` },
    { credentialSlot: "OTHER_WORKER_KEY" },
    { endpoint: "https://other.example/api/worker" },
  ]) {
    const other = await directory();
    const state = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
    await writeFile(
      join(other, "state.json"),
      JSON.stringify({
        ...state,
        binding: { ...authority, ...change },
      }),
      { mode: 0o600 },
    );
    const opened = await openJournal(other, {
      binding: { ...authority, ...change },
    });
    assert.equal(
      JSON.parse(await readFile(join(other, "state.json"), "utf8"))
        .credentialSalt,
      salt,
      "the salt is held constant so only the authority change is under test",
    );
    assert.notEqual(opened.watcherId, identity, Object.keys(change)[0]);
    await opened.close();
  }
});
