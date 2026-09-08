# Shared archive relocation

Status: P2-38 implementation in progress. The tested components below do not
yet provide an owner relocation command. No live move or deletion has occurred.

## Implemented foundation

- Configuration validation permits only a remote repository root-path change.
  It preserves the worker authority, credentials, watched roots, and all other
  normalized settings.
- The archive catalog can retain an append-only mapping for one exact old/new
  boundary and its complete still-live snapshot/object inventory. Historical
  receipts remain unchanged. Lost-response recovery accepts only the listed
  ciphertext identities; chains and unrelated boundaries remain conflicts.
- An injected relocation workflow persists a verified inventory before its
  move intent, recovers uncertain outcomes by stable identity, and requires
  identical post-move inventory before invoking rebind and scan gates.

The Dropbox adapter and paired journal/config rebind APIs are implemented. The adapter binds both move endpoints to stable folder IDs and checks
the account, parent, name, and resulting path. A separate account-bound root
marker represents the top-level parent; the adapter does not enumerate that
root. The move disables automatic renaming and ownership transfer.

The rebind intent retains exact config bytes, paths, catalog mapping/revision,
and old/new journal state hashes. It requires a current credential and idle
journal under the existing locks. Recovery accepts either half-written pair
only when those identities still match. The journal changes its heartbeat
identity and invalidates its prior in-memory instance; callers must use the
returned journal and reopen its catalog. The recovery tests use a real local
catalog but synthetic artifacts, not owner backup data.

A protected workflow session now holds the existing journal locks through the
move and journal transfer. Its bounded state file records exact prior-file
hashes and validates complete workflow state before recovering a prepared
transition. It rejects conflicting files, unsafe paths, and closed journals.
The whole Dropbox root and the processing repository leaf have separate
identities; the session verifies the leaf's exact relative suffix under both
root paths before applying the persisted catalog mapping.

The ciphertext restore helper reads one exact restic snapshot/object without
a cache, checks stream and on-disk hashes, and publishes a protected file
without overwriting an existing destination. It does not decrypt the object
or validate its application contents. A process death can leave its random
temporary file, so this helper alone is not resumable restore orchestration.
The owner command must record and account for those outputs before retrying.

The recipe validator now binds both repositories, exact configuration bytes,
retained database receipts, and the complete live processing inventory read
under the held catalog and journal. It derives separate workflow, catalog, and
owner watcher-reset IDs. Preparation validates the original state; resume
parsing validates the immutable recipe without requiring that original state
to remain current after a successful rebind. Historical receipt claims do not
count as fresh recovery verification.

An owner-only age recovery helper verifies ciphertext and plaintext hashes.
It sends the protected native age identity through standard input and writes
plaintext into an exclusive protected file. A separate native Convex restore
verifier stages a hash-pinned backend, deploys only the schema, blocks backend
outbound connections, checks loopback listener ownership, and compares the
restored native export with the source. It does not deploy application
functions, authentication configuration, HTTP routes, or cron definitions.

The workflow still requires an owner command connecting all components,
protected recipe persistence, and fresh provider readback wired into the
decryption and database-restore gates. Its synthetic tests do not establish Dropbox identity
preservation or authorize skipping those gates. The current
component limits are 2,048 inventory objects and 64 MiB per ciphertext object.
Larger migrations require a separately tested limit change before preparation.
The database repository has retained snapshots whose object paths are absolute
paths within the snapshot. Preserve those exact receipt paths through a
separate validated recovery interface. Do not weaken the processing-object
name validator or reinterpret the snapshot path as a local output path.

The owner command must also select an OAuth refresh path outside the moved
root and verify that the old heartbeat stops before resuming the new one.

## Purpose

The existing processing and database backup repositories are under a legacy
Dropbox root. The proposed shared archive layout places them beneath the
managed root:

```text
Kith Mind/
  archive-layout.v1.json
  archive/
  backups/
    processing-artifacts/restic-v1/
    database/restic-v1/
  Inbox/
```

`Inbox` remains a narrow watched input. It is not an archive output and this
relocation does not delete, move, or duplicate its curated provider originals.
Verified existing Dropbox originals remain the authority for those bytes. The
processing and database repositories contain Kith-created ciphertext and
metadata, not a replacement copy of every original PDF.

The required outcome is a physical root relocation that preserves existing
repository, snapshot, object, and Dropbox directory identities. The historical
catalog and database receipts remain valid. This is different from creating a
new repository and copying its contents.

## Current boundary

Current pipeline configuration and archive catalog records bind a remote
repository to more than a display path. They retain the repository identity,
Dropbox leaf identity hash, configured root path, tool versions, config
fingerprint, snapshot identity, and object identity. Provider-original
references also bind the recovery repository, snapshot, and object. They do
not expose a Dropbox source path or raw provider identifier.

Changing only the configured remote root path currently changes the journal
binding. Existing recovery also requires the recovered remote boundary to
equal the stored boundary. There is no supported command that relocates a
repository or rebinds a journal to a relocated root. A credential rebind is
not a repository relocation.

The database backup recipe has the same practical boundary: retained receipts
refer to an exact repository and snapshot. It must be updated through a
recorded migration, not by treating a new folder as equivalent.

## Preferred migration

Use one Dropbox metadata move of the complete legacy backup root to
`Kith Mind/backups`. The move must preserve the existing repositories rather
than initialize new ones. Before owner use, a synthetic Dropbox folder move
must prove that a metadata move preserves descendant directory identities.

The real move then accepts only if all of the following retain their identities:

- each relocated repository and its Dropbox leaf directory;
- every catalog-referenced processing snapshot and object;
- every retained database snapshot and its receipt binding; and
- the encrypted provider-locator and parser-output recovery artifacts.

This whole-root move preserves the existing `database/restic-v1` repository
path. Normalizing it under an engine-specific directory would require another
verified relocation or new-repository migration and is explicitly deferred.

A new repository or a restic copy is a separate migration design. It changes
repository and potentially snapshot identities, so immutable provider history,
catalog records, and database receipts would require explicit replacement
mappings. This proposal does not authorize that path.

## Required owner-only state machine

Implement this workflow before any owner move. It is resumable and records an
append-only relocation receipt; it does not infer success from a folder listing.

| State                | Required work                                                                                                                                                                                                            | Failure or interruption behavior                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepare`            | Require the worker idle and quiescent, no pending journal request, current scoped credential, and an approved relocation request. Snapshot the configuration, journal, catalog boundaries, and database backup receipts. | Stop before any Dropbox change. Do not start a scan or alter the watched source.                                                                                               |
| `verify_source`      | Verify the source root, target parent, source directory identity, repository identities, and absence of the destination. Enumerate all referenced snapshots and objects.                                                 | A missing, changed, ambiguous, or occupied target stops for review. Never overwrite or merge folders.                                                                          |
| `move`               | Send one exact provider metadata move for the selected legacy root. Persist the request identity and expected source and destination directory identities before sending it.                                             | On an uncertain response, discover the source or destination only by the saved stable directory identity. Do not broad-search, create another destination, or retry as a copy. |
| `verify_destination` | Re-read the moved root and both repository leaves. Verify directory identities, repository identities, and every recorded snapshot identity against the pre-move receipt.                                                | Any mismatch remains blocked. Do not apply a rebind or resume the worker.                                                                                                      |
| `verify_recovery`    | Perform ciphertext and plaintext recovery checks described below.                                                                                                                                                        | Preserve the old configuration and all evidence. A failure does not justify a new repository or cleanup.                                                                       |
| `rebind`             | Apply a narrow local journal/config rebind that changes only the approved remote `rootPath`. Record the old and new physical boundary in the relocation receipt.                                                         | Reject every other config, binding, credential, repository, or leaf identity change.                                                                                           |
| `resume`             | Update the database backup recipe and receipt, run doctor, then perform one unchanged worker scan before resuming normal watch scheduling.                                                                               | An unexpected discovery, publication, or catalog mutation stops for review.                                                                                                    |

The command must have one owner-authorized entry point and protected local
state. It must not expose account IDs, repository IDs, raw provider IDs, keys,
or source paths in public output. It must not use Finder or another client that
cannot bind the move to the verified Dropbox directory identity.

## Relocation evidence and compatibility

The relocation receipt is append-only and records only safe identifiers and
fingerprints needed to prove continuity. It includes the relocation operation
ID, old and new root-path fingerprints, source and destination parent identity
fingerprints, unchanged repository and leaf identity fingerprints, catalog and
database receipt counts, snapshot/object fingerprint inventories, verification
times, and the approved rebind fingerprint.

It establishes a historical-boundary alias: a recovery record stored under the
legacy root may be recognized at the new root only when its repository,
snapshot, object, leaf identity, tool/version, and relocation receipt all
match. It does not rewrite historical catalog rows or loosen ordinary recovery
equality checks. Unknown paths, repository identities, snapshots, objects, or
relocation records remain conflicts.

The database recipe update produces its own receipt binding the old and new
root-path fingerprints to the unchanged database repository and snapshot
identities. Existing database receipts remain immutable and readable through
the historical-boundary alias.

The local rebind changes the watcher identity. Before restarting its heartbeat,
the owner command must call the existing owner-authenticated
`models/diagnostics/public:resetWatcher` mutation with the recorded old watcher,
the new watcher, and a stable request ID derived from the relocation recipe.
This is a compare-and-set operation. A different current watcher is a conflict,
and an interrupted call is retried with the same request. The worker credential
does not receive owner reset privileges. Resume is complete only after the old
worker has stopped and a heartbeat from the new watcher is accepted.

The command retains its journal locks through recovery and rebind. Doctor's
lock-contention warning is not, by itself, evidence that the worker is idle.
The command must distinguish its own held lock using the live journal handle
and verify the rebound state before the unchanged scan.

## Required verification

Before the move, retain a protected copy of the local configuration, journal,
catalog, and current database backup receipts. Reconcile the complete
catalog-referenced processing inventory with the repository inventory, and
separately reconcile every retained database receipt. Independently dump and
hash the ciphertext for every referenced processing object and every retained
database backup, retaining those hashes as the post-move byte-equality
baseline. Confirm that recovery credentials and the age identity are
independently recoverable.

After the metadata move and before rebind:

1. Verify the source and destination directory identities, repository IDs, leaf
   identities, and every retained snapshot ID exactly.
2. Read every catalog-referenced processing ciphertext without relying on a
   local cache, verify its hash equals the pre-move ciphertext baseline, and
   age-decrypt it to verify the expected plaintext hash. This covers
   parser-output and provider-locator artifacts.
3. Read every retained database-backup ciphertext, verify its hash equals the
   pre-move baseline, then restore the newest snapshot into an isolated
   environment.
4. Run the exact-schema restore checks for graph relationships, citations,
   authorization boundaries, historical state, and forgotten-state behavior.
5. Apply the root-path-only rebind, perform the owner watcher compare-and-set,
   run doctor, and complete one unchanged scan with no unexpected publication
   or catalog mutation. Verify the new watcher's heartbeat before declaring
   normal scheduling restored.

The checks establish continuity of Kith-created recovery artifacts. They do
not create a duplicate backup boundary for a curated provider original and do
not claim to erase Dropbox retained history.

## Acceptance tests

The implementation requires bounded synthetic tests before an owner move:

- a metadata move preserves a selected root and descendant directory
  identities, while a copy/new repository is rejected by this workflow;
- a destination collision, wrong source identity, changed target parent, or
  changed repository/leaf identity performs no move or rebind;
- interruption before and after the provider call resumes by stable directory
  ID and cannot create a second destination or overwrite data;
- a relocation record recognizes only the exact historical boundary alias and
  rejects a changed snapshot, object, repository, leaf, tool version, or
  non-root configuration field;
- processing and database ciphertext readback, age plaintext hashes, and an
  isolated native restore pass after the synthetic move; and
- the worker is rejected while active, and the post-rebind unchanged scan
  publishes nothing; and
- the watcher reset rejects a mismatched current identity, retries the same
  request after interruption, and cannot be invoked by a worker credential.

## Sequencing

P2-38 first defines and tests the owner-only relocation command, exact
historical-boundary alias, root-path-only rebind, and database recipe update.
It then receives an independent review. Only after those checks pass may the
owner schedule an idle-window move and run the verification sequence above.

Existing Inbox inputs, legacy receipts, provider references, and archive
catalog rows remain in place throughout preparation and verification. Their
retirement or deletion is a separate, explicitly authorized lifecycle task
after complete reference accounting. This design does not change P2-2's
remaining comparative retrieval, chunking, and embedding evaluation.
