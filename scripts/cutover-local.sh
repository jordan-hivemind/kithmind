#!/usr/bin/env bash
# The documented local rehearsal of .github/workflows/cutover.yml.
#
# It runs the same commands with the same flags as the workflow's steps 1 to 5
# and step 10's rehearsal half, against a local PostgreSQL and the synthetic
# Convex export fixture `@repo/kith-migrate` already ships. The workflow cannot
# be run from a developer machine and its own export needs the owner's Convex
# deploy key, so this script is how the command sequence is exercised before
# anyone clicks run.
#
# The one deliberate difference: step 2's `npx convex export --prod
# --include-file-storage --path <zip>` is replaced by writing the synthetic
# fixture in the same on-disk layout Convex produces (one directory per table,
# each holding `documents.jsonl`). Everything downstream of that is identical.
# No real data, no secret and no live database is involved.
#
# Usage:
#   KITH_STORE_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
#     bash scripts/cutover-local.sh [--stage <dir>]
#
# The admin URL is only ever used to create and drop two throwaway databases;
# nothing is written to the database it names.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${KITH_STORE_DATABASE_URL:-}"
if [ -z "$ADMIN_URL" ]; then
  echo "KITH_STORE_DATABASE_URL is not set. Point it at a local throwaway PostgreSQL." >&2
  exit 1
fi

STAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$STAGE" ]; then
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/kith-cutover-local.XXXXXX")"
fi
mkdir -p "$STAGE"
STAGE="$(cd "$STAGE" && pwd)"

# Step 2's acceptance: staging at mode 700, files at 600. The export and the
# transform write their own files at 600; this makes the directory match.
chmod 700 "$STAGE"
REPORTS="$STAGE/reports"
mkdir -p "$REPORTS"
chmod 700 "$REPORTS"

SUFFIX="$(date +%Y%m%d%H%M%S)_$$"
AUDIT_DB="kith_cutover_audit_$SUFFIX"
ISOLATED_DB="kith_cutover_isolated_$SUFFIX"

db_url() {
  node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; process.stdout.write(u.toString());' \
    "$ADMIN_URL" "$1"
}

cleanup() {
  psql "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"$AUDIT_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  psql "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"$ISOLATED_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { echo; echo "=== $1 ==="; }

# --- Step 1. Preflight -------------------------------------------------------
step "step 1: preflight"
echo "revision: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "node: $(node --version)"
echo "pnpm: $(pnpm --version)"
echo "psql: $(psql --version)"
echo "staging: $STAGE"
pnpm --filter @repo/kith-migrate build >/dev/null
SCHEMA_VERSION="$(node --input-type=module -e \
  'const m = await import(process.argv[1]); process.stdout.write(String(m.KITH_SCHEMA_VERSION));' \
  "$ROOT/packages/kith-store/dist/schema.js")"
REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "kith schema version: $SCHEMA_VERSION"

KITH_MIGRATE="$ROOT/packages/kith-migrate/dist/cli.js"

# --- Step 2. Export ----------------------------------------------------------
step "step 2: export (synthetic fixture stands in for the Convex ZIP)"
node --input-type=module -e \
  'const m = await import(process.argv[1]); await m.writeConvexExportDir(process.argv[2]);' \
  "$ROOT/packages/kith-migrate/test/fixtures/buildFixture.mjs" "$STAGE/convex-export"
node "$KITH_MIGRATE" export \
  --source "$STAGE/convex-export" \
  --out "$STAGE/export" \
  --deployment-identity redacted \
  --schema-version "$SCHEMA_VERSION" \
  --git-revision "$REVISION" \
  > "$REPORTS/manifest.json"
cat "$REPORTS/manifest.json"
node "$KITH_MIGRATE" export --verify-manifest --dir "$STAGE/export" \
  > "$REPORTS/manifest-verification.json"
cat "$REPORTS/manifest-verification.json"

# --- Step 3. Transform -------------------------------------------------------
step "step 3: transform"
node "$KITH_MIGRATE" transform --export "$STAGE/export" --out "$STAGE/csv" >/dev/null
cp "$STAGE/csv/transform-report.json" "$REPORTS/transform-report.json"
node -e 'const r = require(process.argv[1]); console.log(JSON.stringify({tables: Object.keys(r.rowCounts).length, rows: Object.values(r.rowCounts).reduce((a,b)=>a+b,0), unmapped: r.unmapped}));' \
  "$REPORTS/transform-report.json"

# --- Step 3.5. Audit ---------------------------------------------------------
step "step 3.5: audit against a throwaway database"
psql "$ADMIN_URL" -X -q -c "CREATE DATABASE \"$AUDIT_DB\"" >/dev/null
AUDIT_URL="$(db_url "$AUDIT_DB")"
# stdout is a file, not the console: an audit violation's detail quotes the
# offending column value, and the workflow's log is public.
AUDIT_STATUS=0
node "$KITH_MIGRATE" audit --csv "$STAGE/csv" --database-url "$AUDIT_URL" \
  > "$STAGE/audit-stdout.json" || AUDIT_STATUS=$?
cp "$STAGE/csv/audit-report.json" "$STAGE/audit-report.json" 2>/dev/null || true
node "$ROOT/scripts/cutover-report.mjs" redact --staging "$STAGE" --reports "$REPORTS"
node -e 'const r = require(process.argv[1]); console.log(JSON.stringify({ok: r.ok, violations: r.violationCount, skipped: r.skipped.length}));' \
  "$REPORTS/audit-report.json"
if [ "$AUDIT_STATUS" -ne 0 ]; then
  echo "audit reported violations; see $REPORTS/audit-report.json" >&2
  exit "$AUDIT_STATUS"
fi

# --- Steps 4 and 5. Isolated load and parity ---------------------------------
step "steps 4 and 5: isolated load and parity"
psql "$ADMIN_URL" -X -q -c "CREATE DATABASE \"$ISOLATED_DB\"" >/dev/null
ISOLATED_URL="$(db_url "$ISOLATED_DB")"
node "$KITH_MIGRATE" load --csv "$STAGE/csv" --database-url "$ISOLATED_URL"
node "$KITH_MIGRATE" parity \
  --database-url "$ISOLATED_URL" \
  --export "$STAGE/export" \
  --csv "$STAGE/csv" \
  > "$REPORTS/parity-isolated.json"
node -e 'const r = require(process.argv[1]); console.log(JSON.stringify({ok: r.ok, results: r.results.map(x=>`${x.name}:${x.status}`)}));' \
  "$REPORTS/parity-isolated.json"

# --- Step 10 rehearsal half --------------------------------------------------
step "step 10: backup-shape rehearsal against the loaded throwaway"
KITH_CUTOVER_DATABASE_URL="$ISOLATED_URL" \
  node "$ROOT/scripts/cutover-rehearsal-proof.mjs" --out "$STAGE/rehearsal-proof.json"

# --- Summary -----------------------------------------------------------------
step "summary"
node "$ROOT/scripts/cutover-report.mjs" redact --staging "$STAGE" --reports "$REPORTS"
node "$ROOT/scripts/cutover-report.mjs" summary \
  --reports "$REPORTS" \
  --mode rehearsal \
  --run local \
  --revision "$REVISION" \
  --out "$STAGE/summary.md"
echo "summary: $STAGE/summary.md"
echo "reports: $REPORTS"
ls -1 "$REPORTS"
