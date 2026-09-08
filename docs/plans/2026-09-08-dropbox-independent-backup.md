# Dropbox backup and provider-original boundary

**Status:** Adopted P2-26 transport design. Provider-original admission is
tracked separately.

## Boundary

Dropbox has two different roles and they must use different contracts.

| Data | Dropbox role | Kith action |
| --- | --- | --- |
| Existing source PDF | Provider-owned original | Verify and reference the exact existing file. Do not upload or delete another copy. |
| Lossless parser output | Kith-created recovery data | Store an age-encrypted object in a dedicated restic repository through rclone. |
| Native database export | Kith-created recovery data | Reuse the same transport in the separately scoped native-export work. |

The current binary-admission contract requires two Kith-owned encrypted
archive receipts for original bytes. A Dropbox source file is not such a
receipt. The worker must not mint an age/restic receipt, snapshot ID, deletion
claim, or physical-failure-domain claim for a file that it did not archive.

## Provider-original contract

A later bounded schema and protocol change should add a distinct immutable
`provider_original_v1` reference. It binds:

- provider kind `dropbox_v1`;
- the configured account and source-root identity by non-secret hashes;
- opaque Dropbox file ID, exact revision, Dropbox content hash, and byte length;
- the worker-recomputed SHA-256 and byte length of the captured PDF; and
- verification time and verifier authority.

The verifier resolves the exact file under a protected dedicated rclone
credential, requires the expected account and root, obtains bounded metadata,
and verifies byte identity. Dropbox content hash uses Dropbox's block-hash
algorithm and is not relabeled as SHA-256. A supervised first-trial manifest
may record these facts before the cloud model exists, but it does not satisfy
the current second archive-receipt gate.

Forgetting a Kith source deletes Kith-owned local archives, remote processing
artifacts, and Kith metadata. It only detaches the provider-original reference.
It returns an explicit retained-source outcome and never deletes the owner's
Dropbox source file.

## Kith-created restic transport

Use restic's rclone backend directly for encrypted Kith-created artifacts. Do
not copy a mutable local restic repository and do not upload raw age objects
through an unrelated object protocol. The direct backend preserves restic's
snapshot, operation tag, host, repository ID, retry recovery, and ciphertext
`dump` readback.

The closed repository configuration contains the pinned rclone binary, a
protected dedicated config path and stable identity, native Dropbox remote name, a
conservative repository path, expected Dropbox leaf-directory ID hash, and
expected restic repository ID. The runtime:

1. rechecks the executable and credential file before each operation;
2. runs with a replacement environment containing only `LANG`, `LC_ALL`, and
   the exact `RCLONE_CONFIG` selector;
3. accepts only a dedicated `type = dropbox` remote with token and no alias,
   endpoint, impersonation, or namespace overrides;
4. lists the repository parent with bounded `lsjson --dirs-only --max-depth 1`,
   requires one exact direct leaf with a real Dropbox ID, and matches its hash;
5. invokes restic with pinned rclone, literal
   `serve restic --stdio --cache-objects=false`, and restic `--no-cache`;
6. matches the restic repository ID; and
7. performs ciphertext `dump` in a separate process after every write.

Legacy local repository configuration and catalog rows remain byte-for-byte
compatible. The stable config identity derives from the canonical config path,
remote name, and native Dropbox type. It excludes the mutable OAuth token.
The new remote boundary records canonical remote/path, hashed Dropbox leaf ID,
the stable credential config identity, repository ID, and pinned
restic/rclone versions without storing tokens.

Restic forget/prune proves absence from the live repository namespace. Dropbox
may retain deleted or versioned data. Remote deletion therefore uses
`worker_asserted_live_repository_absence` plus
`provider_retained_deleted_history_possible`; it never emits the legacy
physical-absence authority. Controlled restore and per-write remote readback
are sufficient for the first transport slice. A generic audit daemon is not
part of this change.

## Implementation split

P2-26 adds the reusable rclone/restic transport and fails closed when the
current runner reaches an original-byte independent backup. It can operate on
parser output after the provider-original admission branch removes that legacy
original backup step. P2-27 reuses it for dated native database
exports. Provider-backed originals require a separate receipt, admission, read,
and forget change; until that lands, current binary admission must retain its
existing two verified archive receipts or remain pending.

## Acceptance

- No source PDF already in Dropbox is uploaded to Kith Mind Backups.
- A provider reference cannot be interpreted as an archive receipt or deletion
  authority.
- Existing local configuration, fingerprints, catalog rows, replay, recovery,
  and physical-deletion behavior remain unchanged.
- Remote configuration rejects extra settings, unsafe selectors, wrong tool or
  stable credential identities, wrong directory identity, and wrong repository ID.
- Synthetic Kith-created data passes remote write, separate-process readback,
  crash recovery, restore, tamper detection, timeout, and exact live-namespace
  forget tests.
- Logs, arguments, catalog, cloud receipts, and Git contain no OAuth token,
  restic password, age private identity, Dropbox file ID, or owner data.
