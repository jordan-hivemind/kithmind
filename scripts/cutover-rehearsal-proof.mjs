#!/usr/bin/env node
// Plan section 3 step 10's two mechanical halves, run against the throwaway
// database the cutover rehearsal just loaded.
//
// What this does run: `db-postgres-parity.mjs`'s `capturePostgresParity` (the
// per-relation row count and content hash over `finance` and `kith`) and
// `db-restore-proof.mjs`'s `sampleCitedAnswer` (one document read back through
// `@repo/kith-store`'s own read path, with its citation hash recomputed).
// Neither needs a credential the owner has not already given this run.
//
// What this does not run: the dated encrypted dump and the isolated restore
// (`db-backup-postgres.mjs`, `db-restore-proof.mjs --isolated`). Those need the
// `age` and `restic` binaries at pinned versions, the restic repository
// password command and a protected config file that lives on the owner's
// machine, none of which belong in a runner. When they are missing the reason
// is named in the report rather than the step quietly passing.
//
// The connection string arrives in `KITH_CUTOVER_DATABASE_URL`, never on argv.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { capturePostgresParity } from "./db-postgres-parity.mjs";
import { sampleCitedAnswer } from "./db-restore-proof.mjs";

const TIMEOUT_MS = 120_000;

function which(binary) {
  const result = spawnSync("command", ["-v", binary], { shell: true, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : null;
}

export async function runRehearsalProof(connectionString) {
  const psql = which("psql");
  const report = {
    version: 1,
    ranAt: new Date().toISOString(),
    parityCapture: null,
    citationSample: null,
    skipped: null,
    datedBackup: null,
    ok: false,
  };

  if (!psql) {
    report.skipped = "psql is not on PATH, so the parity capture could not run";
  } else {
    report.parityCapture = await capturePostgresParity(psql, connectionString, TIMEOUT_MS);
  }

  report.citationSample = await sampleCitedAnswer(connectionString, TIMEOUT_MS);

  const missing = ["age", "restic"].filter((binary) => !which(binary));
  report.datedBackup =
    missing.length > 0
      ? `skipped: ${missing.join(" and ")} not installed, and the restic repository ` +
        "password command and protected backup config are owner-machine credentials " +
        "this run does not hold"
      : "skipped: the restic repository password command and protected backup config " +
        "are owner-machine credentials this run does not hold";

  // `ok` covers what actually ran. A citation sample that reports
  // `available: false` (a corpus with no active document) is not a failure;
  // `sampleCitedAnswer` throws on a citation hash that does not match, which is.
  report.ok = report.parityCapture !== null;
  return report;
}

async function main() {
  const url = process.env.KITH_CUTOVER_DATABASE_URL;
  if (!url) throw new Error("KITH_CUTOVER_DATABASE_URL is not set");
  const outIndex = process.argv.indexOf("--out");
  const report = await runRehearsalProof(url);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    await writeFile(process.argv[outIndex + 1], json, { mode: 0o600 });
  }
  // stdout carries the verdict only. The full report holds a document title in
  // its citation sample, which `cutover-report.mjs redact` strips before
  // anything is published.
  process.stdout.write(
    `${JSON.stringify({
      ok: report.ok,
      tables: report.parityCapture?.tables.length ?? 0,
      invalidConstraints: report.parityCapture?.invalidConstraints ?? null,
      citationAvailable: report.citationSample?.available ?? false,
      citationHashMatched: report.citationSample?.citationHashMatched ?? null,
      skipped: report.skipped,
      datedBackup: report.datedBackup,
    })}\n`,
  );
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "failed", code: error?.code ?? error?.message ?? "runner_failed" })}\n`,
    );
    process.exitCode = 1;
  });
