import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
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
