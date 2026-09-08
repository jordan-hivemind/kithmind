import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  symlink,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreResticObject } from "../dist/archiveCommands.js";

const sha = (v) => createHash("sha256").update(v).digest("hex");
test("restores one exact ciphertext object with a no-clobber destination", async () => {
  const dir = await mkdtemp(join(homedir(), ".kithmind-restore-test-"));
  await chmod(dir, 0o700);
  const repo = join(dir, "repo");
  await mkdir(repo, { mode: 0o700 });
  const out = join(dir, "out.age");
  const bytes = Buffer.alloc(300_000, 0x63);
  const restic = join(dir, "restic");
  const password = join(dir, "password");
  await writeFile(password, "#!/bin/sh\nprintf selector\n", { mode: 0o700 });
  await writeFile(
    restic,
    `#!/bin/sh\nif [ \"$1\" = version ]; then printf 'restic 0.19.1 compiled with go1.25.1 on darwin/arm64\\n'; exit 0; fi\nfor a in \"$@\"; do if [ \"$a\" = config ]; then printf '{\"version\":2,\"id\":\"${"a".repeat(64)}\"}'; exit 0; fi; done\nfor a in \"$@\"; do if [ \"$a\" = dump ]; then dd if=/dev/zero bs=300000 count=1 2>/dev/null | tr '\\000' c; exit 0; fi; done\nexit 1\n`,
    { mode: 0o700 },
  );
  try {
    const result = await restoreResticObject({
      repositoryPath: repo,
      resticBinary: restic,
      expectedRepositoryId: "a".repeat(64),
      passwordCommand: { executable: password },
      snapshotId: "b".repeat(64),
      objectName: "object.age",
      expectedCiphertext: { sha256: sha(bytes), byteLength: bytes.length },
      destinationPath: out,
      limits: {
        deadlineMs: 1000,
        maxOutputBytes: 4096,
        maxSourceBytes: 400000,
        maxCipherBytes: 400000,
      },
    });
    assert.equal(result.destinationPath, out);
    assert.deepEqual(await readFile(out), bytes);
    await assert.rejects(
      () =>
        restoreResticObject({
          repositoryPath: repo,
          resticBinary: restic,
          expectedRepositoryId: "a".repeat(64),
          passwordCommand: { executable: password },
          snapshotId: "b".repeat(64),
          objectName: "object.age",
          expectedCiphertext: { sha256: sha(bytes), byteLength: bytes.length },
          destinationPath: out,
          limits: {
            deadlineMs: 1000,
            maxOutputBytes: 4096,
            maxSourceBytes: 400000,
            maxCipherBytes: 400000,
          },
        }),
      /already exists/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function failureFixture(mode) {
  const dir = await mkdtemp(join(homedir(), ".kithmind-restore-failure-"));
  await chmod(dir, 0o700);
  await mkdir(join(dir, "repo"), { mode: 0o700 });
  const data = Buffer.alloc(8192, 0x61);
  await writeFile(join(dir, "data"), data, { mode: 0o600 });
  const restic = join(dir, "restic");
  await writeFile(
    restic,
    `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls', JSON.stringify(args) + '\\n', {mode: 0o600});
if (args[0] === 'version') {
  process.stdout.write('restic 0.19.1 compiled with go1.25.1 on darwin/arm64\\n');
} else if (args.includes('config')) {
  process.stdout.write(JSON.stringify({version: 2, id: '${"a".repeat(64)}'}));
} else if (args.includes('dump')) {
  if (mode === 'timeout') { setTimeout(() => {}, 10000); }
  else {
    if (mode === 'replace') {
      const temp = fs.readdirSync(dir).find(n => n.includes('.restore-'));
      fs.unlinkSync(dir + '/' + temp);
      fs.writeFileSync(dir + '/' + temp, 'preserve replacement', {mode: 0o600});
    }
    process.stdout.write(fs.readFileSync(dir + '/data'), () => {
      process.exit(mode === 'exit' ? 7 : 0);
    });
  }
} else { process.exit(9); }
`,
    { mode: 0o700 },
  );
  const input = {
    repositoryPath: join(dir, "repo"),
    resticBinary: restic,
    expectedRepositoryId: "a".repeat(64),
    passwordCommand: { executable: restic, publicArgs: ["password"] },
    snapshotId: "b".repeat(64),
    objectName: "object.age",
    expectedCiphertext: { sha256: sha(data), byteLength: data.length },
    destinationPath: join(dir, "out.age"),
    limits: {
      deadlineMs: 1500,
      maxOutputBytes: 4096,
      maxSourceBytes: 16384,
      maxCipherBytes: 16384,
    },
  };
  return {
    dir,
    input,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

for (const mode of ["hash", "length", "limit", "exit", "timeout"]) {
  test(`failed restore ${mode} leaves no published file or owned temporary`, async () => {
    const f = await failureFixture(mode);
    try {
      if (mode === "hash") f.input.expectedCiphertext.sha256 = "e".repeat(64);
      if (mode === "length") f.input.expectedCiphertext.byteLength += 1;
      if (mode === "limit") {
        f.input.limits.maxCipherBytes = 4096;
        f.input.limits.maxSourceBytes = 4096;
        f.input.expectedCiphertext.byteLength = 4096;
      }
      await assert.rejects(() => restoreResticObject(f.input));
      await assert.rejects(() => lstat(f.input.destinationPath), {
        code: "ENOENT",
      });
      assert.equal(
        (await readdir(f.dir)).some((n) => n.includes(".restore-")),
        false,
      );
      const calls = (await readFile(join(f.dir, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      const dump = calls.find((args) => args.includes("dump"));
      assert.ok(
        dump,
        "failure must exercise the dump, not just input validation",
      );
      assert.ok(dump.includes("--no-cache"));
      assert.deepEqual(dump.slice(-3), [
        "dump",
        f.input.snapshotId,
        "/object.age",
      ]);
    } finally {
      await f.cleanup();
    }
  });
}

test("failed restore preserves a replacement temporary", async () => {
  const f = await failureFixture("replace");
  try {
    await assert.rejects(() => restoreResticObject(f.input));
    const temps = (await readdir(f.dir)).filter((n) => n.includes(".restore-"));
    assert.equal(temps.length, 1);
    assert.equal(
      await readFile(join(f.dir, temps[0]), "utf8"),
      "preserve replacement",
    );
    await assert.rejects(() => lstat(f.input.destinationPath), {
      code: "ENOENT",
    });
  } finally {
    await f.cleanup();
  }
});

test("restore rejects a symlink destination without modifying its target", async () => {
  const f = await failureFixture("symlink");
  try {
    const target = join(f.dir, "existing.age");
    await writeFile(target, "keep", { mode: 0o600 });
    await symlink(target, f.input.destinationPath);
    await assert.rejects(() => restoreResticObject(f.input), /already exists/);
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.equal((await lstat(f.input.destinationPath)).isSymbolicLink(), true);
  } finally {
    await f.cleanup();
  }
});
