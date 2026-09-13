#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { generateKithMigrateTablesSql } from "./ddl.js";
import { exportConvexData, verifyManifest, type ExportManifest } from "./export.js";
import { loadCsvDirectory } from "./load.js";
import { runParityChecks } from "./parity.js";
import { transformExport, type TransformReport } from "./transform.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      dir: { type: "string" },
      source: { type: "string" },
      export: { type: "string" },
      csv: { type: "string" },
      "database-url": { type: "string" },
      "deployment-identity": { type: "string" },
      "schema-version": { type: "string" },
      "git-revision": { type: "string" },
      "verify-manifest": { type: "boolean" },
      "report-unmapped": { type: "boolean" },
      "transform-report": { type: "string" },
      manifest: { type: "string" },
    },
    allowPositionals: true,
  });

  switch (command) {
    case "ddl:generate": {
      const out = values.out ?? "../kith-store/migrations/004_kith_migrate_tables.sql";
      await writeFile(out, generateKithMigrateTablesSql());
      process.stdout.write(`wrote ${out}\n`);
      return;
    }
    case "export": {
      if (values["verify-manifest"]) {
        const dir = values.dir ?? fail("--dir required");
        const result = await verifyManifest(dir);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exit(1);
        return;
      }
      const source = values.source ?? fail("--source required");
      const out = values.out ?? fail("--out required");
      const manifest = await exportConvexData(source, out, {
        deploymentIdentity: values["deployment-identity"] ?? "synthetic",
        schemaVersion: Number(values["schema-version"] ?? "1"),
        gitRevision: values["git-revision"] ?? "unknown",
      });
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    case "transform": {
      const exportDir = values.export ?? fail("--export required");
      const out = values.out ?? fail("--out required");
      const report = await transformExport(exportDir, out, {
        reportUnmappedOnly: values["report-unmapped"],
      });
      await writeFile(
        `${out}/transform-report.json`,
        JSON.stringify(report, null, 2),
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!values["report-unmapped"] && report.unmapped.length) process.exit(1);
      return;
    }
    case "load": {
      const csv = values.csv ?? fail("--csv required");
      const databaseUrl = values["database-url"] ?? fail("--database-url required");
      await loadCsvDirectory({ connectionString: databaseUrl }, csv);
      process.stdout.write("loaded\n");
      return;
    }
    case "parity": {
      const databaseUrl = values["database-url"] ?? fail("--database-url required");
      const exportDir = values.export ?? fail("--export required");
      const manifestPath = values.manifest ?? `${exportDir}/manifest.json`;
      const transformReportPath =
        values["transform-report"] ?? `${values.csv ?? "."}/transform-report.json`;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as ExportManifest;
      const transformReport = JSON.parse(
        await readFile(transformReportPath, "utf8"),
      ) as TransformReport;
      const report = await runParityChecks({
        connectionString: databaseUrl,
        exportDir,
        manifest,
        transformReport,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exit(1);
      return;
    }
    default:
      fail(
        "usage: kith-migrate <ddl:generate|export|transform|load|parity> [options]",
      );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
