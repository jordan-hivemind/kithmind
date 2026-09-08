# Provider original reference contract

**Status:** First-binding implementation and development lifecycle checks are complete.
Release checks and owner admission remain pending. Replacement-machine registry
bootstrap and reference refresh are separate follow-ups.

## Decision

PDFs that already exist in Dropbox use a distinct `provider_original_v1`
reference. Kith Mind does not upload a second original to Kith Mind Backups and
does not describe the Dropbox file as an age archive receipt.

The first supported recovery set has these members:

| Subject          | Required recovery member                                                      |
| ---------------- | ----------------------------------------------------------------------------- |
| Original PDF     | One Kith-owned local age object with role `primary`                           |
| Original PDF     | One verified Dropbox `provider_original_v1` reference                         |
| Parser output    | Existing Kith-owned age objects with roles `primary` and `independent_backup` |
| Provider locator | An age-encrypted locator manifest in the Kith-created metadata backup         |

The provider reference is evidence that exact bytes existed at a verified time.
It is not a promise that Dropbox will retain those bytes forever. The encrypted
locator manifest preserves the information needed after loss of the original
laptop. Registry bootstrap tooling is a follow-up. The manifest is Kith-created
metadata and contains no PDF bytes.

The legacy four-receipt path remains valid and byte compatible. New Dropbox
admissions cannot create an `original_bytes:independent_backup` receipt.

## Security boundary

The provider verifier receives the exact captured PDF path, its expected
SHA-256 and byte length, a protected source-relative locator, pinned rclone
configuration, and expected account and root identities. It must:

1. stable-read the local PDF and compute SHA-256 and the official Dropbox block
   content hash;
2. use a pinned read-only rclone stat to refresh the scoped token, then call the
   fixed official Dropbox `users/get_current_account` and `files/get_metadata`
   endpoints in memory with bounded responses and no token logging;
3. require the configured account ID and root directory ID;
4. require one exact file ID, revision, byte length, and Dropbox content hash;
5. compare the provider content hash with the locally computed Dropbox block
   hash and compare the local SHA-256 and length with the current discovery
   work;
6. stable-read or restat the local source after hashing so a concurrent change
   cannot cross the verification boundary; and
7. return verified metadata and a local-only raw locator binding.

The Dropbox content hash follows the
[official block-hash algorithm](https://www.dropbox.com/developers/reference/content-hash).
It is not relabeled as ordinary SHA-256. Account, root, file, revision, size, or
content substitution fails closed. Filename, folder position, modification
time, and page content are not identity authorities.

Verification output is valid for admission from ten minutes before server time
through five minutes after server time. The server applies the same bound to
the locator readback time. Older assertions require a new verification. A
future timestamp beyond the clock allowance is invalid.

## Public declaration

The worker protocol adds this closed declaration:

```ts
type ProviderOriginalDeclaration = {
  referenceVersion: "provider_original_v1";
  providerKind: "dropbox_v1";
  clientReferenceId: string; // UUID
  sourceContentHash: string; // lowercase SHA-256
  sourceByteLength: number;
  providerAccountIdHash: string; // SHA-256 of exact Dropbox account ID
  providerRootDirectoryIdHash: string; // SHA-256 of exact root ID
  providerFileIdHash: string; // SHA-256 of exact file ID
  providerRevision: string; // 1..128 printable ASCII characters
  providerContentHash: string; // lowercase Dropbox block hash
  verifiedAt: number;
  locatorBundle: {
    bindingId: string; // UUID, not a Dropbox identifier
    manifestFingerprint: string; // SHA-256 of canonical plaintext manifest
    recipientFingerprint: string;
    repositoryKeyDomainFingerprint: string;
    repositoryId: string; // restic repository ID
    snapshotId: string; // exact restic snapshot ID
    objectName: string; // bounded Kith-generated opaque name
    ciphertextHash: string;
    ciphertextByteLength: number;
    readbackVerifiedAt: number;
  };
  createdAt: number;
};
```

All digests are 64 lowercase hexadecimal characters. Byte lengths are safe
integers. The locator ciphertext is limited to 1 MiB. `objectName` is 1 to 128
ASCII letters, digits, dots, underscores, or hyphens and cannot contain path
separators or dot segments.

The declaration repeats `sourceContentHash` and `sourceByteLength`. The server
compares them with the current discovery work and the exact archived binary
revision. It does not infer that the provider verifier used the right bytes.

The hosted declaration and local archive catalog contain no Dropbox path,
token, account ID, root ID, or file ID. They contain hashes of provider IDs and
the exact bounded provider revision. Public and synthetic fixtures use invented
values only.

## Protected locator recovery

The verifier returns a local-only record containing `bindingId`, raw provider
account, root and file IDs, exact revision, and normalized relative locator.
The pipeline writes it atomically to a mode `0600` registry beneath a mode
`0700` configured directory. The archive catalog stores only `bindingId`, the
manifest and provider identity digests, and locator backup facts.

Before cloud admission, the pipeline creates a canonical immutable
`provider_locator_manifest_v1` for that binding, age-encrypts it, writes it to
the Kith-created metadata repository, and performs a separate-process restic
readback. The declaration binds the plaintext manifest fingerprint, age
recipient, restic key domain, repository, snapshot, object name, ciphertext
hash, ciphertext length, and readback time.

The initial release records the repository, snapshot, object, ciphertext, and
manifest identities in the encrypted native database snapshot and verifies that
snapshot can be restored. It does not yet bootstrap a lost machine's provider
registry from those artifacts. Follow-up P2-30 adds a runnable command to restore
the exact locator ciphertext, verify and decrypt it, recreate the protected
registry, hash every raw provider ID against the restored reference, and
revalidate Dropbox metadata and bytes. Unknown, moved, changed, ambiguous, or
unavailable objects require review. Path lookup alone cannot establish identity.

## Hosted persistence

Add `sourceProviderOriginalReferences` with immutable parent and identity
fields:

- space, source account, source item, and source revision IDs;
- client reference ID and request digest;
- the exact public declaration fields;
- fixed verification authority `worker_asserted`;
- actor user and credential IDs; and
- creation time.

Indexes enforce bounded lookup by source account plus client reference ID and
by source revision plus provider-reference fingerprint. The fingerprint uses a
new `provider-original-reference:v1` domain over a canonical ordered array of
all provider, source, verification, and locator bundle fields.

Add `sourceProviderOriginalBindings`, unique for a source revision, with the
current reference ID, binding epoch, verification time, actor, and update time.
A refresh may advance the binding only when account, root, file, revision,
provider content hash, source SHA-256, and byte length are identical. A new
locator bundle and a newer verification time are allowed. Any identity change
requires review. Changed source bytes follow the normal new-revision path.

Each admitted generation records its exact
`originalProviderReferenceId` and `originalProviderBindingEpoch`. Those fields
are mutually exclusive with `originalBackupReceiptId`. Existing generations
remain unchanged.

## Protocol and admission

`discovery.admitArchived` retains its exact legacy request. A second closed
branch has:

- exactly three archive selections:
  `original_bytes:primary`, `parser_output:primary`, and
  `parser_output:independent_backup`; and
- one required `providerOriginal: ProviderOriginalDeclaration`.

The branches cannot mix. The provider branch rejects an original independent
archive selection. The server creates or resolves the original primary receipt
and parser pair using their existing validators, creates the immutable provider
reference, binds it to the exact source revision, and verifies all timestamps
against the mutation time.

The legacy `archive-set:v1` preimage is unchanged. Provider generations retain
the historical `archiveSetDigest` column for compatibility but use the new
domain `recovery-set:provider-original:v1` over this ordered set:

1. original primary receipt ID and binding epoch;
2. provider original reference ID and binding epoch; and
3. parser primary and backup receipt IDs and binding epochs.

The domain prevents a provider reference from being interpreted as an archive
receipt. The provider reference does not change the parser, extraction,
processing, normalized-text, citation, or chunk fingerprints.

Admission results, original lookup results, operation receipts, processing
generations, assessment, and MCP validators use an exact mutually exclusive
union:

| Legacy branch                               | Provider branch                                 |
| ------------------------------------------- | ----------------------------------------------- |
| `originalBackupReceiptId` and binding epoch | `originalProviderReferenceId` and binding epoch |
| No provider reference fields                | No original backup receipt fields               |

Both branches require the original primary receipt and both parser receipts.
Operation request digests continue hashing the entire closed request. Existing
request and result shapes, request digest domains, and stored replay rows remain
unchanged. New optional database fields are interpreted only through the closed
union. Mixed or incomplete rows fail closed.

An immutable operation receipt stores the selected provider reference ID and
binding epoch so a lost response replays the exact result. Replay revalidates
the stored generation branch and identity. It does not require the original
verification timestamp to remain fresh after a successful admission.

## Generation and availability semantics

The generation records the provider reference used when it was admitted. A
later identical-identity verification may advance the current binding without
rewriting or reprocessing that generation. The active generation remains
cryptographically tied to its admission-time recovery set. A changed provider
identity does not automatically replace it.

Hosted document and assessment reads expose a bounded summary:

```ts
type OriginalRecoveryStatus =
  | { kind: "archive_pair_v1"; primary: boolean; independentBackup: boolean }
  | {
      kind: "provider_original_v1";
      localPrimaryArchived: boolean;
      providerVerification: "verified_at_admission" | "audit_unavailable";
      verifiedAt: number;
      continuousAvailability: false;
      desktopRecoveryRequired: true;
    };
```

Normal reads do not return provider identifiers, revision, locator bundle
coordinates, archive identities, or credentials. A later audit may append a
new immutable reference and advance the current binding when identity is
unchanged. Until such an audit exists, status states only the admission-time
verification. Provider deletion, version expiry, access revocation, or account
loss can make the provider original unavailable without invalidating hosted
text and citations.

The initial runner does not create a refreshed reference. It fails closed when
admission freshness expires or stored verification or locator identity differs.
Automated same-identity refresh and historical locator reconciliation are
follow-up P2-31.

## Forget contract

Beginning forget continues to hide source links and hosted content immediately.
Archive deletion targets contain only the three Kith-owned archive receipts.
The provider original reference is never an archive deletion target and never
receives `worker_asserted_physical_absence` or
`worker_asserted_live_repository_absence`.

Add a separate `providerOriginal.ackDetach` operation for the locator metadata.
It binds source item, forget epoch, provider reference, binding ID, locator
repository, snapshot and object, request ID, and exact outcomes. Its result is:

```ts
{
  operation: "providerOriginal.ackDetach";
  referenceOutcome: "detached" | "already_detached";
  locatorBundleOutcome: "deleted" | "already_missing";
  locatorAbsenceAuthority: "worker_asserted_live_repository_absence";
  retentionDisclosure: "provider_retained_deleted_history_possible";
  providerSourceOutcome: "retained_unchanged";
  completedAt: number;
  reused: boolean;
}
```

The authority applies only to the Kith-created locator bundle in the live
restic repository. It says nothing about the Dropbox original. The worker
removes its local raw locator binding, forgets the exact locator snapshot,
verifies live-repository absence, and records the result durably before sending
the acknowledgement. It never invokes a Dropbox delete operation and need not
read the provider original during forget. `retained_unchanged` means that Kith
issued no source write or delete. It does not assert that Dropbox or the owner
made no independent change during the forget operation.

Owner finalization requires the three archive acknowledgements and the provider
detach acknowledgement, then deletes hosted provider reference and binding
metadata in dependency order. The final worker result explicitly reports
`provider_original_reference_detached_source_retained`. Dropbox deleted history
and version retention are outside this assertion.

## Code changes

| Area                 | Required changes                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared protocol      | Add the provider declaration and exact legacy/provider admission and result unions in `packages/worker-protocol/src/index.ts` and `packages/convex/convex/models/workers/protocol.ts`.                                                        |
| Provenance schema    | Add provider reference and binding validators, tables, indexes, immutable identity helpers, and bounded legacy audit coverage under `packages/convex/convex/models/provenance/`.                                                              |
| Admission            | Extend `archivedDiscovery.ts`, binary operation receipt fields, `ingestion/archived.ts`, generation validators, lookup, replay, and chain validation with the exact union.                                                                    |
| Reads and assessment | Extend worker assessment and document/MCP result validators with the non-secret availability summary.                                                                                                                                         |
| Forget               | Add provider detach request, durable acknowledgement, target enumeration, cleanup dependency, and retained-source outcome. Preserve existing archive deletion acknowledgements.                                                               |
| Pipeline transport   | Parse both exact admission result branches and the provider detach result. Reject mixed fields and returned identity changes.                                                                                                                 |
| Pipeline state       | Add a protected raw-locator registry, provider verifier integration, locator manifest encryption/backup, catalog union, runner transitions, replay, recovery, and forget handling. These changes are owned separately from the backend slice. |

## Compatibility

- All new hosted columns are optional at the schema level and mandatory only
  in the provider branch.
- Existing archive receipts, bindings, generations, operation receipts,
  catalogs, journals, request digests, response bodies, assessment results, and
  physical forget acknowledgements retain their old exact forms.
- Legacy parsing never infers a provider reference from a URI, Dropbox path,
  archive fingerprint, or missing backup receipt.
- No migration creates provider references for existing rows. A supervised
  verifier and fresh provider admission are required.
- A provider reference cannot count as an archive receipt and cannot be used by
  generic archive deletion code.

## Verification

Current synthetic checks cover the initial binding. Items 8 and 10 are explicit
follow-up acceptance requirements, not completed release claims:

1. exact request bounds and rejection of mixed three/four archive sets;
2. stale and future verification times;
3. wrong account, root, file, revision, provider hash, SHA-256, or length;
4. locator bundle missing, unreadable, wrong snapshot/object, wrong plaintext
   fingerprint, wrong ciphertext, or stale readback;
5. immutable replay, lost responses, request ID reuse, and changed declarations;
6. legacy request digest and response byte compatibility;
7. generation, lookup, assessment, read, migration, and cleanup handling for
   both exact branches;
8. follow-up P2-31: same-identity provider refresh without processing identity
   changes and cleanup of every historical locator;
9. changed provider identity requiring review;
10. follow-up P2-30: registry bootstrap in an isolated directory using only
    restored credentials, native snapshot references, and encrypted locators;
11. immediate hosted hiding and exact locator metadata deletion while the
    Dropbox source remains byte-for-byte unchanged; and
12. assertions that no original PDF path, bytes, token, raw provider ID, or
    owner data enters Git, logs, hosted references, archive receipts, or Kith
    Mind Backups.

The owner trial must verify known originals through official Dropbox metadata
and the local block-hash algorithm before admission. It must record zero PDF
uploads and zero Dropbox delete calls. Provider availability after the
verification time remains an explicit limitation, not an archival guarantee.

## Development verification

The initial provider branch passed hosted admission, staging, activation and
replay with three synthetic Unicode pages. Search and document reads returned
exact page citations and admission-time provider recovery status. A schema-only,
network-isolated native restore preserved 143 entries and 333 rows including the
table inventory. Provider identity, locator coordinates, immutable fingerprints,
and exactly three archive receipts were verified after restoration.

Scoped synthetic forget acknowledged three Kith archive targets and one provider
locator, replayed the acknowledgements, removed the hosted graph, revoked the
test credential and disabled the source. The provider outcome means Kith issued
no write or delete to the source. Remote live absence does not prove that Dropbox
has erased retained history. No owner PDF was admitted by these synthetic checks.
