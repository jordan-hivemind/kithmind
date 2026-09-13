import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "scripts/run-package-task.mjs");

async function fakePnpm(directory) {
  const capture = join(directory, "pnpm-args.json");
  const cli = join(directory, "pnpm.mjs");
  await writeFile(
    cli,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));`,
  );
  return { capture, cli };
}

test("a Turbo package task runs only its local compiler command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kith-package-task-"));
  const { capture, cli } = await fakePnpm(directory);
  const marker = join(directory, "compiler.txt");
  await execFileAsync(
    process.execPath,
    [runner, "build", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    {
      env: {
        ...process.env,
        TURBO_HASH: "synthetic-task-hash",
        npm_package_name: "@repo/synthetic",
        npm_execpath: cli,
      },
    },
  );
  assert.equal(await readFile(marker, "utf8"), "ran");
  await assert.rejects(() => readFile(capture, "utf8"), { code: "ENOENT" });
});

test("a direct build enters the package's filtered Turbo graph once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kith-package-task-"));
  const { capture, cli } = await fakePnpm(directory);
  await execFileAsync(process.execPath, [runner, "build", process.execPath, "-e", "process.exit(99)"], {
    env: {
      ...process.env,
      TURBO_HASH: "",
      npm_package_name: "@repo/synthetic",
      npm_execpath: cli,
    },
  });
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@repo/synthetic",
  ]);
});

test("a direct test builds the filtered graph before running the test command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kith-package-task-"));
  const { capture, cli } = await fakePnpm(directory);
  const marker = join(directory, "test.txt");
  await execFileAsync(
    process.execPath,
    [runner, "test", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    {
      env: {
        ...process.env,
        TURBO_HASH: "",
        npm_package_name: "@repo/synthetic",
        npm_execpath: cli,
      },
    },
  );
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.equal(JSON.parse(await readFile(capture, "utf8"))[3], "build");
});

test("packages delegate ordering to a Turbo graph that builds before tests", async () => {
  const turbo = JSON.parse(await readFile(join(root, "turbo.json"), "utf8"));
  assert.deepEqual(turbo.tasks.test.dependsOn, ["build"]);
  assert.deepEqual(turbo.tasks["@repo/kith-store#test:once"].dependsOn, ["build"]);
  assert.deepEqual(turbo.tasks["@repo/kith-migrate#test:once"].dependsOn, ["build"]);
  assert.ok(turbo.globalDependencies.includes("scripts/run-package-task.mjs"));
  for (const packagePath of ["packages/kith-store", "packages/kith-migrate"]) {
    const manifest = JSON.parse(await readFile(join(root, packagePath, "package.json"), "utf8"));
    for (const task of ["build", "check-types", "test", "test:once", "test:integration"]) {
      assert.match(manifest.scripts[task], /run-package-task\.mjs/);
      assert.doesNotMatch(manifest.scripts[task], /pnpm (?:--filter|run build)/);
    }
  }
});
