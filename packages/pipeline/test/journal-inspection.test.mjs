import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, symlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  inspectJournalReadOnly,
  Journal,
  JournalLockedError,
} from "../dist/journal.js";

const execFileAsync = promisify(execFile);
const CREDENTIAL = "synthetic-inspection-credential";

const codec = {
  parseCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("bad checkpoint");
    }
    const allowed = new Set(["version", "phase", "code"]);
    if (
      value.version !== 1 ||
      typeof value.phase !== "string" ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.code !== undefined && typeof value.code !== "string")
    ) {
      throw new Error("bad checkpoint");
    }
    return {
      version: 1,
      phase: value.phase,
      ...(value.code === undefined ? {} : { code: value.code }),
    };
  },
  parseResult(operation, value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => key !== "operation" && key !== "state",
      ) ||
      value.operation !== operation ||
      typeof value.state !== "string"
    ) {
      throw new Error("bad result");
    }
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

function planned(authority, requestId = randomUUID()) {
  return {
    operation: "scan.begin",
    requestId,
    requestBody: JSON.stringify({
      protocolVersion: 1,
      operation: "scan.begin",
      spaceId: authority.spaceId,
      sourceAccountId: authority.sourceAccountId,
      requestId,
    }),
    createdAt: 10,
  };
}

async function temporaryDirectory(prefix = "kithmind-inspect-") {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function openJournal(directory, authority, options = {}) {
  return await Journal.open({
    directory,
    binding: authority,
    credential: options.credential ?? CREDENTIAL,
    initialCheckpoint: options.checkpoint ?? { version: 1, phase: "idle" },
    codec,
  });
}

async function fixtureWithJournal(options = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const directory = await temporaryDirectory();
    const authority = binding();
    try {
      return {
        directory,
        authority,
        journal: await openJournal(directory, authority, options),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      // Unrelated authority/path hashes can share bounded local lock ports.
      if (error instanceof JournalLockedError && attempt < 4) continue;
      throw error;
    }
  }
}

function retainedMetadata(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

async function snapshot(directory) {
  const names = (await readdir(directory)).sort();
  const files = {};
  for (const name of names) {
    const path = join(directory, name);
    const info = await lstat(path);
    files[name] = {
      metadata: retainedMetadata(info),
      ...(info.isFile() ? { bytes: await readFile(path, "base64") } : {}),
    };
  }
  return {
    directory: retainedMetadata(await stat(directory)),
    names,
    files,
  };
}

test("missing journal inspection acquires only the authority lock and creates nothing", async () => {
  const parent = await temporaryDirectory();
  const missing = join(parent, "missing", "nested", "journal");
  const authority = binding();
  try {
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: missing,
        binding: authority,
        codec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "not_initialized" },
    );
    await assert.rejects(() => lstat(missing), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing journal inspection requires a writable searchable existing parent", async (context) => {
  if (process.getuid?.() === 0) {
    context.skip("root bypasses ordinary directory access checks");
    return;
  }
  const parent = await temporaryDirectory();
  const protectedParent = join(parent, "protected");
  const missing = join(protectedParent, "nested", "journal");
  const authority = binding();
  await mkdir(protectedParent, { mode: 0o700 });
  await chmod(protectedParent, 0o500);
  try {
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: missing,
        binding: authority,
        codec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "unsafe", code: "invalid_permissions" },
    );
    await assert.rejects(
      () => lstat(missing),
      (error) => error.code === "ENOENT" || error.code === "EACCES",
    );
  } finally {
    await chmod(protectedParent, 0o700);
    await rm(parent, { recursive: true, force: true });
  }
});

test("safe inspection is byte and metadata preserving and reports recovery artifacts", async () => {
  const directory = await temporaryDirectory();
  const authority = binding();
  const journal = await openJournal(directory, authority);
  await journal.close();
  const tempName = `.state.json.${randomUUID()}.tmp`;
  await writeFile(join(directory, tempName), "interrupted", { mode: 0o600 });
  const before = await snapshot(directory);
  const result = await inspectJournalReadOnly({
    directory,
    binding: authority,
    codec,
    credentialForComparison: CREDENTIAL,
  });
  const after = await snapshot(directory);
  try {
    assert.deepEqual(result, {
      state: "safe",
      activity: "idle",
      pending: false,
      cachedResult: false,
      credentialSessionActive: false,
      credentialBinding: "current",
      recoveryArtifactCount: 1,
      manualRecoveryRequired: false,
    });
    assert.deepEqual(after, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection reports current, quiescent, active, and unverified credential bindings without accepting one", async () => {
  const directory = await temporaryDirectory();
  const authority = binding();
  let journal = await openJournal(directory, authority);
  await journal.close();
  const before = await readFile(join(directory, "state.json"), "utf8");
  assert.equal(
    (
      await inspectJournalReadOnly({
        directory,
        binding: authority,
        codec,
        credentialForComparison: CREDENTIAL,
      })
    ).credentialBinding,
    "current",
  );
  assert.equal(
    (
      await inspectJournalReadOnly({
        directory,
        binding: authority,
        codec,
        credentialForComparison: "rotated-credential",
      })
    ).credentialBinding,
    "changed_quiescent",
  );
  assert.equal(
    (await inspectJournalReadOnly({ directory, binding: authority, codec }))
      .credentialBinding,
    "unverified",
  );
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), before);

  journal = await openJournal(directory, authority);
  await journal.transitionCheckpoint({
    checkpoint: { version: 1, phase: "jobs_stage" },
    credentialSessionActive: true,
  });
  await journal.close();
  const activeBefore = await readFile(join(directory, "state.json"), "utf8");
  const active = await inspectJournalReadOnly({
    directory,
    binding: authority,
    codec,
    credentialForComparison: "rotated-credential",
  });
  try {
    assert.equal(active.state, "safe");
    assert.equal(active.activity, "processing");
    assert.equal(active.credentialSessionActive, true);
    assert.equal(active.credentialBinding, "changed_active");
    assert.equal(
      await readFile(join(directory, "state.json"), "utf8"),
      activeBefore,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection reports pending cached state and sticky manual recovery without exposing details", async () => {
  const pendingFixture = await fixtureWithJournal();
  const { directory: pendingDirectory, authority, journal } = pendingFixture;
  await journal.planRequest(planned(authority, "cached-request"));
  await journal.recordValidatedResult(
    { operation: "scan.begin", state: "open" },
    20,
  );
  await journal.close();
  const pending = await inspectJournalReadOnly({
    directory: pendingDirectory,
    binding: authority,
    codec,
    credentialForComparison: CREDENTIAL,
  });
  assert.equal(pending.state, "safe");
  assert.equal(pending.pending, true);
  assert.equal(pending.cachedResult, true);
  assert.equal(JSON.stringify(pending).includes("cached-request"), false);
  await rm(pendingDirectory, { recursive: true, force: true });

  const stickyFixture = await fixtureWithJournal({
    checkpoint: {
      version: 1,
      phase: "terminal",
      code: "request_conflict",
    },
  });
  const {
    directory: stickyDirectory,
    authority: stickyAuthority,
    journal: stickyJournal,
  } = stickyFixture;
  await stickyJournal.close();
  const sticky = await inspectJournalReadOnly({
    directory: stickyDirectory,
    binding: stickyAuthority,
    codec,
    credentialForComparison: CREDENTIAL,
  });
  try {
    assert.equal(sticky.state, "safe");
    assert.equal(sticky.activity, "terminal");
    assert.equal(sticky.manualRecoveryRequired, true);
    assert.equal(JSON.stringify(sticky).includes("request_conflict"), false);
  } finally {
    await rm(stickyDirectory, { recursive: true, force: true });
  }
});

test("held source or path locks report contention without implying worker health", async () => {
  const heldDirectory = await temporaryDirectory();
  const missingParent = await temporaryDirectory();
  const missing = join(missingParent, "missing");
  const authority = binding();
  const held = await openJournal(heldDirectory, authority);
  try {
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: heldDirectory,
        binding: authority,
        codec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "contended" },
    );
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: missing,
        binding: authority,
        codec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "contended" },
    );
    await assert.rejects(() => lstat(missing), { code: "ENOENT" });

    const otherAuthority = binding();
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: heldDirectory,
        binding: otherAuthority,
        codec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "contended" },
    );
  } finally {
    await held.close();
    await rm(heldDirectory, { recursive: true, force: true });
    await rm(missingParent, { recursive: true, force: true });
  }
});

test("inspection rejects binding changes, unsafe state nodes, permissions, and directory overflow without cleanup", async () => {
  const {
    directory: mismatchDirectory,
    authority,
    journal: mismatchJournal,
  } = await fixtureWithJournal();
  let journal = mismatchJournal;
  await journal.close();
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: mismatchDirectory,
      binding: binding(),
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "binding_mismatch" },
  );
  await rm(mismatchDirectory, { recursive: true, force: true });

  const {
    directory: permissionDirectory,
    authority: permissionAuthority,
    journal: permissionJournal,
  } = await fixtureWithJournal();
  journal = permissionJournal;
  await journal.close();
  const permissionState = join(permissionDirectory, "state.json");
  await chmod(permissionState, 0o644);
  const permissionBefore = await snapshot(permissionDirectory);
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: permissionDirectory,
      binding: permissionAuthority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "invalid_permissions" },
  );
  assert.deepEqual(await snapshot(permissionDirectory), permissionBefore);
  await rm(permissionDirectory, { recursive: true, force: true });

  const {
    directory: directoryPermission,
    authority: directoryPermissionAuthority,
    journal: directoryPermissionJournal,
  } = await fixtureWithJournal();
  journal = directoryPermissionJournal;
  await journal.close();
  await chmod(directoryPermission, 0o755);
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: directoryPermission,
      binding: directoryPermissionAuthority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "invalid_permissions" },
  );
  await chmod(directoryPermission, 0o700);
  await rm(directoryPermission, { recursive: true, force: true });

  const fifoDirectory = await temporaryDirectory();
  await execFileAsync("mkfifo", [join(fifoDirectory, "state.json")]);
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: fifoDirectory,
      binding: authority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "invalid_state" },
  );
  await rm(fifoDirectory, { recursive: true, force: true });

  const {
    directory: crowdedDirectory,
    authority: crowdedAuthority,
    journal: crowdedJournal,
  } = await fixtureWithJournal();
  journal = crowdedJournal;
  await journal.close();
  for (let index = 0; index < 64; index += 1) {
    await writeFile(
      join(crowdedDirectory, `.state.json.${randomUUID()}.tmp`),
      "temporary",
      { mode: 0o600 },
    );
  }
  const crowdedNames = (await readdir(crowdedDirectory)).sort();
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: crowdedDirectory,
      binding: crowdedAuthority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "capacity_exceeded" },
  );
  assert.deepEqual((await readdir(crowdedDirectory)).sort(), crowdedNames);
  await rm(crowdedDirectory, { recursive: true, force: true });
});

test("inspection rejects a final directory symlink and oversized state without changing either", async () => {
  const parent = await temporaryDirectory();
  const actual = join(parent, "actual");
  const alias = join(parent, "alias");
  const authority = binding();
  const journal = await openJournal(actual, authority);
  await journal.close();
  await symlink(actual, alias);
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: alias,
      binding: authority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "invalid_directory" },
  );

  const statePath = join(actual, "state.json");
  await writeFile(statePath, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  const before = await snapshot(actual);
  assert.deepEqual(
    await inspectJournalReadOnly({
      directory: actual,
      binding: authority,
      codec,
      credentialForComparison: CREDENTIAL,
    }),
    { state: "unsafe", code: "invalid_state" },
  );
  assert.deepEqual(await snapshot(actual), before);
  await rm(parent, { recursive: true, force: true });
});

test("inspection detects a requested path whose ancestor is replaced during parsing", async () => {
  const parent = await temporaryDirectory();
  const firstParent = join(parent, "first");
  const secondParent = join(parent, "second");
  const first = join(firstParent, "journal");
  const second = join(secondParent, "journal");
  const alias = join(parent, "alias");
  const authority = binding();
  const journal = await openJournal(first, authority);
  await journal.close();
  await mkdir(second, { recursive: true, mode: 0o700 });
  await symlink(firstParent, alias);
  const stateBefore = await readFile(join(first, "state.json"), "utf8");
  let replaced = false;
  const replacingCodec = {
    ...codec,
    parseCheckpoint(value) {
      if (!replaced) {
        rmSync(alias);
        symlinkSync(secondParent, alias);
        replaced = true;
      }
      return codec.parseCheckpoint(value);
    },
  };
  try {
    assert.deepEqual(
      await inspectJournalReadOnly({
        directory: join(alias, "journal"),
        binding: authority,
        codec: replacingCodec,
        credentialForComparison: CREDENTIAL,
      }),
      { state: "unsafe", code: "invalid_directory" },
    );
    assert.equal(replaced, true);
    assert.equal(
      await readFile(join(first, "state.json"), "utf8"),
      stateBefore,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
