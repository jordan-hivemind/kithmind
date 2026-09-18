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
3. **One exported snapshot.** The engine opens a `REPEATABLE READ`
   transaction on the source, calls `pg_export_snapshot()`, and holds that
   transaction open. The dump and the parity capture below both read that one
   snapshot id, so they describe the same instant of a database that is still
   being written to. Releasing the snapshot fails the run if the holding
   session died meanwhile, because a snapshot whose transaction ended
   guarantees nothing. Writer quiescence (step 2) still applies; the snapshot
   is what makes the manifest honest about the writes quiescence cannot cover,
   such as a filesystem watcher heartbeat or an MCP write.
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
6. **Encryption and publication.** Unchanged from the Convex-era recipe: `age`
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
7. **Separate-process verification.** A freshly spawned process, holding only
   the verify-only age identity (never the encryption recipient's public key
   path used to publish), re-downloads the ciphertext with a fresh `--no-cache`
   restic invocation, decrypts, and compares bytes against what the backup
   process itself hashed. It then drives an isolated restore (below) and
   requires its exact `{status:"passed"}` result.

## Isolated restore proof

`scripts/db-restore-proof.mjs --isolated` is the engine's own restore check,
invoked by the separate verify process above and runnable standalone against
a downloaded dump and manifest. It:

- checks the dump's SHA-256 and byte length against the manifest before it
  connects to anything;
- refuses an alias of the source (same database identity) or a non-empty
  target, so the restore can only ever land in a genuinely isolated database;
- checks, against the live source, only what stays true while that source is
  being written to: it is reachable, it is the database named in the manifest,
  and both schema versions match the manifest and the configuration;
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
isolation check, so it can never reach the source. It drops every non-system
schema, including `public`, which the dump's own `CREATE EXTENSION` restores.
A failing proof leaves the restored copy in place for inspection; the next
run's reset clears it.

### Failure codes

The verify worker and the top-level runner now report which check failed
instead of a generic command failure:

| Where                          | Code                              |
| ------------------------------ | --------------------------------- |
| Isolated restore proof child   | `restore_proof_failed:<code>`, where `<code>` is one of the proof's own codes, such as `restore_parity_failed`, `restore_target_not_empty`, `source_schema_mismatch`, `scratch_database_name_invalid` |
| Ciphertext or plaintext readback | `verify_readback_mismatch`      |
| Unreadable child answer        | `restore_proof_failed:unknown`    |

Codes are closed enums on both sides, and the child's own output is never
echoed. The code reaches the runner's result, the state directory's
`failureCode`, and the CLI's stderr line.

### Private restore-proof configuration

The owner's private restore-proof configuration file, the one named by
`restoreProofConfigPath`, takes one new key. Everything else is unchanged, and
a configuration without the key keeps the previous behaviour.

```json
{
  "scratchDatabase": true
}
```

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

## Archive changes

Before an archive-root relocation, quiesce all archive writers that use the
root, including ingestion workers and scheduled database backups. Before a
writer’s runtime or dependency change, quiesce the affected writers.
Verify no backup runner or child process remains active, preserve locks and
failure evidence, and resume schedules only after required checks pass.
