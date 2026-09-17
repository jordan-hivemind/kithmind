#!/usr/bin/env node
// Turns the cutover run's JSON reports into the two things that may leave the
// runner: a redacted report set and a Markdown summary.
//
// Why redaction exists. The repository is public, so both the Actions log and
// any uploaded artifact are world readable. Counts, hashes, constraint names and
// parity verdicts are safe to publish; an audit violation's `detail` is not,
// because it quotes the offending column value out of a real row. `redact`
// rewrites the audit report so the table, row id, constraint and kind survive
// and the value does not. The unredacted report never leaves the runner's
// mode-700 staging directory.
//
// Usage:
//   node scripts/cutover-report.mjs redact --staging <dir> --reports <dir>
//   node scripts/cutover-report.mjs summary --reports <dir> --mode <mode> \
//     [--run <id>] [--revision <sha>] [--out <file>]

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Details printed per parity check. The full list stays in the JSON report. */
const MAX_DETAILS = 20;

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`flag_missing_value:${name}`);
  }
  return value;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The audit report, with every offending value removed and the shape of the
 * failure kept. `detail` becomes the character length of what was dropped, so a
 * reader can tell an empty string from a long one without seeing either, and a
 * per-constraint tally is added because that is what an operator acts on: which
 * constraint is failing and how often, not which byte.
 */
export function redactAuditReport(report) {
  const byConstraint = new Map();
  const violations = (report.violations ?? []).map((violation) => {
    const key = `${violation.table}.${violation.constraint}`;
    byConstraint.set(key, (byConstraint.get(key) ?? 0) + 1);
    return {
      table: violation.table,
      id: violation.id,
      constraint: violation.constraint,
      kind: violation.kind,
      detail: `redacted:${String(violation.detail ?? "").length} characters`,
    };
  });
  return {
    redacted: true,
    ok: report.ok === true,
    rowsAudited: report.rowsAudited ?? {},
    violationCount: violations.length,
    violationsByConstraint: Object.fromEntries(
      [...byConstraint.entries()].sort((a, b) => b[1] - a[1]),
    ),
    violations,
    skipped: report.skipped ?? [],
  };
}

/**
 * The restore proof's citation sample, minus the document title and the
 * question built from it. Whether a citation hash matched is the verdict; the
 * title of a real document is a row.
 */
export function redactCitationSample(sample) {
  if (!sample) return null;
  return {
    attempted: sample.attempted === true,
    available: sample.available === true,
    reason: sample.reason ?? null,
    citationHashMatched: sample.citationHashMatched ?? null,
  };
}

async function redact(argv) {
  const staging = flag(argv, "--staging") ?? ".";
  const reports = flag(argv, "--reports") ?? join(staging, "reports");
  await mkdir(reports, { recursive: true, mode: 0o700 });

  const audit = await readJsonIfPresent(join(staging, "audit-report.json"));
  if (audit) {
    await writeFile(
      join(reports, "audit-report.json"),
      `${JSON.stringify(redactAuditReport(audit), null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  const proof = await readJsonIfPresent(join(staging, "rehearsal-proof.json"));
  if (proof) {
    await writeFile(
      join(reports, "rehearsal-proof.json"),
      `${JSON.stringify(
        { ...proof, citationSample: redactCitationSample(proof.citationSample) },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ redacted: { audit: Boolean(audit), rehearsalProof: Boolean(proof) } })}\n`,
  );
}

function table(header, rows) {
  if (!rows.length) return ["_none_", ""];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ];
}

export function buildSummary(context, data) {
  const lines = [`# Cutover run: ${context.mode}`, ""];
  lines.push(
    ...table(
      ["Fact", "Value"],
      [
        ["Mode", context.mode],
        ["Run id", context.run ?? "local"],
        ["Revision", context.revision ?? "unknown"],
        ["Finance writes", "none; this workflow never writes the `finance` schema"],
        ["Data artifacts", "none; the export and the CSV directory stay on the runner"],
      ],
    ),
  );

  lines.push("## Step 2. Export manifest", "");
  if (data.manifest) {
    lines.push(
      ...table(
        ["Fact", "Value"],
        [
          ["Exported at", data.manifest.exportedAt],
          ["Deployment identity", data.manifest.deploymentIdentity],
          ["Schema version", String(data.manifest.schemaVersion)],
          ["Revision", data.manifest.gitRevision],
          ["Tables", String(Object.keys(data.manifest.tables ?? {}).length)],
        ],
      ),
      ...table(
        ["Convex table", "Rows", "Bytes", "SHA-256"],
        Object.entries(data.manifest.tables ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, entry]) => [
            name,
            String(entry.rowCount),
            String(entry.byteLength),
            `\`${entry.sha256}\``,
          ]),
      ),
    );
  } else {
    lines.push("_no manifest report_", "");
  }
  if (data.manifestVerification) {
    lines.push(
      `Manifest verification: **${data.manifestVerification.ok ? "ok" : "failed"}**`,
      ...(data.manifestVerification.problems ?? []).map((p) => `- ${p}`),
      "",
    );
  }

  lines.push("## Step 3. Transform", "");
  if (data.transform) {
    const rowCounts = Object.entries(data.transform.rowCounts ?? {});
    const childCounts = Object.entries(data.transform.childRowCounts ?? {});
    lines.push(
      ...table(
        ["Fact", "Value"],
        [
          ["Tables written", String(rowCounts.length)],
          ["Rows written", String(rowCounts.reduce((sum, [, n]) => sum + n, 0))],
          ["Child rows written", String(childCounts.reduce((sum, [, n]) => sum + n, 0))],
          ["Retained text hashes", String((data.transform.retainedTextHashes ?? []).length)],
          [
            "Unmapped fields",
            (data.transform.unmapped ?? []).length
              ? data.transform.unmapped.join(", ")
              : "none",
          ],
        ],
      ),
      ...table(
        ["Postgres table", "Rows"],
        rowCounts.sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => [n, String(c)]),
      ),
    );
  } else {
    lines.push("_no transform report_", "");
  }

  lines.push("## Step 3.5. Audit", "");
  if (data.audit) {
    lines.push(
      `Verdict: **${data.audit.ok ? "no violations" : `${data.audit.violationCount} violation(s)`}**`,
      "",
      "Offending values are redacted; this log and this artifact are public.",
      "",
      ...table(
        ["Table.constraint", "Violations"],
        Object.entries(data.audit.violationsByConstraint ?? {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      ),
      ...table(
        ["Skipped constraint", "Kind", "Reason"],
        (data.audit.skipped ?? []).map((s) => [
          `${s.table}.${s.constraint}`,
          s.kind,
          s.reason,
        ]),
      ),
    );
  } else {
    lines.push("_no audit report_", "");
  }

  for (const [heading, report] of [
    ["## Steps 4 and 5. Isolated load and parity", data.parityIsolated],
    ["## Step 8. Live load and parity", data.parityLive],
  ]) {
    if (!report) continue;
    lines.push(heading, "");
    lines.push(
      `Verdict: **${report.ok ? "pass" : "FAIL"}**`,
      "",
      ...table(
        ["Check", "Status", "Details"],
        (report.results ?? []).map((result) => [
          result.name,
          result.status,
          result.details.length
            ? result.details.slice(0, MAX_DETAILS).join("<br>")
            : "-",
        ]),
      ),
    );
  }

  if (data.rehearsalProof) {
    lines.push("## Step 10. Backup-shape rehearsal", "");
    const proof = data.rehearsalProof;
    lines.push(
      ...table(
        ["Check", "Result"],
        [
          ["Parity capture", proof.parityCapture ? "captured" : (proof.skipped ?? "skipped")],
          [
            "Tables captured",
            proof.parityCapture ? String(proof.parityCapture.tables.length) : "-",
          ],
          [
            "Unvalidated constraints",
            proof.parityCapture ? String(proof.parityCapture.invalidConstraints) : "-",
          ],
          [
            "Sampled cited answer",
            proof.citationSample?.available
              ? `citation hash matched: ${proof.citationSample.citationHashMatched}`
              : (proof.citationSample?.reason ?? "not attempted"),
          ],
          ["Dated encrypted dump", proof.datedBackup ?? "not run"],
        ],
      ),
    );
    if (proof.parityCapture) {
      lines.push(
        ...table(
          ["Relation", "Rows", "SHA-256"],
          proof.parityCapture.tables.map((t) => [
            t.name,
            String(t.rowCount),
            `\`${t.sha256}\``,
          ]),
        ),
      );
    }
  }

  if (data.financeComparison) {
    lines.push("## Step 8 acceptance. `finance` before and after", "");
    lines.push(
      `Verdict: **${data.financeComparison.ok ? "unchanged" : "CHANGED"}**`,
      "",
      ...table(
        ["Fact", "Value"],
        [
          ["finance.schema_version", String(data.financeComparison.financeSchemaVersion)],
          ["kith schema version after", String(data.financeComparison.kithSchemaVersionAfter)],
          [
            "Differences",
            data.financeComparison.differences.length
              ? data.financeComparison.differences.join("<br>")
              : "none",
          ],
        ],
      ),
      ...table(
        ["finance table", "Rows before", "Rows after"],
        (data.financeComparison.financeTables ?? []).map((t) => [
          t.name,
          String(t.rowCount),
          String(t.rowCountAfter),
        ]),
      ),
    );
  }

  if (data.hostBefore) {
    lines.push("## Step 1. Host verification", "");
    lines.push(
      ...table(
        ["Fact", "Value"],
        [
          ["Server version", data.hostBefore.server],
          ["`vector` installed", String(data.hostBefore.vector.installed)],
          ["`vector` available", String(data.hostBefore.vector.available)],
          ["`kith` version before", String(data.hostBefore.kith.schemaVersion)],
          ["`kith` version expected", String(data.hostBefore.kith.expectedVersion)],
          ["`kith_reader` present", String(data.hostBefore.kith.readerRolePresent)],
          ["`kith_reader` read-only", String(data.hostBefore.kith.readerRoleReadOnly)],
          ["`finance` version", String(data.hostBefore.finance.schemaVersion)],
          [
            "Problems",
            data.hostBefore.problems.length ? data.hostBefore.problems.join("<br>") : "none",
          ],
        ],
      ),
    );
  }

  if (data.appRole) {
    lines.push("## Runbook step 9, role half. App role", "");
    lines.push(
      ...table(
        ["Fact", "Value"],
        [
          ["Role name", data.appRole.role],
          ["Verdict", data.appRole.ok ? "ok" : "FAILED"],
          ["Role state", data.appRole.created ? "created" : "updated"],
          ["Can read `kith`", String(data.appRole.appRoleCanRead)],
          ["Refused CREATE", String(data.appRole.appRoleCannotCreate)],
          [
            "Problems",
            data.appRole.problems.length ? data.appRole.problems.join("<br>") : "none",
          ],
        ],
      ),
    );
  }

  lines.push(
    "## What stays manual",
    "",
    "Plan section 3 step 9's remainder: quiesce the worker and the backup schedule,",
    "set the deployment variables, redeploy, sign in once, restart the worker and run",
    "the post-cutover checks. See `docs/plans/2026-09-16-cutover-runbook.md`.",
    "",
  );
  return lines.join("\n");
}

async function summary(argv) {
  const reports = flag(argv, "--reports") ?? "reports";
  const data = {
    manifest: await readJsonIfPresent(join(reports, "manifest.json")),
    manifestVerification: await readJsonIfPresent(join(reports, "manifest-verification.json")),
    transform: await readJsonIfPresent(join(reports, "transform-report.json")),
    audit: await readJsonIfPresent(join(reports, "audit-report.json")),
    parityIsolated: await readJsonIfPresent(join(reports, "parity-isolated.json")),
    parityLive: await readJsonIfPresent(join(reports, "parity-live.json")),
    rehearsalProof: await readJsonIfPresent(join(reports, "rehearsal-proof.json")),
    financeComparison: await readJsonIfPresent(join(reports, "finance-comparison.json")),
    hostBefore: await readJsonIfPresent(join(reports, "host-before.json")),
    appRole: await readJsonIfPresent(join(reports, "app-role.json")),
  };
  const text = buildSummary(
    {
      mode: flag(argv, "--mode") ?? "rehearsal",
      run: flag(argv, "--run"),
      revision: flag(argv, "--revision"),
    },
    data,
  );
  const out = flag(argv, "--out");
  if (out) await writeFile(out, `${text}\n`);
  else process.stdout.write(`${text}\n`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "redact") return redact(argv);
  if (command === "summary") return summary(argv);
  throw new Error("usage: cutover-report.mjs <redact|summary> [options]");
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? "runner_failed"}\n`);
    process.exitCode = 1;
  });
