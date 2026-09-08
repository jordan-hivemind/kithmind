# Backup and restore

## Status

Kith Mind recovery has two separate parts. A native Convex snapshot preserves
the hosted database and optional Convex file storage. The filesystem worker's
encrypted archives, journal, catalog, configuration, and keys are external to
that snapshot and require their own protected backup.

An isolated native restore rehearsal has preserved exact rows from the earlier
B2 63-table schema on the tested macOS setup. The current schema bundle has not
yet completed that import drill. Full synthetic acceptance with the completed
PDF lifecycle, archive catalog, citations, forget state, and independent
archive restore is still pending. Do not use this guide as authority to resume
a restored service or ingest owner documents.

## Recovery sets

| Recovery set                    | Contents                                                                                                                        | Required verification                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Native Convex snapshot          | Every table, Convex value, system field, and included file-storage object                                                       | Table and storage membership, row counts, canonical value digests, IDs, creation times, schema, and indexes    |
| Encrypted byte archives         | Primary and independent copies of original bytes and retained parser artifacts                                                  | Destination ciphertext readback, exact receipt identity, independent decryption, plaintext SHA-256, and length |
| Worker journal and catalog      | Pending replay state, stable local source identities, archive mappings, correction history, and deletion state                  | Exact authority binding, protected-file checks, catalog row identities, and safe replay or explicit review     |
| Configuration and code identity | Worker configuration, parser and archive fingerprints, application commit, schema digest, and tool versions                     | Exact hashes and compatibility with the restored data                                                          |
| Keys and secrets                | Convex deployment access, worker credentials, age identities, restic repository credential, and any credential-store references | Separate escrow and recovery test; never include reusable secrets in a report or source repository             |

The native snapshot may contain active sessions, API-key records, leases, and
worker receipts. Preserve them for exact comparison. They remain inert during
the drill because the restore target has no application execution or
authentication surface.

## Create a native snapshot

Use the repository's installed Convex CLI and name the deployment explicitly.
Choose a new destination. The CLI requires the ZIP path to be unoccupied.

```sh
pnpm --filter @repo/db exec convex export --deployment DEPLOYMENT_REFERENCE --include-file-storage --path /protected/new-snapshot.zip
shasum -a 256 /protected/new-snapshot.zip
```

Store the unchanged ZIP and its digest in protected storage. A native snapshot
can contain credentials and private content. Do not commit it, attach it to a
public issue, or transform it in place. Record the application commit, Convex
CLI version, exact schema digest, export time, file-storage inclusion, and the
redacted command form beside the backup.

The native export is the exact deployment-recovery artifact. A future portable
or curated export has a different purpose and must state any omitted tables,
credentials, vectors, or derived data. Sequential live queries are not a
replacement for a consistent native snapshot.

## Prepare an isolated restore target

Restore only into a new disposable local backend. The tested boundary uses the
official pinned macOS arm64 Convex backend with:

- new empty database, storage, home, and working directories with mode `0700`;
- a fresh local instance secret and admin credential;
- an explicit `127.0.0.1` interface for both backend listeners;
- outbound networking denied by the operating-system sandbox and telemetry
  disabled;
- the exact reviewed schema closure plus a bounded internal read-only verifier;
- no public functions, HTTP routes, actions, auth-provider configuration,
  environment secrets, cron registrations, worker, or external processor.

Do not deploy `packages/convex/convex` to the restore target. Convex bundles
modules reachable from its function directory, so the ordinary application
tree can include executable HTTP, auth, cron, and worker surfaces even when the
operator intends to load only a schema. Build the drill from a separate
allowlisted directory and inspect its generated module manifest before import.

The currently tested backend start procedure passes its instance secret to the
backend process as a required command argument. Keep the full command and
process diagnostics private. The repository does not yet provide a portable,
turnkey isolated-backend launcher. Linux and Windows isolation have not been
accepted for this drill.

Before import, verify the backend process has only the expected loopback
listeners and that a direct outbound connection attempt fails with an
authorization error. Repeat both checks after loading the verifier.

The rehearsed target is an unmanaged self-hosted backend. Run the pinned Convex
CLI from its isolated working directory. Select the target only through a
protected `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`; do not
pass `--deployment`, which selects a registered Convex deployment instead.
Load the admin key into the process environment through the protected drill
harness or credential store, without placing it in the command or transcript.
Require an exact expected loopback URL before every CLI call:

```sh
cd /protected/isolated-restore &&
test "${CONVEX_SELF_HOSTED_URL:-}" = "${EXPECTED_RESTORE_URL:?}" &&
test -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" &&
test -f "${CONVEX_CLI_JS:?}" &&
node "$CONVEX_CLI_JS" function-spec
```

`CONVEX_CLI_JS` is the absolute path to the pinned installed Convex CLI entry
point. `EXPECTED_RESTORE_URL` must be the exact `http://127.0.0.1:PORT` URL
chosen by the isolated harness. Inspect the returned specification and require
an empty public function list. Also inspect the target directly for HTTP
routes, auth providers, actions, crons, and scheduled work. An empty function
list alone does not prove those surfaces are absent.

## Import and compare

Import with replacement semantics only after proving that the target is the
new disposable backend. `--replace-all` deletes data and tables not represented
by the snapshot or target schema. Never point this command at development,
production, or another existing deployment.

```sh
cd /protected/isolated-restore &&
test "${CONVEX_SELF_HOSTED_URL:-}" = "${EXPECTED_RESTORE_URL:?}" &&
test -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" &&
test -f "${CONVEX_CLI_JS:?}" &&
node "$CONVEX_CLI_JS" import --replace-all --yes /protected/new-snapshot.zip &&
node "$CONVEX_CLI_JS" export --include-file-storage --path /protected/restored-snapshot.zip
```

Do not compare ZIP bytes. Container ordering and compression may differ.
Decode both native snapshots with a bounded offline verifier and require:

- identical table membership and row counts;
- identical canonical values for every row, including `_id`, `_creationTime`,
  integers, byte values, references, vectors, and generated type sidecars;
- identical file-storage membership, byte lengths, content hashes, and
  metadata;
- the expected schema, validators, and indexes; and
- no unexplained target-only system or scheduled work.

The comparison report should contain only counts, digests, fixed diagnostic
codes, tool versions, and times. Keep decoded rows, source names, citations,
archive references, and credentials private.

## Verify the document graph

Exact row equality proves transport fidelity. It does not prove that the
restored graph can support document Q&A. Run bounded read-only checks for the
selected synthetic source:

- every source account, item, revision, parser artifact, text version, page,
  evidence span, generation, document, chunk, work row, job, archive receipt,
  and assessment resolves to its exact parent in the same space and source;
- current and desired source pointers resolve to the expected revision and
  processing generation, and only one terminal generation is active;
- every evidence span uses a valid UTF-16 boundary and slices its restored page
  text to the expected quote hash;
- document and chunk evidence references resolve, text hashes match, and the
  activated payload's page, evidence, document, and chunk counts and mapping
  manifest agree;
- historical corrections retain their order and hosted citations select only
  the active generation;
- gaps, unavailable observations, failures, assessments, revocations, and
  forget tombstones retain their exact states; and
- a forgotten item remains hidden and protected from automatic reimport.

If embedding rows exist, compare their target identities, profile
fingerprints, dimensions, and canonical vector digests. This does not establish
semantic readiness by itself. If the snapshot has no compatible active
embedding generation, report semantic search as unavailable until a separate
bounded rebuild and activation succeeds.

## Restore external archives and worker state

Restore the protected worker configuration, journal, and archive catalog from
their separate backup. The catalog must reopen under the exact full endpoint,
space, and source authority and preserve the original archive mapping plus all
processing-correction rows after transient checkpoints have cleared.

For each original and parser-artifact copy, match the hosted receipt to the
catalog's client receipt, archive object UUID, copy role, ciphertext digest and
length, archive/recipient/repository/storage-domain fingerprints, and immutable
plaintext identity. Read ciphertext back from the named destination. Then
decrypt it independently and recompute the plaintext SHA-256 and byte length.
An age or restic command returning success is not proof of restored content.

Exercise wrong-key, tampered-object, missing-primary, and missing-backup cases
as distinct failures. Restore the independent copy while the source capture and
primary archive are unavailable. Two directories on one device can verify copy
mechanics, but they do not establish an independent physical failure domain.
The owner backup destination and key escrow require a recovery drill that
survives loss of the source machine or primary device.

The first PDF trial uses the pinned macOS tooling described in the
[PDF pipeline guide](pdf-pipeline-development.md): age v1.3.2, restic v0.19.1,
the pinned Python runtime, and the locked parser models. Preserve deletion and
repair history, and apply the documented backup-retention limit when verifying
forgotten objects.

## Service resumption is separate

The isolated restore drill ends with the backend stopped and the application
surfaces absent. It does not authorize exposing the target or resuming service.
A separate reviewed resumption procedure must rotate or revoke restored
credentials, quarantine or reconcile active leases and pending work, restore
only the intended auth configuration and functions, recheck forget and
revocation fences, and explicitly activate the destination.

Keep the original snapshot unchanged until the recovery result and retention
decision have been reviewed. Never use a successful native import as evidence
that encrypted originals, citations, embeddings, worker replay, or physical
forget completed.

## References

- [Convex backup and restore](https://docs.convex.dev/database/backup-restore)
- [Convex data export](https://docs.convex.dev/database/import-export/export)
- [Convex data import](https://docs.convex.dev/database/import-export/import)
- [Original-byte contract](plans/2026-09-07-original-byte-contract.md)
- [PDF document-Q&A pipeline](pdf-pipeline-development.md)
- [Filesystem worker](filesystem-worker.md)
