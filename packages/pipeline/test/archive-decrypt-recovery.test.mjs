import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decryptAgeRecoveryObject,
  encryptAgeObject,
} from "../dist/archiveCommands.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const dir = await mkdtemp(join(homedir(), ".kithmind-decrypt-test-"));
  await chmod(dir, 0o700);
  const ciphertext = Buffer.from("synthetic ciphertext");
  const plaintext = Buffer.alloc(8192, 0x62);
  await writeFile(join(dir, "cipher.age"), ciphertext, { mode: 0o600 });
  await writeFile(join(dir, "plain.fixture"), plaintext, { mode: 0o600 });
  const key = "AGE-SECRET-KEY-1SYNTHETIC\n";
  await writeFile(join(dir, "identity"), key, { mode: 0o600 });
  const binary = join(dir, "age");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('v1.3.2\\n'); }
else {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    fs.writeFileSync(dir + '/invocation', JSON.stringify({args, nativeIdentityOnStdin: input.startsWith('AGE-SECRET-KEY-')}), {mode: 0o600});
    process.stdout.write(fs.readFileSync(dir + '/plain.fixture'));
  });
}
`,
    { mode: 0o700 },
  );
  const input = {
    ageBinary: binary,
    identityPath: join(dir, "identity"),
    ciphertextPath: join(dir, "cipher.age"),
    outputPath: join(dir, "restored"),
    expectedCiphertext: {
      sha256: sha(ciphertext),
      byteLength: ciphertext.length,
    },
    expectedPlaintextSha256: sha(plaintext),
    limits: {
      deadlineMs: 2000,
      maxOutputBytes: 4096,
      maxSourceBytes: 16384,
      maxCipherBytes: 16384,
    },
  };
  return {
    dir,
    input,
    plaintext,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("owner recovery verifies ciphertext and plaintext while passing identities only on stdin", async () => {
  const f = await fixture();
  try {
    const result = await decryptAgeRecoveryObject(f.input);
    assert.deepEqual(result.plaintext, {
      sha256: sha(f.plaintext),
      byteLength: f.plaintext.length,
    });
    assert.deepEqual(await readFile(f.input.outputPath), f.plaintext);
    assert.equal((await lstat(f.input.outputPath)).mode & 0o777, 0o600);
    const invocation = JSON.parse(
      await readFile(join(f.dir, "invocation"), "utf8"),
    );
    assert.deepEqual(invocation.args, [
      "--decrypt",
      "--identity",
      "-",
      f.input.ciphertextPath,
    ]);
    assert.equal(invocation.nativeIdentityOnStdin, true);
    assert.equal(invocation.args.includes(f.input.identityPath), false);
    await assert.rejects(
      () => decryptAgeRecoveryObject(f.input),
      /already exists/,
    );
    assert.deepEqual(await readFile(f.input.outputPath), f.plaintext);
  } finally {
    await f.cleanup();
  }
});

for (const mode of [
  "ciphertext",
  "plaintext",
  "limit",
  "plugin",
  "permissions",
]) {
  test(`recovery rejects ${mode} mismatch without keeping a plaintext output`, async () => {
    const f = await fixture();
    try {
      if (mode === "ciphertext")
        f.input.expectedCiphertext.sha256 = "a".repeat(64);
      if (mode === "plaintext")
        f.input.expectedPlaintextSha256 = "a".repeat(64);
      if (mode === "limit") f.input.limits.maxSourceBytes = 4096;
      if (mode === "plugin")
        await writeFile(f.input.identityPath, "AGE-PLUGIN-EXAMPLE-1ABC\n");
      if (mode === "permissions") await chmod(f.input.identityPath, 0o644);
      await assert.rejects(() => decryptAgeRecoveryObject(f.input));
      await assert.rejects(() => lstat(f.input.outputPath), { code: "ENOENT" });
      if (["ciphertext", "plugin", "permissions"].includes(mode))
        await assert.rejects(() => lstat(join(f.dir, "invocation")), {
          code: "ENOENT",
        });
    } finally {
      await f.cleanup();
    }
  });
}

test(
  "pinned native PQ age encryption and owner decryption round trip",
  {
    skip:
      !process.env.KITHMIND_TEST_AGE_BINARY ||
      !process.env.KITHMIND_TEST_AGE_KEYGEN_BINARY,
  },
  async () => {
    const f = await fixture();
    try {
      const keyPath = join(f.dir, "real-identity");
      const env = { LANG: "C", LC_ALL: "C" };
      execFileSync(
        process.env.KITHMIND_TEST_AGE_KEYGEN_BINARY,
        ["-pq", "-o", keyPath],
        { env, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
      );
      await chmod(keyPath, 0o600);
      const recipient = execFileSync(
        process.env.KITHMIND_TEST_AGE_KEYGEN_BINARY,
        ["-y", keyPath],
        {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10000,
        },
      ).trim();
      const source = Buffer.alloc(300_000, 0x65);
      const sourcePath = join(f.dir, "large.fixture");
      await writeFile(sourcePath, source, { mode: 0o600 });
      const limits = {
        deadlineMs: 10000,
        maxOutputBytes: 4096,
        maxSourceBytes: 400000,
        maxCipherBytes: 500000,
      };
      const encrypted = await encryptAgeObject({
        ageBinary: process.env.KITHMIND_TEST_AGE_BINARY,
        sourcePath,
        tempOutputPath: join(f.dir, "real.age"),
        recipient,
        expectedSource: { sha256: sha(source), byteLength: source.length },
        limits,
      });
      const result = await decryptAgeRecoveryObject({
        ageBinary: process.env.KITHMIND_TEST_AGE_BINARY,
        identityPath: keyPath,
        ciphertextPath: encrypted.tempPath,
        outputPath: join(f.dir, "real-restored"),
        expectedCiphertext: encrypted.ciphertext,
        expectedPlaintextSha256: sha(source),
        limits,
      });
      assert.deepEqual(await readFile(result.outputPath), source);
      assert.equal(result.plaintext.byteLength, source.length);
    } finally {
      await f.cleanup();
    }
  },
);
