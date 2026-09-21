# Database backups

**Status, 2026-09-21:** Historical operating guide. The owner selected Neon as
the sufficient Postgres persistence boundary and does not require a separate
database backup. The dump, encryption, restic, schedule, retention and restore
steps below must not be enabled without a new explicit owner request.

Kith Mind’s native database snapshot assurance covers the application database
and its stored files. It does not duplicate original Dropbox PDFs; provider
originals remain governed by their separate recovery references.

A native snapshot is encrypted before it is sent to the remote backup
repository. Recovery records bind an exact repository boundary and require
ciphertext readback and decryption checks. Those checks establish that the
archived encrypted artifact can be recovered. They are distinct from an
isolated local restore, which checks the restored schema and data shape without
proving that deployed application code is identical.

The owner-specific export and backup adapters are not public interfaces. The
public generic runner is merged. It creates a fresh protected staging directory,
passes that directory explicitly to an export adapter, then passes the same
directory explicitly to a backup adapter. It retains bounded status evidence
and fails closed if another run holds its lock.

A daily schedule runs only when the owner machine is logged in and awake. A missed time is handled by the next available scheduled run; this guide
does not promise provider behavior or an exact catch-up time.

`scripts/db-backup.mjs` runs restic's own `forget`/`prune` once a backup has
been independently verified (never before), scoped to this recipe's snapshots
only (see [Retention](#retention) below). The generic public runner
(`scripts/run-database-backup.mjs`) still does not prune staging directories
or remote backups itself; that is the CLI's own responsibility after
verification, not the runner's or the engine's. Recovery identities and keys
are managed separately from this guide and are never included in commands,
logs, or public configuration.

## Public runner contract

`scripts/run-database-backup.mjs` is a generic runner. It does not contain an
export implementation, backup implementation, schedule, or recovery key. Run
it with one protected absolute configuration path:

```sh
node scripts/run-database-backup.mjs --config /absolute/protected/database-backup.json
```

The configuration file must be canonical, protected, and mode `0600`. Its
state and staging directories must be canonical, existing, protected, and mode
`0700`; command paths must be absolute. A synthetic configuration is:

```json
{
  "version": 1,
  "stateDirectory": "/absolute/private/state",
  "stagingRoot": "/absolute/private/staging",
  "cwd": "/absolute/project",
  "timeoutMs": 600000,
  "exportCommand": {
    "path": "/absolute/tools/export",
    "args": ["--format", "native"]
  },
  "backupCommand": {
    "path": "/absolute/tools/backup",
    "args": ["--mode", "remote"]
  }
}
```

The runner creates a fresh protected staging directory. It appends
`--output-directory` and that directory to the export command, then requires a
exact stdout JSON `{ "status": "passed" }`. Only after export succeeds does it append
`--input-directory` and the same directory to the backup command, which also
must emit a exact stdout JSON `{ "status": "passed" }`. Commands run without a shell.

The state directory records bounded `running`, `failed`, or `succeeded` status
and preserves the last successful time across a failure, plus the last
successful isolated-restore-proof time and when the next one is due (see
[Restore-proof cadence](#restore-proof-cadence)), and the outcome of the most
recent retention attempt (see [Retention](#retention)). A lock conflict fails
closed. Before manual lock recovery, verify no runner or child process remains
active and preserve failed status evidence. The generic runner itself does not
automatically prune staging directories, prune remote backups, or forget
snapshots; `scripts/db-backup.mjs` runs retention itself, only after
verification succeeds (see [Retention](#retention)).

Owner export and backup adapters remain private. The public setup does not
install a schedule. Operators must configure and verify their own scheduler and
adapter implementation.

## PostgreSQL engine: both schemas in one dump

[`docs/plans/2026-09-12-postgres-consolidation.md`](plans/2026-09-12-postgres-consolidation.md)
step 10 replaces the native Convex export in the dated-backup recipe with a
`pg_dump` of both schemas from the one PostgreSQL database. The engine
component is `scripts/db-backup-postgres.mjs`; the public runner above still
supplies the lock, staging directory, and durable status journal, and passes
that directory to whatever export and backup commands the runner's own
configuration names.

The engine, in order:

1. **Preflight.** Connects with the configured connection command and
   confirms `current_database()` matches the expected name; a mismatch fails
   closed before anything is dumped. It also reads `finance.schema_version`
   and `kith.schema_version` and records them as-is into the manifest (step
   5) rather than checking them against a configured expectation: a schema
   version is expected to move as migrations ship, and requiring an operator
   to edit `expectedFinanceSchemaVersion`/`expectedKithSchemaVersion` after
   every one is exactly the pinning this recipe removed (owner decision,
   2026-09-20). Both keys are still accepted in the backup and restore-proof
   configs for backward compatibility, but are optional; when present and the
   live value differs, the run logs a `schema_version_recorded_not_pinned`
   notice on stderr and continues rather than failing.
2. **Writer quiescence.** Refuses to start if `kith.deferred_work` has a row in
   `running`, or if any of `kith.worker_jobs`, `kith.ingest_jobs`,
   `kith.worker_discovery_work`, or `kith.worker_reservation_targets` has an
   unexpired `lease_expires_at`. The failure names the exact table and count
   that blocked it, matching AGENTS.md's archive-writer quiescence rule: a
   dump started while a writer holds a lease cannot honestly claim one
   consistent snapshot.
3. **One exported snapshot.** The engine opens a `REPEATABLE READ`
   transaction on the source, calls `pg_export_snapshot()`, and holds that
   transaction open. The dump and the parity capture below both read that one
   snapshot id, so they describe the same instant of a database that is still
   being written to. Releasing the snapshot fails the run if the holding
   session died meanwhile, because a snapshot whose transaction ended
   guarantees nothing. Writer quiescence (step 2) still applies; the snapshot
   is what makes the manifest honest about the writes quiescence cannot cover,
   such as a filesystem watcher heartbeat or an MCP write.

   The connection command must return a direct connection string, not a pooled
   endpoint. One session has to hold the snapshot open while others import it,
   which a transaction pooler cannot provide. The engine proves a second
   session can import the snapshot before the dump starts, and fails with
   `snapshot_not_importable` when it cannot, rather than failing obscurely
   minutes later.

   The holding session clears its own `idle_in_transaction_session_timeout`
   and `statement_timeout`, and runs a trivial statement every 60 seconds
   while the capture and dump proceed. The session is idle inside a
   transaction for as long as the dump takes, and a hosted platform may cap or
   ignore what a session asks for. A holder cut off anyway fails the run with
   `snapshot_holder_lost` instead of publishing a dump whose manifest cannot
   be trusted.
4. **Dump.** `pg_dump --snapshot=<id> --format=custom --no-owner --no-acl
   --schema=finance --schema=kith --extension=vector`. `--extension=vector` is
   required, not cosmetic: `--schema` alone excludes extensions, and
   `kith.embedding_vectors.embedding` is `public.vector`, so without it an
   isolated restore into a genuinely empty database fails restoring that one
   table.
5. **Manifest.** Records the export date, host, operation id, Git revision,
   both schema versions (`financeSchemaVersion` from `finance.schema_version`,
   `kithSchemaVersion` from `kith.schema_version`), the parity capture taken
   inside the dump's own snapshot, and the dump file's SHA-256 and byte
   length. Parity covers every `finance` and `kith` table's row count and a
   canonical content hash of its rows. It covers no sequence value and no
   planner statistic, so nothing in it can drift inside one snapshot.
6. **Encryption and publication.** Mostly unchanged from the Convex-era
   recipe: `age` encryption of the dump and manifest, a restic repository
   identity check before publication, and `restic backup` with `--host` set
   to the configured host and two `--tag` values: the configured
   `operationId` (unchanged) and, new in this row, the fixed tag `kith-db` on
   every snapshot this recipe creates (see [Retention](#retention)).
   `resticRepositoryPath` is either a local absolute path or restic's rclone
   backend spec, `rclone:<remote>:<path>`, which is how the
   [Dropbox-independent repository](plans/2026-09-08-dropbox-independent-backup.md)
   is reached. The engine does not vet `rclone` itself: restic resolves it
   from `PATH`, so the operator puts a protected wrapper named `rclone`, one
   that execs the pinned rclone binary with the dedicated `--config`, first on
   the `PATH` the engine runs under. A wrong or hostile rclone only ever sees
   ciphertext, and the repository identity check plus the separate-process
   readback below still fail closed.

   A dropped connection during the snapshot-export-and-dump sequence (steps
   3-4) -- the failure mode that hit the laptop LaunchAgent mid-export -- is
   retried up to 3 times with backoff (2s, then 5s) before the run is marked
   failed. Each attempt exports a fresh snapshot; a lost connection can kill
   the snapshot-holding session as easily as it can kill `pg_dump`, so a bare
   `pg_dump` retry against a dead holder would only fail again with
   `snapshot_holder_lost`. If every attempt fails, the staging directory is
   removed before the error is reported, so a partial dump never lingers.
7. **Separate-process verification.** A freshly spawned process, holding only
   the verify-only age identity (never the encryption recipient's public key
   path used to publish), re-downloads the ciphertext with a fresh `--no-cache`
   restic invocation, decrypts, and compares bytes against what the backup
   process itself hashed. It then drives an isolated restore (below) and
   requires its exact `{status:"passed"}` result. Retention (below) runs only
   after this step succeeds, never before: `--prune` running on an unverified
   backup could age an older, known-good snapshot out on the strength of a
   new one that turns out not to verify.

## Retention

After verification (step 7) succeeds -- orchestrated by `scripts/db-backup.mjs`,
not the engine itself -- it runs restic's own retention policy, scoped so it
can only ever touch snapshots this recipe created:

```
restic forget --host <host> --tag kith-db --group-by host \
  --keep-daily <keepDaily> --keep-weekly <keepWeekly> --keep-monthly <keepMonthly> \
  --prune
```

`--group-by host` is required, not cosmetic. restic's default grouping is
`host,paths`, and every run's staging directory is uniquely timestamped
(`freshStagingDirectory`), so every snapshot's recorded `paths` differs from
every other snapshot's. Without `--group-by host`, every snapshot lands alone
in its own group, `--keep-daily 7` (etc.) trivially keeps that one snapshot,
and `forget` removes nothing -- ever, silently, while `--prune` still runs
every night for no reason. `--group-by host` (not `host,tags`: `operationId`
can vary run to run) puts every `kith-db`-tagged snapshot on this host into
one group, so the keep-daily/weekly/monthly buckets actually apply across the
full set the `--host`/`--tag` filters already selected.

A restic repository is not necessarily dedicated to database backups. The
pipeline's independent document-archive backup
(`pdfDocQa.archive.independentBackup.repositoryPath`/`.repository` in
`packages/pipeline/src/config.ts`) is a separately configured
`resticRepositoryPath`/rclone spec with no code linkage to this engine's own
`resticRepositoryPath`; nothing stops an operator pointing both at the same
repository, and the archive docs describe its repository as "dedicated" only
as an operational convention, not an enforced one. Scoping `forget` to the
`kith-db` tag (added to every snapshot in step 6, above) and this engine's own
`--host` is what keeps a shared repository's other snapshot kinds out of the
candidate set entirely, regardless of what the operator does with the
repository path.

Retention is config, not hard-coded, under `resticRetention` in the backup
config (all three keys optional, independently, but their sum must be at
least 1 -- all zero would keep nothing at all, every run, with only restic's
own guard standing between that config and a full delete):

| Key           | Default | Meaning                              |
| ------------- | ------- | ------------------------------------- |
| `keepDaily`   | 7       | Most recent daily snapshots to keep   |
| `keepWeekly`  | 5       | Most recent weekly snapshots to keep  |
| `keepMonthly` | 12      | Most recent monthly snapshots to keep |

```json
{
  "resticRetention": { "keepDaily": 7, "keepWeekly": 5, "keepMonthly": 12 }
}
```

A `forget` or `prune` failure never fails the backup run itself: the backup
that was just independently verified stays a success regardless of what
retention does afterward. It is not silent, though: it is logged as a
`retention_failed` notice on stderr, and it is written into the durable
status journal (`database-backup-status.json`) as

```json
{ "retention": { "state": "failed", "code": "<code>", "at": <epoch-ms>, "removed": null, "kept": null } }
```

so a health check reading that one file, not grepping logs, can alert on it.
`state` is `"ok"` after a successful `forget`/`prune`, `"failed"` on the error
case above, or `"skipped"` when verification itself failed (or a run failed
even earlier, before retention was ever reached) and retention never ran at
all (its own case, not folded into `"failed"`, so the two causes stay
distinguishable). A SUCCESSFUL run that never reaches the retention step --
only the convex engine today, which has none -- leaves the prior run's
recorded `retention` value in place, the same way `lastSuccessAt` already
survives a failure. A FAILED run does not: it never reports a stale prior
outcome (say, a previous `"ok"`) as though retention ran fine this time: it
is recorded `"skipped"` instead.

Run retention by hand, without touching Postgres, age, or the dump/publish
path, with the backup config's own `--forget`:

```sh
node scripts/db-backup-postgres.mjs --forget --config /absolute/protected/backup.json [--apply]
```

This is dry-run by default -- it never prunes unless `--apply` is given. Any
argument other than `--config <path>` and `--apply` (including the old
`--dry-run` flag, no longer needed since it is now the default) is rejected
as `usage_invalid` rather than silently ignored.

Without `--apply`, it prints what would be forgotten -- counts and the
removed snapshots' times only, never snapshot contents or paths -- and does
not prune:

```json
{ "status": "passed", "dryRun": true, "keptCount": 12, "removedCount": 3, "removedTimes": ["2026-08-01T03:00:00Z", "2026-08-02T03:00:00Z", "2026-08-03T03:00:00Z"] }
```

Review what it reports, then run the identical command with `--apply` added
once satisfied it matches expectations.

Unlike the automatic post-verification run above, this manual command's own
failure is not swallowed: a bad config or an unreachable repository exits
non-zero, because an operator running it by hand wants to know.

A `prune` killed mid-run (a `command_timeout`, or the process being killed
outright) can leave a stale repository lock behind. Before running `restic
unlock` by hand, confirm no backup or forget process for this repository is
still alive; then run `restic unlock` against the same `--repo`/
`--password-command`. Never script or automate the unlock itself -- a lock
held by a run that is still genuinely in progress must not be cleared out
from under it.

### One-time retroactive retention for pre-existing snapshots

Snapshots created before this row shipped carry no `kith-db` tag, so the
automatic policy above never sees them and never ages them out. Bringing them
under retention is a deliberate, one-time, manual operator action, scoped by
the stable `operationId` tag instead (never automated, and always dry-run
first):

```sh
restic --repo <repositoryPath> --password-command <resticPasswordCommand> forget \
  --host <host> --tag <operationId> --group-by host \
  --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --dry-run
```

Review what it reports, then run the identical command without `--dry-run`
and with `--prune` added, once satisfied it matches expectations. New
snapshots are already covered automatically by the `kith-db` tag above; this
is only for the backlog that predates it.

## Restore-proof cadence

The isolated restore proof (documented in full below -- a full `pg_restore`
into a scratch database plus a parity recapture) is the expensive part of
verification. It now runs on a cadence, not on every backup:
`restoreProofEveryDays` in the verify config, default 30. The daily
ciphertext/plaintext readback and manifest checks (step 7, above) are
unaffected and still run every time; only the isolated restore itself moves
off "every run".

The state directory's durable status journal (`database-backup-status.json`)
carries `lastProofAt` and `nextProofDueAt` alongside the existing
`lastSuccessAt`, so a health check can read all three from one file: last
backup success, last proof success, and when the next proof is due. Alert if
`nextProofDueAt` is more than twice `restoreProofEveryDays` in the past --
that is a proof that has silently stopped running, not a due-soon warning.

A run that does not attempt a proof (because it is not due) carries the prior
`lastProofAt`/`nextProofDueAt` forward unchanged, on both success and
failure, exactly like `lastSuccessAt` already does. Force a proof regardless
of cadence with `--proof-now`:

```sh
node scripts/db-backup.mjs --engine postgres --config /absolute/protected/backup.json \
  --verify --verify-config /absolute/protected/verify.json --proof-now
```

## Isolated restore proof

`scripts/db-restore-proof.mjs --isolated` is the engine's own restore check,
invoked by the separate verify process above and runnable standalone against
a downloaded dump and manifest. It:

- checks the dump's SHA-256 and byte length against the manifest before it
  connects to anything;
- refuses an alias of the source (same database identity) or a non-empty
  target, so the restore can only ever land in a genuinely isolated database;
- checks, against the live source, only what stays true while that source is
  being written to: it is reachable and it is the database named in the
  manifest. Its schema versions are read and, when a config still carries an
  `expected*SchemaVersion`, a drift is logged as a notice, never checked
  against the manifest -- a migration can land on the live source at any
  point between the dump and this proof running, and that is expected, not
  corruption (schema versions are recorded, not pinned; see the preflight
  step above);
- restores the dump, recaptures parity against the restored database, and
  requires it to equal the manifest's parity exactly;
- reads one active document back through `@repo/kith-store`'s own
  `documents.getDocument` — the real application read path, not a raw query —
  recomputes the SHA-256 of its first citation's quote, and compares it with
  the stored `quoteHash`. A restored database with no active document (most
  synthetic fixtures in this repository's own tests have none) reports the
  sample as unavailable rather than failing; a citation whose hash does not
  match fails the whole restore proof, because that is exactly the kind of
  corruption this check exists to catch.

The comparison that carries the proof's meaning is restored against manifest,
not restored against the live source. The source of a running system has
always moved on by the time a proof runs, so a source comparison could only
pass on an idle database. Comparing with the manifest is not weaker, because
the manifest's parity was captured inside the dump's own exported snapshot:
restored equals manifest means the published dump restores to exactly what was
dumped.

### Self-cleaning scratch target

A passing proof leaves a populated restore target, which the next run would
refuse as non-empty. The proof can empty its own target, but only when the
operator opts in by name:

| Condition                                        | Behaviour                                         |
| ------------------------------------------------ | ------------------------------------------------- |
| `scratchDatabase` absent or `false`               | Unchanged: an empty target is required, and is left populated |
| `scratchDatabase: true`, name matches the prefix  | Emptied before the restore, and again after a passing proof |
| `scratchDatabase: true`, name does not match      | `scratch_database_name_invalid`, nothing is touched |

The name is the restore target's own `current_database()`, and it must match
`kith_restore_proof[a-z0-9_]*`. The reset runs through the destination
connection only, so it can reach no other database, and it runs after the
isolation check. A target whose name equals the source's, or the name the
manifest records, is refused as `restore_not_isolated` before any drop. It
drops every non-system schema, including `public`, which the dump's own
`CREATE EXTENSION` restores. Temporary schemas (`pg_temp_N`,
`pg_toast_temp_N`) belong to live backends and are neither dropped nor counted
as leftovers.
A failing proof leaves the restored copy in place for inspection; the next
run's reset clears it.

### Failure codes

The verify worker and the top-level runner now report which check failed
instead of a generic command failure:

| Where                          | Code                              |
| ------------------------------ | --------------------------------- |
| Isolated restore proof child   | `restore_proof_failed:<code>`, where `<code>` is one of the proof's own codes, such as `restore_parity_failed`, `restore_target_not_empty`, `source_database_mismatch`, `scratch_database_name_invalid` |
| Ciphertext or plaintext readback | `verify_readback_mismatch`      |
| Unreadable child answer        | `restore_proof_failed:unknown`    |
| Pooled source connection       | `snapshot_not_importable`         |
| Holding session cut off        | `snapshot_holder_lost`            |
| Retention (`forget`/`prune`), never fails the backup | `retention_output_invalid`, or any other closed-enum code, carried in the result's own `retention.code` |

Codes are closed enums on both sides, and the child's own output is never
echoed. The code reaches the runner's result, the state directory's
`failureCode`, and the CLI's stderr line.

`source_database_mismatch` (renamed from `source_schema_mismatch`) now checks
only that the dump's manifest names the same database identity as the live
source; it no longer compares schema versions, since a schema version is
recorded from the manifest, not pinned against the live source (see the
preflight step above).

### Private restore-proof configuration

The owner's private restore-proof configuration file, the one named by
`restoreProofConfigPath`, takes one new key. Everything else is unchanged, and
a configuration without the key keeps the previous behaviour.

```json
{
  "scratchDatabase": true
}
```

`expectedFinanceSchemaVersion` and `expectedKithSchemaVersion` are now
optional in this file too (and in the backup config's own copies of the same
keys). A configuration written before this change, with both keys present,
still loads and behaves the same way it always did except that a drift no
longer fails the run -- it logs a `schema_version_recorded_not_pinned`
notice instead. A configuration written after this change can omit both keys
entirely.

The database the `destinationConnectionCommand` points at must be renamed, or
recreated, with a name starting `kith_restore_proof`. Point that command's
URL at the renamed database.

`@repo/kith-migrate`'s six parity checks (`packages/kith-migrate/src/
parity.ts`) prove the Convex-to-PostgreSQL migration itself against the
original Convex export (row b's own row); they are exercised in
`scripts/db-backup-postgres.integration.test.mjs` against a synthetic
migration fixture, but they are not what a routine backup restore proof runs,
because a routine restore has no Convex export to check against once the
database is the only store. This restore proof's own full-table content-hash
parity (above) is the check that runs on every restore, source database
versus restored database, not migration export versus destination.

## Moving the backup to a new host

This recipe has no code-level assumption tied to one host: nothing in
`scripts/db-backup-postgres.mjs`, `scripts/db-restore-proof.mjs`, or
`scripts/run-database-backup.mjs` reads `os.hostname()` or hard-codes a host
name. The backup config's `host` field is the restic `--host` label used to
tag every snapshot (step 6, above) and to scope retention (`--host` in
[Retention](#retention)). That field is what needs to stay portable, and it
already is: an operator carries it forward unchanged in the config file
across a host move, which keeps retention's `--host`/`--tag kith-db` scope
matching every snapshot this recipe has ever created, old and new. The
alternative -- deriving `host` from the machine instead of the config -- was
not implemented, because it would silently split one recipe's snapshot
history into two retention scopes the moment the host label changed.

### LaunchAgent template for the new host

Same per-user LaunchAgent shape as
[`docs/kithmind-deferred-work.launchd.plist.txt`](kithmind-deferred-work.launchd.plist.txt):
a private wrapper script loads secrets (the restic password command, the age
identity, the database connection command) from the new host's own Keychain
or credential store, then execs the runner. Replace every ALL-CAPS
placeholder with an absolute path; no personal path, account name, or
credential value belongs in this file or its copy.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.kithmind.database-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/database-backup-run.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/ABSOLUTE/PATH/TO/REPOSITORY</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/PRIVATE-LOG-DIRECTORY/database-backup.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/PRIVATE-LOG-DIRECTORY/database-backup.stderr.log</string>
</dict>
</plist>
```

`StartCalendarInterval` (once daily), not `KeepAlive`: unlike the deferred-work
daemon this plist starts, a backup run is meant to finish and exit, not run
forever. The wrapper script it names loads the restic password command, age
identity path, and connection command from the new host's credential store
and execs:

```sh
exec /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/REPOSITORY/scripts/db-backup.mjs \
  --engine postgres --config /ABSOLUTE/PROTECTED/backup.json \
  --verify --verify-config /ABSOLUTE/PROTECTED/verify.json
```

### Operator steps to move

1. Install the pinned tools (`psql`/`pg_dump` matching `POSTGRES_MAJOR` in
   `db-backup-postgres.mjs`, `age` v1.3.2, restic v0.19.1) in a protected
   directory on the new host, and put a protected `rclone` wrapper on `PATH`
   if the repository is reached through `rclone:<remote>:<path>`.
2. Place the backup and verify config files (mode `0600`, in a protected
   directory) on the new host, unchanged except for any path that pointed at
   the old host's filesystem layout. Keep `host` and `operationId` exactly as
   they were: `host` is the retention scope (above), and both are what
   already-published snapshots are tagged with.
3. Re-create the Keychain (or equivalent credential store) items the restic
   password command, age identity, and database connection command read from
   -- these are host-local secrets, never copied as files between machines.
4. Run once against retention only, to prove the new host's tools and
   credentials resolve the same repository without changing it (dry-run by
   default -- omit `--apply`):

   ```sh
   node scripts/db-backup-postgres.mjs --forget --config /ABSOLUTE/PROTECTED/backup.json
   ```

5. Load the new host's LaunchAgent (`launchctl bootstrap` / `launchctl load`,
   per the platform's current convention).
6. Unload the old host's LaunchAgent (`launchctl bootout` / `launchctl
   unload`) once the new host's first real run has published and verified
   successfully. Never run both hosts' schedules against one repository at
   the same time.

### Concurrent hosts and restic's own locking

restic itself is the backstop if step 6 is missed and both hosts' schedules
overlap: every `backup`, `forget`, and `prune` takes a lock object in the
repository first (an exclusive lock for `forget --prune`, a shared one for
`backup`), and a second process that cannot acquire the lock it needs fails
closed with a "repository is already locked" error rather than corrupting
anything. That failure surfaces as this run's own `command_failed`/ retention
failure, not a silent skip and not partial repository corruption -- but it is
still a failed or degraded run, so treat "never run both hosts concurrently"
as the operating rule and restic's locking as the safety net under it, not a
substitute for step 6.

## Archive changes

Before an archive-root relocation, quiesce all archive writers that use the
root, including ingestion workers and scheduled database backups. Before a
writer’s runtime or dependency change, quiesce the affected writers.
Verify no backup runner or child process remains active, preserve locks and
failure evidence, and resume schedules only after required checks pass.
