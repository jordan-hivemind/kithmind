import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createNativeArchiveVerifier } from "./native-archive-verifier.mjs";

const sha = "a".repeat(64);
const sourceSha = "b".repeat(64);
const result = () => ({
  version: 1,
  status: "passed",
  stage: "complete",
  backend: {
    sha256: sha,
    hashPinned: true,
    versionOutput: "local_backend unknown",
  },
  schema: {
    bundleSha256: sha,
    bundleBytes: 1024,
    inputCount: 1,
    externalImports: ["convex/server", "convex/values"],
    exports: ["default"],
  },
  roundtrip: {
    entriesInInventory: 3,
    tablesCompared: 2,
    rowsCompared: 4,
    fileEntriesCompared: 0,
    storageMetadataRows: 0,
    storageObjectsCompared: 0,
    excludedSystemTables: 1,
  },
  snapshot: { sourceSha256: sourceSha, sourceIdentityStable: true },
  isolation: {
    outboundProbe: "EPERM",
    loopbackListeners: 2,
    applicationFunctions: 0,
    authConfigurationLoaded: false,
    cronDefinitionsLoaded: false,
    httpRoutesLoaded: false,
    backendStopped: true,
    listenersAfterStop: 0,
  },
});
async function fixture(t) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "kith-native-adapter-")),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    parent,
    input: {
      nativeZipPath: join(parent, "source.zip"),
      nativeZipSha256: sourceSha,
      outputDirectory: join(parent, "result"),
    },
    settings: {
      repo: parent,
      backend: join(parent, "backend"),
      backendSha256: sha,
      backendVersion: "local_backend unknown",
      backendPort: 3210,
      sitePort: 3211,
      environment: {},
    },
  };
}
test("native owner adapter binds the successful persisted proof to the exact ZIP and backend", async (t) => {
  const { input, settings } = await fixture(t);
  let proofBytes;
  const verify = createNativeArchiveVerifier(settings, async (options) => {
    assert.equal(options.snapshot, input.nativeZipPath);
    assert.equal(options.outputDir, input.outputDirectory);
    await mkdir(options.outputDir, { mode: 0o700 });
    const value = result();
    proofBytes = Buffer.from(JSON.stringify(value) + "\n");
    await writeFile(
      join(options.outputDir, "verification-result.json"),
      proofBytes,
      { mode: 0o600 },
    );
    return value;
  });
  const proof = await verify(input);
  assert.equal(proof.passed, true);
  assert.equal(proof.nativeZipSha256, sourceSha);
  assert.equal(
    proof.verificationResultSha256,
    createHash("sha256").update(proofBytes).digest("hex"),
  );
  assert.equal(proof.outputDirectory, input.outputDirectory);
});
test("native owner adapter rejects failed, mismatched, and incomplete isolation results", async (t) => {
  const { input, settings } = await fixture(t);
  for (const mutate of [
    (r) => delete r.roundtrip,
    (r) => delete r.schema,
    (r) => (r.roundtrip.excludedSystemTables = 0),
    (r) => (r.backend.versionOutput = "wrong"),
    (r) => (r.status = "failed"),
    (r) => (r.snapshot.sourceSha256 = sha),
    (r) => (r.backend.sha256 = sourceSha),
    (r) => (r.isolation.backendStopped = false),
    (r) => (r.isolation.listenersAfterStop = 1),
    (r) => (r.isolation.outboundProbe = "OTHER"),
    (r) => (r.isolation.applicationFunctions = 1),
  ]) {
    const value = result();
    mutate(value);
    await assert.rejects(
      createNativeArchiveVerifier(settings, async () => value)(input),
      /native_archive_verification_failed/,
    );
  }
});
test("native owner adapter rejects a conflicting persisted result and symbolic-link result", async (t) => {
  const { input, settings, parent } = await fixture(t);
  await mkdir(input.outputDirectory, { mode: 0o700 });
  const path = join(input.outputDirectory, "verification-result.json");
  await writeFile(path, JSON.stringify({ ...result(), status: "failed" }), {
    mode: 0o600,
  });
  await assert.rejects(
    createNativeArchiveVerifier(settings, async () => result())(input),
    /native_archive_verification_failed/,
  );
  await rm(path);
  const other = join(parent, "other.json");
  await writeFile(other, JSON.stringify(result()), { mode: 0o600 });
  await symlink(other, path);
  await assert.rejects(
    createNativeArchiveVerifier(settings, async () => result())(input),
  );
});

test("native owner adapter rejects malformed source digest before invoking backend", async (t) => {
  const { input, settings } = await fixture(t);
  let calls = 0;
  await assert.rejects(
    createNativeArchiveVerifier(settings, async () => {
      calls++;
      return result();
    })({ ...input, nativeZipSha256: "invalid" }),
    /native_archive_verification_failed/,
  );
  assert.equal(calls, 0);
});
