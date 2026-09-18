# Database backups

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

Automatic prune and forget are not part of this workflow. Retention changes
require a separately reviewed action. Recovery identities and keys are managed
separately from this guide and are never included in commands, logs, or public
configuration.

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
and preserves the last successful time across a failure. A lock conflict fails
closed. Before manual lock recovery, verify no runner or child process remains
active and preserve failed status evidence. The runner does not automatically
prune staging directories, prune remote backups, or forget snapshots.

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

1. **Preflight.** Connects with the configured connection command, confirms
   `current_database()` matches the expected name, and reads `finance.
   schema_version` and `kith.schema_version` against the versions the
   configuration expects. A mismatch on either fails closed before anything is
   dumped.
2. **Writer quiescence.** Refuses to start if `kith.deferred_work` has a row in
   `running`, or if any of `kith.worker_jobs`, `kith.ingest_jobs`,
   `kith.worker_discovery_work`, or `kith.worker_reservation_targets` has an
   unexpired `lease_expires_at`. The failure names the exact table and count
   that blocked it, matching AGENTS.md's archive-writer quiescence rule: a
   dump started while a writer holds a lease cannot honestly claim one
   consistent snapshot.
3. **Dump.** `pg_dump --format=custom --no-owner --no-acl --schema=finance
   --schema=kith --extension=vector`. `--extension=vector` is required, not
   cosmetic: `--schema` alone excludes extensions, and
   `kith.embedding_vectors.embedding` is `public.vector`, so without it an
   isolated restore into a genuinely empty database fails restoring that one
   table.
4. **Manifest.** Records the export date, host, operation id, Git revision,
   both schema versions (`financeSchemaVersion` from `finance.schema_version`,
   `kithSchemaVersion` from `kith.schema_version`), the six-check parity
   capture (see below), and the dump file's SHA-256 and byte length.
5. **Encryption and publication.** Unchanged from the Convex-era recipe: `age`
   encryption of the dump and manifest, a restic repository identity check
   before publication, and `restic backup` tagged with the host and operation
   id.
   `resticRepositoryPath` is either a local absolute path or restic's rclone
   backend spec, `rclone:<remote>:<path>`, which is how the
   [Dropbox-independent repository](plans/2026-09-08-dropbox-independent-backup.md)
   is reached. The engine does not vet `rclone` itself: restic resolves it
   from `PATH`, so the operator puts a protected wrapper named `rclone`, one
   that execs the pinned rclone binary with the dedicated `--config`, first on
   the `PATH` the engine runs under. A wrong or hostile rclone only ever sees
   ciphertext, and the repository identity check plus the separate-process
   readback below still fail closed.
6. **Separate-process verification.** A freshly spawned process, holding only
   the verify-only age identity (never the encryption recipient's public key
   path used to publish), re-downloads the ciphertext with a fresh `--no-cache`
   restic invocation, decrypts, and compares bytes against what the backup
   process itself hashed. It then drives an isolated restore (below) and
   requires its exact `{status:"passed"}` result.

## Isolated restore proof

`scripts/db-restore-proof.mjs --isolated` is the engine's own restore check,
invoked by the separate verify process above and runnable standalone against
a downloaded dump and manifest. It:

- refuses an alias of the source (same database identity) or a non-empty
  target, so the restore can only ever land in a genuinely isolated database;
- recomputes a full parity capture (every `finance`/`kith` table's row count
  and a canonical content hash) against the source immediately before
  restoring, and again against the restored database immediately after, and
  requires them to be byte-identical;
- reads one active document back through `@repo/kith-store`'s own
  `documents.getDocument` — the real application read path, not a raw query —
  recomputes the SHA-256 of its first citation's quote, and compares it with
  the stored `quoteHash`. A restored database with no active document (most
  synthetic fixtures in this repository's own tests have none) reports the
  sample as unavailable rather than failing; a citation whose hash does not
  match fails the whole restore proof, because that is exactly the kind of
  corruption this check exists to catch.

`@repo/kith-migrate`'s six parity checks (`packages/kith-migrate/src/
parity.ts`) prove the Convex-to-PostgreSQL migration itself against the
original Convex export (row b's own row); they are exercised in
`scripts/db-backup-postgres.integration.test.mjs` against a synthetic
migration fixture, but they are not what a routine backup restore proof runs,
because a routine restore has no Convex export to check against once the
database is the only store. This restore proof's own full-table content-hash
parity (above) is the check that runs on every restore, source database
versus restored database, not migration export versus destination.

## Archive changes

Before an archive-root relocation, quiesce all archive writers that use the
root, including ingestion workers and scheduled database backups. Before a
writer’s runtime or dependency change, quiesce the affected writers.
Verify no backup runner or child process remains active, preserve locks and
failure evidence, and resume schedules only after required checks pass.
