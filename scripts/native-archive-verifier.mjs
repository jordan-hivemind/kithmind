import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseArguments,
  runVerification,
} from "./verify-native-convex-restore.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireValue(condition) {
  if (!condition) throw new Error("native_archive_verification_failed");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validNativeEvidence(result, expectedVersion) {
  const schema = result.schema;
  const roundtrip = result.roundtrip;
  const counters = [
    "entriesInInventory",
    "tablesCompared",
    "rowsCompared",
    "fileEntriesCompared",
    "storageMetadataRows",
    "storageObjectsCompared",
    "excludedSystemTables",
  ];
  return (
    result.version === 1 &&
    result.backend?.versionOutput === expectedVersion &&
    exactKeys(schema, [
      "bundleSha256",
      "bundleBytes",
      "inputCount",
      "externalImports",
      "exports",
    ]) &&
    /^[a-f0-9]{64}$/.test(schema.bundleSha256) &&
    Number.isSafeInteger(schema.bundleBytes) &&
    schema.bundleBytes > 0 &&
    schema.bundleBytes <= 8 * 1024 * 1024 &&
    Number.isSafeInteger(schema.inputCount) &&
    schema.inputCount > 0 &&
    schema.inputCount <= 10000 &&
    isDeepStrictEqual(schema.externalImports, [
      "convex/server",
      "convex/values",
    ]) &&
    isDeepStrictEqual(schema.exports, ["default"]) &&
    exactKeys(roundtrip, counters) &&
    counters.every(
      (key) =>
        Number.isSafeInteger(roundtrip[key]) &&
        roundtrip[key] >= 0 &&
        roundtrip[key] <= 128 * 1024 * 1024,
    ) &&
    roundtrip.excludedSystemTables === 1 &&
    roundtrip.entriesInInventory > 0 &&
    roundtrip.entriesInInventory <= 10000 &&
    roundtrip.tablesCompared > 0 &&
    roundtrip.tablesCompared +
      roundtrip.fileEntriesCompared +
      roundtrip.excludedSystemTables ===
      roundtrip.entriesInInventory &&
    roundtrip.storageMetadataRows <= roundtrip.rowsCompared &&
    roundtrip.storageObjectsCompared <= roundtrip.fileEntriesCompared
  );
}

/** Owner adapter for the pipeline recovery gate. Environment must already be
 * free of CONVEX_* variables; never strip them silently in reusable code. */
export function createNativeArchiveVerifier(
  settings,
  verify = runVerification,
) {
  return async (input) => {
    requireValue(
      typeof input.nativeZipSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(input.nativeZipSha256),
    );
    const options = parseArguments([
      "--repo",
      settings.repo,
      "--snapshot",
      input.nativeZipPath,
      "--backend",
      settings.backend,
      "--backend-sha256",
      settings.backendSha256,
      "--backend-version",
      settings.backendVersion,
      "--output-dir",
      input.outputDirectory,
      "--backend-port",
      String(settings.backendPort),
      "--site-port",
      String(settings.sitePort),
    ]);
    const result = await verify(options, settings.environment ?? process.env);
    requireValue(
      validNativeEvidence(result, options.backendVersion) &&
        result.status === "passed" &&
        result.stage === "complete" &&
        result.backend?.sha256 === settings.backendSha256 &&
        result.backend?.hashPinned === true &&
        result.snapshot?.sourceSha256 === input.nativeZipSha256 &&
        result.snapshot?.sourceIdentityStable === true &&
        result.isolation?.outboundProbe === "EPERM" &&
        result.isolation?.loopbackListeners === 2 &&
        result.isolation?.applicationFunctions === 0 &&
        result.isolation?.authConfigurationLoaded === false &&
        result.isolation?.cronDefinitionsLoaded === false &&
        result.isolation?.httpRoutesLoaded === false &&
        result.isolation?.backendStopped === true &&
        result.isolation?.listenersAfterStop === 0,
    );
    const directory = input.outputDirectory;
    requireValue(
      resolve(directory) === directory &&
        (await realpath(directory)) === directory,
    );
    const before = await lstat(directory);
    requireValue(
      before.isDirectory() &&
        !before.isSymbolicLink() &&
        before.uid === process.getuid() &&
        (before.mode & 0o777) === 0o700,
    );
    const path = join(directory, "verification-result.json");
    requireValue(
      typeof constants.O_NOFOLLOW === "number" &&
        typeof constants.O_NONBLOCK === "number",
    );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes;
    try {
      const file = await handle.stat();
      requireValue(
        file.isFile() &&
          file.nlink === 1 &&
          file.uid === process.getuid() &&
          (file.mode & 0o777) === 0o600 &&
          file.size > 0 &&
          file.size <= 1024 * 1024,
      );
      bytes = Buffer.alloc(file.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (part.bytesRead === 0) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      const named = await lstat(path);
      requireValue(
        offset === file.size &&
          after.size === file.size &&
          after.mtimeMs === file.mtimeMs &&
          after.ctimeMs === file.ctimeMs &&
          named.dev === file.dev &&
          named.ino === file.ino &&
          named.uid === file.uid &&
          named.nlink === 1 &&
          (named.mode & 0o777) === 0o600 &&
          named.size === file.size &&
          named.mtimeMs === file.mtimeMs &&
          named.ctimeMs === file.ctimeMs &&
          !named.isSymbolicLink(),
      );
      const content = bytes.subarray(0, offset);
      requireValue(
        isDeepStrictEqual(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)),
          result,
        ),
      );
      const finalDirectory = await lstat(directory);
      requireValue(
        finalDirectory.dev === before.dev &&
          finalDirectory.ino === before.ino &&
          finalDirectory.isDirectory() &&
          finalDirectory.uid === before.uid &&
          (finalDirectory.mode & 0o777) === 0o700 &&
          !finalDirectory.isSymbolicLink() &&
          (await realpath(directory)) === directory,
      );
      return {
        passed: true,
        nativeZipSha256: input.nativeZipSha256,
        backendSha256: settings.backendSha256,
        verificationResultSha256: digest(content),
        outputDirectory: directory,
        outputDirectoryDevice: before.dev,
        outputDirectoryInode: before.ino,
      };
    } finally {
      bytes?.fill(0);
      await handle.close();
    }
  };
}
