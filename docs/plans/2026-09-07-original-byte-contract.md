# Original-byte and parsed-text contract

**Status:** Reviewed P2-9 design; implementation is in progress. Binary ingestion
is not enabled yet. Releases follow the standing pre-launch deployment policy;
owner document ingestion still requires the verification gates below.

## Purpose

Kith Mind must identify original file bytes separately from the text derived
from them. A PDF hash is the identity of the PDF bytes. It is not the identity
of OCR output, normalized page text, chunks, records, or citations.

This contract adds an archived-binary path while preserving the existing
inline UTF-8 path exactly. It reuses source revisions, source text versions,
pages, evidence spans, processing generations, documents, and chunks. It does
not add a second authoritative records store.

The first supported binary class is PDF. Other media types require their own
measured parser acceptance and explicit bounds. The proposed first archive
adapter encrypts primary and backup roles separately to two native age
post-quantum public recipients. Restic snapshots only the backup-role
ciphertext into a separately keyed repository. The selected tools are
[age v1.3.2](https://github.com/FiloSottile/age/releases/tag/v1.3.2) and
[restic v0.19.1](https://github.com/restic/restic/releases/tag/v0.19.1).
The macOS arm64 distributions passed their published digest and authenticity
checks: age Sigsum verification and the restic signed checksum list. Other
platforms require the same checks for their own distributions. Tool verification
does not establish archive restoration or worker integration.

This design extends the [Phase 2 document pipeline](2026-09-07-phase2-document-pipeline.md),
the [worker protocol](2026-09-07-worker-protocol.md), and the
[source-processing contract](2026-09-06-source-processing-contract.md).

## First release scope

The first release serves one owner and one explicitly configured source. It
reuses existing space and source authorization. Additional family workflows
and dedicated archive-maintenance or archive-restore credential roles are
deferred. Where this contract allows a dedicated role, the first release may
use the existing owner or administrator authority instead. Ordinary read and
ingest credentials retain their existing restrictions. The owner starts forget;
a currently authorized source worker may execute exact archive deletion and
acknowledge physical absence for that forget epoch. This narrow operation does
not grant source workers original-byte restore access.

The first trial preserves strict configuration binding for the worker journal.
Edited source files follow the normal correction workflow under the same
configuration. Changing parser or archive policy does not silently rebind
existing work: stop and recover with the original configuration before an
explicit transition. Automated processing-profile migration is deferred.

## Trust labels

| Value                           | Meaning                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server_verified_utf8`          | The cloud received the UTF-8 bytes and recomputed their SHA-256 digest and byte length. Existing inline revisions have this implied authority even though old rows do not store the label.                               |
| `worker_asserted`               | An authenticated worker read bytes that the cloud did not receive. The cloud checked the assertion against the discovery work, actor, lease, and epoch chain but did not independently hash the bytes.                   |
| `server_verified_retained_text` | The cloud received every normalized page, reconstructed the bounded retained text, and recomputed its digest, byte length, and UTF-16 length.                                                                            |
| `restore_recomputed`            | A later owner-authorized isolated restore decrypted an archived object and independently recomputed its plaintext digest and length. This is a new verification record. It never relabels the original worker assertion. |

An API must return the applicable label with a digest. A field named only
`contentHash` is insufficient once both trust paths exist.

## Revision representations

`sourceRevisions` remains the immutable identity of source bytes for one source
item. Its representation becomes an explicit closed branch.

| Representation      | Stored fields and validation                                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy inline UTF-8 | `representation` is absent on existing rows or is `inline_utf8_v1`. `inlineText` is required. `contentHash`, `byteLength`, and `mediaType` retain their current meaning. The server recomputes the UTF-8 digest and length on creation, replay, chain validation, inspection, and activation. Existing optional `archiveRef` behavior remains unchanged. |
| Archived binary     | `representation` is `archived_binary_v1`. `inlineText` and legacy `archiveRef` must be absent. `contentHash` is SHA-256 over the complete original bytes, `byteLength` is the original byte count, and `contentHashAuthority` is exactly `worker_asserted`. Two accepted original-byte archive receipts are required before admission can finish.        |

Making `inlineText` optional in the database validator is only a compatibility
mechanism. Every model helper must parse the closed representation branch.
Undefined means the legacy branch. No code may treat an empty string as binary
content or accept a row with fields from both branches.

The existing source-item and content-hash uniqueness rule still applies. A
request for the same source item and hash with a different representation is
an immutable conflict. This includes bytes that happen to be valid ASCII or
UTF-8. A PDF admitted as binary cannot later replay as inline text, and an
inline text revision cannot acquire binary meaning.

## Immutable parser and archive identities

The following objects separate the original, parser output, and archive
locations.

### Parser artifact

`sourceParserArtifacts` represents one lossless parser conversion of one
source revision. It contains:

- the source revision, source item, source account, space, and capture actor;
- a `parserFingerprint` covering the parser implementation, runtime,
  configuration, model assets, and lossless output format;
- a worker-asserted digest, byte length, and media type for the complete
  lossless parser output;
- a stable client artifact ID and creation time.

The lossless parser output remains in the encrypted archives. It is not stored
inline in Convex. The cloud stores its identity and the normalized pages and
locators needed for hosted evidence.

The key `(sourceRevisionId, parserFingerprint)` is immutable. An exact replay
must supply identical lossless output digest, length, media type, and actor
lineage. Different lossless output under the same parser fingerprint is
`immutable_conflict`. A nondeterministic converter must use an explicit new
parser correction fingerprint. It cannot silently overwrite an earlier
conversion.

The parser artifact does not contain normalized-page counts, mapping digests,
locator format, archive receipt IDs, or archive locations. Those can change
while the raw parser output remains reusable. Normalization and mapping belong
to the source text version. Physical archive history belongs to archive
receipts and bindings.

### Archive receipt

`sourceArtifactArchiveReceipts` records one immutable encrypted copy. A
receipt is for either `original_bytes` or `parser_output` and contains:

- source, space, source-item, and source-revision parents;
- parser-artifact parent when the subject is parser output;
- a journal-stable `clientReceiptId`;
- `receiptVersion`, `copyRole` of `primary` or `independent_backup`, and an
  `archiveProfileFingerprint`;
- a non-secret archive identity, encryption-recipient fingerprint,
  repository-key-domain fingerprint, storage-failure-domain fingerprint, and
  opaque object identity;
- plaintext SHA-256, byte length, media type, and `worker_asserted` authority;
- encrypted-object SHA-256 and byte length;
- creation time, destination readback time and method, and authenticated worker
  credential; and
- the server request digest used for exact replay.

The archive identity describes one configured archive authority. The opaque
object identity is never returned by normal document or search reads and is
not a bearer URL. Archive credentials, keys, paths, and expiring download URLs
must not be stored in the receipt.

Receipt uniqueness is enforced by source account and `clientReceiptId`, and
by subject, archive identity, and opaque object identity. An exact replay
returns the same receipt. Any changed field is `request_conflict` or
`immutable_conflict` and does not patch the receipt. Backend-specific snapshot
or object IDs are location-specific and are not global content identities.

Receipts are append-only history. `sourceArtifactArchiveBindings` selects the
current receipt for each subject and logical role of `primary` or
`independent_backup`. A binding contains the source and subject parents, role,
receipt ID, archive identity, safe binding epoch, update time, and authorized
actor. It can move only to an already verified receipt for the same plaintext
digest, length, media type, and artifact subject. The update supplies the exact
expected binding epoch. The backup binding must use an encryption-recipient
fingerprint, archive authority, repository-key domain, and physical storage
failure domain distinct from the primary.

Moving, copying, repairing, or rotating archive storage creates a new receipt
and advances the applicable binding. It never changes the source revision,
parser artifact, or historical receipt. A location-specific copy that produces
a new snapshot or object ID therefore preserves the original content identity.
Each processing generation records the exact four selected receipt IDs and an
archive-set digest used at admission. Later binding repair does not rewrite
that historical admission proof.

Current primary and independent-backup bindings are required for both the
original bytes and the lossless parser output in the first supported binary
admission. Failure to write or verify any selected copy leaves the item pending
or in an explicit archive gap. It does not create a binary source revision.

The routine capture worker receives two public age recipients and never either
private age identity. It encrypts primary-role bytes to recipient A and
backup-role bytes separately to recipient B. It may hold the bounded write
credential needed to place ciphertext and create the restic backup snapshot.
The restic repository has its own credential, separate from both age
identities. The worker can read back and hash ciphertext but cannot establish
that a private age identity is available or that decryption succeeds.

Repository credentials, private identities, and keys remain outside the
repository, worker config, journal, process arguments, cloud database, and
receipts. Only an isolated owner-authorized restore process receives one
private age identity and the matching storage access. Primary and backup roles
are restored separately with identity A and identity B. The adapter must prove
this key separation and independent-copy behavior with synthetic fixtures
before it is enabled for owner documents.

For the first local adapter, the restic destination is configured on a
separately mounted target intended to survive loss of the primary store. Setup
and each run compare the opened roots' device identities and refuse the
`independent_backup` label when `st_dev` matches. Unequal `st_dev` values pass
only this mechanical same-filesystem check. They do not prove distinct hardware
because separate filesystems, volumes, or partitions can share a device.

The receipt's non-secret storage-failure-domain fingerprint identifies the
owner-recorded destination. It is not derived from `st_dev` and is not itself
proof of hardware independence. Before owner ingestion, the owner records the
distinct destination and device identity, and P2-5 restores from the backup
with the original source and primary device unavailable. Distinct synthetic
directories on one device can test encryption, replay, and errors, but cannot
pass or claim the independent physical-failure-domain gate.

### Availability and restore verification

An immutable receipt proves what was written. It does not prove that an object
is still readable or decryptable. `sourceArtifactAvailability` records the
latest bounded ciphertext check for a receipt as `ciphertext_available`,
`unverified`, `missing`, or `ciphertext_integrity_failed`, with a safe check
epoch and time. Source status resolves the active binding and then reads that
receipt's availability. Availability updates never modify the receipt or
binding. They make no claim about private-key availability.

`sourceArtifactRestoreVerifications` records an isolated restore attempt. A
successful verification contains the receipt, revision, encrypted-object
digest result, recomputed plaintext digest and length, owner or dedicated
archive-restore actor, verification time, and `restore_recomputed` authority.
Wrong keys, unavailable identities, tampered ciphertext, missing objects, and
digest mismatches are distinct failed results. The restore workflow must
verify the primary and independent backup independently. An ingest-only worker
credential and an ordinary hosted-read grant cannot retrieve archive object
identities, decrypt originals, or create restore attestations.

Provider availability and archive availability remain separate facts. A
missing original path does not imply a missing archive. A missing archive does
not make hosted text disappear.

## Parsed text representation

`sourceTextVersions` remains the immutable identity of extracted text. Its
storage also becomes a closed branch.

| Representation     | Stored fields and validation                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy inline text | `representation` is absent on existing rows or is `inline_text_v1`. `text` remains required. Existing extraction fingerprint, UTF-8 digest, byte-length, replay, page, and activation checks remain unchanged.                                                                                                                                              |
| Parsed pages       | `representation` is `parsed_pages_v1`. `text` must be absent. `parserArtifactId` is required. The row declares `textHash`, UTF-8 byte length, UTF-16 length, page count, normalized mapping-manifest digest, and extraction fingerprint. Hash authority is absent until the server verifies all staged pages; sealing adds `server_verified_retained_text`. |

For `parsed_pages_v1`, retained text is defined as the direct concatenation of
page text in ordinal order. No implicit separator is inserted. Page `start`
and `end` are cumulative, page-relative source spans remain UTF-16 code-unit
offsets, and the final end equals the declared text UTF-16 length. During seal,
the server verifies:

- ordinals are unique and contiguous from zero;
- every page is in the same space and text version;
- each stored page digest matches its UTF-8 text;
- cumulative starts and ends exactly cover the concatenated text;
- the concatenated UTF-8 digest and byte length match the text version; and
- the page manifest matches the normalized text-version declaration.

The server also recomputes the bounded manifest of pages and locators that it
received. That proves the cloud rows match the admitted manifest. It does not
prove that the archived parser JSON contained those locators because the cloud
has not read that artifact. The parser-artifact-to-locator assertion remains
`worker_asserted`; exact hosted quote slicing is server verified.

The existing `extractionFingerprint` identifies the parser artifact,
normalizer implementation and configuration, mapping format, playbook, and
explicit correction inputs. It does not include the observed normalized text
hash. Therefore the same source revision and extraction fingerprint with a
different parser artifact, mapping, pages, or text is an immutable conflict. A
normalization or locator correction reuses an unchanged parser artifact, uses
a new extraction fingerprint, and creates a new text version and processing
generation.

The binary scan carries `extractionConfigurationFingerprint`, which can be
computed before conversion from the parser identity and normalization code and
configuration. The final artifact-bound `extractionFingerprint` is available
only after parsing. Admission recomputes it as SHA-256 of the UTF-8 domain
`kith-parsed-extraction:v1`, one NUL byte, and the compact JSON array
`[parserFingerprint, parserArtifactSha256, extractionConfigurationFingerprint]`.
All three entries are lowercase SHA-256 strings. This avoids requiring parser
output before the current-authority preflight. The other processing and
correction fingerprints remain part of the scan and generation identity.

Evidence spans continue to point to immutable `sourcePages` and use exact
page-relative UTF-16 offsets and quote hashes. The locator union gains a
bounded parser locator containing the parser artifact ID, source item or table
row reference, page number, and optional normalized bounding box or cell
coordinates. The server checks that its artifact, page, text version, revision,
source, and space parents agree. A parser box is only a locator. A cited field
must still resolve to the exact retained page slice.

### First-trial document mapping

The first-trial mapper emits one document per PDF. Its initial chunk policy
uses non-overlapping page-local chunks targeting 8 KiB, cuts only between
Unicode scalar values, and preserves the complete page concatenation. This is
a bounded starting policy, not a measured claim of optimal retrieval quality.
The chunking fingerprint identifies this policy. Repeated equal rows remain
separate evidence spans. Any parser mapping gap stops this first-trial path
for review instead of silently declaring the document fully processed.

Docling table segment IDs contain page-local table ordinals. They are not raw
JSON array indexes. Before mapping, the local validator resolves each text
item or table row against the exact raw parser artifact by reference,
provenance, cell contents and row position. The mapper uses the resolved raw
reference. It keeps raw item character spans as Python-codepoint metadata,
separate from the UTF-16 evidence offsets. Table cell hashes identify exact raw
cell text; quote hashes identify the normalized retained page slice.

The initial mapper omits optional cloud bounding boxes because four coordinates
alone would lose the raw coordinate-origin convention. Complete boxes remain
in the archived raw parser artifact. The protected raw parser output stays
available through durable activation so a restarted worker can revalidate the
normalized spool and resolve the same citations. Exact local cleanup follows
activation; a missing required raw output before then requires recovery.

Old pages, evidence spans, records, documents, and generations remain
addressable after correction. Cleanup must retain any immutable provenance
reachable from an active or historical published document or record until the
document's retention or forget policy authorizes deletion.

## Identity and correction rules

| Change                                                        | Required result                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original bytes unchanged, extraction corrected                | Reuse the source revision and original archive receipts. Create a new extraction fingerprint, immutable text version, pages, evidence, generation, documents, chunks, and records. Preserve the old generation and citations. |
| Parser implementation, model, or lossless output changes      | Create a new parser artifact. Reuse the source revision when the original byte digest is unchanged. Create a new text version and generation if retained output changes.                                                      |
| Normalization, locator mapping, chunking, or playbook changes | Reuse the parser artifact when its lossless output is unchanged. Create a new extraction fingerprint and the affected immutable derived objects.                                                                              |
| Archive object moved, copied, repaired, or re-encrypted       | Append a new location-specific receipt and advance an authorized role binding after verification. Preserve the source revision, parser artifact, prior receipts, text version, and generation.                                |
| Original byte digest changes                                  | Create a new source revision, new original archive receipts, parser artifact, text version, and generation.                                                                                                                   |
| Exact request replay                                          | Return the prior immutable IDs and result only when the complete validated request digest and lineage match.                                                                                                                  |
| Same request or immutable identity with different content     | Reject without writes. Do not mint a replacement ID or silently choose the later output.                                                                                                                                      |

Rechunking retained text does not require OCR or parser execution. It still
creates a new processing generation so publication can switch atomically.

## Bounded first implementation

The binary path has separate limits. It does not raise the limits on legacy
inline ingestion.

| Resource                                      |                                         Initial hard limit |
| --------------------------------------------- | ---------------------------------------------------------: |
| Original PDF bytes                            |                                                     16 MiB |
| Lossless parser artifact in encrypted archive |                                                     64 MiB |
| Normalized retained UTF-8 text                |                                                    256 KiB |
| Protected normalized staging bundle           |                                                      4 MiB |
| Retained pages                                |                                                         32 |
| UTF-8 text in one page                        |                                                     64 KiB |
| Serialized Convex size of one staged row      |                                                     96 KiB |
| Evidence spans                                |                                                        128 |
| Documents per generation                      |                                                         16 |
| Chunks per generation                         |                                                        128 |
| Chunk text across one generation              | Existing 256 KiB limit, with complete parsed-text coverage |
| Stage rows per request                        |                               25, with at most 8 page rows |
| Serialized worker request                     |                                                    128 KiB |
| Activation transaction hydrated data          |                                                      8 MiB |

The parsed path adds these actual serialized limits:

| Row kind                                                                      |                    Per-row limit | Per-generation subtotal |
| ----------------------------------------------------------------------------- | -------------------------------: | ----------------------: |
| Revision, parser artifact, receipt, binding, text version, generation, or job |                           16 KiB |        256 KiB combined |
| Sealed payload manifest                                                       |                           64 KiB |                  64 KiB |
| Page                                                                          |                           96 KiB |                 512 KiB |
| Evidence span                                                                 | 8 KiB, including a 4 KiB locator |                 512 KiB |
| Document                                                                      |                           16 KiB |                 256 KiB |
| Chunk                                                                         |                           24 KiB |                 768 KiB |
| Event version                                                                 |                           16 KiB |                 512 KiB |
| Observation                                                                   |                           16 KiB |                   1 MiB |

The sealed next-generation payload is at most 4 MiB by actual Convex
serialization, and the prior generation rows mutated during activation are at
most 1 MiB. A row must satisfy both its existing field limits and the new
serialized limit. A kind must satisfy its existing count limit and the
server-computed serialized-byte subtotal.

Every count and byte value is a safe nonnegative integer. The worker checks
raw files and parser output before archive or protocol work. The server checks
request size, UTF-8 length, row count, and actual serialized row and transaction
size. The implementation uses the installed Convex `getConvexSize` or
`getDocumentSize` helpers and retains margin below Convex's
[1 MiB document and 16 MiB transaction limits](https://docs.convex.dev/production/state/limits).
It must fail closed if size metrics are unavailable or malformed.

Parsed chunks additionally carry the source text version and UTF-16 `start`
and `end` range. Each chunk text must equal that exact retained-text slice.
Ordered chunk ranges must begin at zero, end at the retained-text length, and
have no gaps. Overlap is allowed only within the existing 256 KiB aggregate
chunk-text limit. A maximum-size 256 KiB text therefore uses complete,
nonoverlapping coverage. A generation that cannot preserve full keyword-search
coverage within these limits is an explicit gap and cannot activate.

At seal, the server inserts one immutable bounded
`processingGenerationPayloadManifest`. It contains sorted exact row IDs,
counts, per-kind serialized-byte totals, and content digests for pages,
evidence, documents, chunks, event versions, and observations. It is at most
64 KiB. Staging computes these values from accepted rows; it does not trust
worker-supplied totals.

Activation reads the generation and payload manifest first and rejects an
invalid count or subtotal before loading payload rows. It then point-reads the
exact IDs, checks transaction metrics before each read with at least 1 MiB of
headroom, and recomputes row sizes, subtotals, and digests. Legacy activation
uses bounded one-row reads with the same headroom rule. Unsupported or
malformed metrics fail closed. The transaction performs no publication writes
until all validation finishes.

The activation transaction reads every required page, span, document, chunk,
record, generation, revision, artifact, binding, and receipt needed for the
final proof. It rejects the generation before mutation when the 8 MiB
application hydration budget or a count limit is exceeded. The 8 MiB budget is
a conservative application bound, not a claim that every 8 MiB input fits
after serialization.

Oversized originals, parser output, normalized text, page sets, locator sets,
or activation graphs become explicit `oversized` or `needs_review` work. The
worker never truncates them, substitutes partial text, or marks processing
complete.

## Binary discovery representation

The existing ready filesystem discovery entry remains the legacy UTF-8
variant with its current 65,536-byte limit and validation. A new
`ready_binary_v1` variant carries the SHA-256 digest, byte length, media type,
and selected binary parser profile. It carries no text and initially accepts
only PDF bytes up to 16 MiB.

The binary profile includes the pre-parse configuration fingerprint described
above. It does not carry a final extraction fingerprint that depends on parser
output not yet produced.

The variant is included in the inventory metadata digest, processing identity
digest, scan entry, discovery work, processing job, and generation
fingerprint. Changing the variant or parser profile advances processing work
even when the byte digest is unchanged. An unsupported type or a file above
the binary limit is a visible discovery gap. It cannot fall back to
`admitUtf8` merely because its bytes decode as UTF-8.

## Worker phase and replay contract

Binary archive and parsing happen before a cloud processing lease is claimed.
This avoids spending a fixed five-minute lease on a bounded but potentially
long parser process. The worker flow is:

1. Complete a healthy source scan and persist the observed byte digest,
   length, modification time, observation epoch, and processing epoch.
2. Persist an archive intent containing stable artifact and receipt IDs, then
   open the bounded source once into a private worker-owned capture file or
   file descriptor. Hash that exact capture and verify it against the scan.
3. Archive the same capture under both original-byte roles before running the
   pinned parser. Persist the bounded normalized page bundle in a private
   staging spool. Encrypt the lossless parser output separately for both roles.
4. Immediately before each external object or restic snapshot commit, call a
   read-only current-authority preflight for the exact source, scan, work,
   observation epoch, processing epoch, and original actor. After each commit,
   read the ciphertext back from its destination and verify its exact digest
   and length. An archive command exit status alone is not a receipt.
5. Persist the four verified receipt envelopes and normalized bundle digest in
   the protected local catalog. Keep the private capture, raw parser output,
   and normalized bundle through durable activation. Recovery reopens these
   exact files to validate the bundle and resolve raw parser locators. The
   original source folder may be offline once these local artifacts exist.
6. Reserve the exact discovery work. The server requires the archive receipt
   hash and length to match the current scan and work. Parsing does not grant
   authority to admit stale work.
7. Persist an exact pending `discovery.admitArchived` request, then admit the
   revision, receipts and current bindings, parser artifact, unsealed text
   version, generation, and processing job atomically.
8. Reserve the processing job. Stage parsed pages and derived rows through a
   persisted phase machine. Renew the fixed five-minute lease before the safe
   margin when another batch is required.
9. Seal the parsed text after server recomputation, then atomically activate
   the generation using the existing publication boundary.
10. Record durable activation before exact local plaintext cleanup, then run a
    fresh processing assessment. Enumeration completion and processing
    completion remain separate.

The new protocol operations are separate discriminated union members:

- `discovery.preflightArchived` for the bounded current-authority read before
  an external archive commit;
- `discovery.lookupArchivedAdmission` for source-scoped recovery of canonical
  original identity or one exact committed processing admission;
- `discovery.admitArchived` for metadata-only binary admission;
- `jobs.stageParsedBegin` for the expected manifest and stage intent;
- `jobs.stageParsedBatch` for one typed, ordinal batch of pages, evidence,
  documents, chunks, or records; and
- `jobs.stageParsedSeal` for aggregate text and exact-count verification.

Existing `discovery.admitUtf8`, `jobs.stageUtf8`, their request and result
shapes, and their receipt semantics do not change.

Before any archive write, the journal stores stable object and receipt IDs.
Before any cloud mutation, it stores the exact request body. A crash after an
archive write and before cloud admission reopens and verifies the same objects,
reuses the same receipts and artifact identities, and replays the same request
ID. It does not mint a replacement ID. An exact pending cloud call can resume
without the original root mounted because the pending body contains only
bounded metadata or the sole bounded stage batch needed for that call. Raw
original bytes and full parser JSON never enter the journal or cloud request.

The normalized staging spool is a separate worker-owned bundle, not checkpoint
JSON. Retained text inside it is at most 256 KiB. The complete serialized
bundle is at most 4 MiB. It contains the parser's normalized pages and source
locators; the fixed mapper derives document, evidence, and chunk inputs from
that bundle and the validated raw parser output. The first trial emits no
record inputs. The spool is mode `0600` in an explicitly configured protected
directory. Its catalog identity binds the source, raw parser artifact,
extraction fingerprint, byte length, digest, and local file identity. Every
reopen repeats path, owner, mode, regular-file, size, and digest validation,
then validates the raw artifact and bundle together. Exact cleanup follows a
durable activation receipt, an explicit forget plan, or verified orphan
cleanup. The private capture and raw parser output remain available for the
same period. These local artifacts let admission and staging resume while the
original source folder is offline.

The preflight and external commit cannot be one transaction. A forget, source
change, actor revocation, or newer scan may race after preflight. That race may
create only a journaled orphan object. The later cloud admission rechecks the
full current chain and rejects it. Bounded local cleanup deletes every such
primary object and restic snapshot from its exact catalog receipt. Forget also
advances the cloud epoch. Once the worker observes that change, it stops
pending local work. A local commit racing with that observation is handled
as an orphan and never inferred as admitted content; the cloud rejects its
admission.

Journal-loss recovery is source scoped. The lookup has two closed modes. The
original mode accepts source item, current raw hash, and binary representation
and returns only the canonical original revision and current original-role
bindings after full source authorization. A correction can therefore reuse
unchanged originals without using the new extraction identity. The exact
processing mode additionally requires the complete current processing
identity and returns only its matching parser artifact, text version,
generation, receipt, and binding IDs. This mode recovers an admission whose
reply and journal were lost without matching another correction.

If the cloud did not commit, the protected local catalog resumes the exact
receipt and artifact IDs. If that catalog is also missing, ciphertext with no
admitted or cataloged identity is an orphan. The worker never infers ownership
by hash or performs a random re-encryption under an existing parser
fingerprint.

Every staged batch has request ID, operation, job ID, lease epoch and token,
stage phase, and ordinal. The server writes a pending phase receipt before the
first provenance row. Exact replay returns the committed result. Changed input
at the same request ID, phase, or ordinal fails. Partially staged immutable rows
may be reused only after their full parentage and content match. A conflicting
row sends the job to review. Lost replies never create another version.

When no call is pending, an expired or near-expiry lease must be renewed or the
job must return to reservation before another stage or activation call. When a
call is pending, the worker replays it exactly even if the recorded lease time
has elapsed because the server may already have committed its receipt. An
expired-lease error is consumed durably before a new reservation begins; the
worker then asks the server for the retained stage phase and ordinal. A saved
preflight success never substitutes for a fresh authority check immediately
before an external archive write.

The local catalog records the intended temporary ciphertext name before
encryption. If encryption finishes but its returned inode and digest are lost
before durable recording, that object remains untouched and requires review.
The name alone cannot authorize adoption or deletion.

## Mutation fences and activation

Every binary admission, initial receipt, stage, seal, renew, failure,
activation, binding, availability, restore, and deletion mutation validates
its complete applicable chain before writing. Processing mutations validate:

- authenticated worker credential and source grant;
- space, source account, source item, and current lifecycle;
- original capture actor and executing actor status;
- scan, entry, discovery work, observation epoch, processing epoch, and work
  lease where applicable;
- source revision, parser artifact, text version, generation, job, and all
  parent and back-reference IDs;
- current desired revision and desired processing epoch;
- processing fingerprint, exact manifest counts, and job lease; and
- archive receipt subjects, selected binding epochs and roles, archive
  identities, digests, and immutable request receipt.

Archive repair, binding, availability, restore, and deletion mutations validate
exact space, source-account, source-item, revision, artifact, receipt, role,
and digest parents before writing. A binding change requires an owner or
dedicated archive-maintenance actor, the exact current receipt and role, an
expected binding-epoch compare-and-swap, and an exact replay receipt. The next
epoch is monotonic. A stale repair cannot restore an older or missing receipt.
A routine ciphertext availability check requires an active worker credential
and source grant and binds the exact current receipt and role. A restore
attestation requires an owner, administrator, or dedicated archive-restore
grant and the exact current receipt and role. Deletion requires the exact
forget epoch, receipt, and opaque object identity. None of these roles uses a
processing lease as a substitute for its own authorization.

Revoked actors, stale work, cross-space parents, changed epochs, expired
nonpending leases, malformed counts, and representation confusion fail before
provenance writes. A revoked original actor cannot finish unpublished work.
Already published historical evidence remains readable under normal space
authorization. Actor replacement is an explicit owner recovery action and
cannot rewrite capture history.

Activation remains atomic. It verifies the sealed server-retained text, exact
payload manifest, every page and evidence slice, parser, binding, and receipt
parents, expected record and chunk counts, complete chunk coverage, and
serialized-size budget. Only then does it switch the source item's active
revision and generation and mark the previous generation historical. A failed
replacement leaves the previous active generation unchanged.

## Reads, availability, and forgetting

Document and search reads continue to use hosted normalized text, pages,
records, and evidence. They return a structured original summary with:

- representation;
- original digest, byte length, media type, and hash authority;
- whether current primary and independent bindings resolve to accepted
  receipts;
- latest bounded availability for each copy; and
- whether an authorized desktop restore is required to open original bytes.

Normal reads do not return archive object identities, credentials, keys, or
bearer URLs. Permission to read hosted text does not by itself grant permission
to retrieve original bytes. The hosted API exposes indexed text and exact citations for mobile clients.
Actual access from a native ChatGPT or Claude mobile app depends on that
provider and account supporting the configured connector. Mobile compatibility
is a later priority and does not gate the desktop trial. Original or parser
artifacts can require the authorized desktop worker.

Hosted document and search reads share a 256 KiB serialized citation budget
per response, including quote, locator, and citation-array overhead. They omit
whole citations when that budget is exhausted and report `partial`; search
results also report `citationsTruncated`. Returned quotes remain complete and
retain their exact hashes. Document page text remains available within the
existing page and text bounds.

If an original path or encrypted archive object becomes unavailable, the
status reports that fact without hiding a still-valid hosted generation.
Missing lossless parser JSON limits reprocessing and audit, but does not make a
previously verified text slice false. Coverage reports expose original,
archive, parser-artifact, and hosted-text availability separately.

Forget hides the source and hosted content through the existing immediate
forget boundary. The first trial uses the existing archive receipts as bounded
delete targets and an owner-operated local command. It adds no cloud deletion
job or new credential role. The command binds each durable deletion plan to
the source item, forget epoch, receipt and exact local archive identity. It
checks and removes the exact age object and, for the backup role, the exact
restic snapshot followed by prune and absence verification. Unknown or replaced
objects require review. Physical results are saved locally before the source
worker sends an idempotent cloud acknowledgement. That acknowledgement is
explicitly worker-asserted physical absence, not server verification.

Receipt metadata and opaque object identities remain restricted to the
authorized worker until its acknowledgement permits ordered cleanup. Cloud
cleanup must not erase the only deletion locator first. Accepted historical
acknowledgements remain evidence after their actor is revoked; new calls still
require current authorization. Backup retention outside the live restic
repository, filesystem snapshots and physical-media erasure are not established
by this command. The final tombstone retains only minimal non-content identity
and completion evidence needed to prevent unintended reimport.

## Compatibility and migration

No legacy content rewrite is required. Undefined revision and text-version
representations are interpreted as the legacy branches. Before deployment, a
bounded read-only audit must verify that every legacy revision has valid
inline UTF-8 content, matching digest and length, no binary-only fields, and
that every legacy text version still passes its current digest, page, evidence,
and generation checks. The audit also verifies that every active legacy
generation's document and chunk transition payload is within the 1 MiB prior
generation budget. A failure blocks the binary profile rather than rewriting
the legacy generation.

The initial foundation exposes `auditLegacyProvenance` as a read-only,
paginated diagnostic for representation shape, parent references and inline
hashes. Its result explicitly reports
`scope: representations_parents_inline_hashes_only` and
`binaryEnablementReady: false`. It does not yet inspect child pages, evidence,
generation payloads, or the prior-generation transition budget. Add those
bounded checks before using an audit to enable the binary profile. A successful
foundation diagnostic does not satisfy the full pre-enable audit above.

The migration adds optional fields and new tables and indexes. New helpers
must parse the closed branches and reject malformed mixed rows. Existing
capture, generic `admitSourceRevision`, `discovery.admitUtf8`, and
`jobs.stageUtf8` tests remain byte-for-byte behavior regressions. No migration
may add `archived_binary_v1` to an old row or infer binary authority from an
old `archiveRef`.

Deploy schema and protocol changes to development first. Run the legacy audit
before enabling the binary worker profile. A production audit and schema
deployment may follow the project's pre-launch deployment procedure, but the
binary profile remains disabled until archive restore and end-to-end fixture
verification pass.

## Implementation slices

| Slice                                   | Reviewable outcome                                                                                                                                                           | Completion evidence                                                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contract and audit                   | This contract plus a bounded representation/parent/hash diagnostic. Full payload audit remains required before binary enablement.                                            | Mixed or corrupt representations fail; valid legacy rows pass without writes.                                                                                  |
| 2. Provenance schema                    | Closed revision/text branches, raw parser artifacts, immutable receipts, mutable role bindings, payload manifests, availability, restore verifications, and bounded indexes. | Model tests cover exact replay, additive archive repair, immutable conflicts, parent isolation, and serialized sizes. This slice alone does not complete P2-9. |
| 3. Archive adapter and journal          | One selected encrypted archive implementation, independent backup, stable receipt intents, and bounded parser-artifact storage.                                              | Crash after archive write reuses IDs; tamper, wrong key, missing copy, and independent restore are distinct verified outcomes.                                 |
| 4. Binary admission                     | New worker discovery representation and `admitArchived` operation with full current-chain validation.                                                                        | Same-item/hash representation conflicts fail; stale, revoked, cross-space, changed-epoch, and changed-receipt requests make no writes.                         |
| 5. Parsed staging                       | Paged text staging, parser locators, exact receipts, aggregate seal, lease recovery, and atomic activation.                                                                  | Lost-response and partial-stage tests publish once; old publication survives failures; limit boundaries fail without truncation.                               |
| 6. Reads and lifecycle                  | Structured hash authority and availability, restricted retrieval, archive deletion work, and cleanup retention.                                                              | Hosted text and citations remain readable with originals offline; forget deletes cloud and archive content in the required order.                              |
| 7. Restore and development verification | Isolated primary and backup restore with recomputed plaintext identity, followed by the full synthetic lifecycle on development.                                             | Original hashes, parser artifacts, corrections, history, citations, permissions, counts, and tombstones match.                                                 |

## Required end-to-end cases

The development verification uses synthetic documents only and must cover:

1. Existing inline capture, `admitUtf8`, `stageUtf8`, replay, and activation
   with their current response shapes and hash checks.
2. Binary PDF admission with primary and backup receipts for the original and
   parser artifact, destination ciphertext readback, paged text, Unicode UTF-16
   evidence, full chunk coverage, and atomic publication.
3. Same-device primary and restic destinations that can exercise replay but
   cannot receive the independent-backup label, followed by an isolated restore
   from an owner-recorded distinct destination with the original source and
   primary device unavailable.
4. The same original bytes with corrected extraction, yielding the same source
   revision and new immutable text version and generation while old citations
   still resolve.
5. Same item and hash with a different representation, plus the same parser or
   extraction identity with changed JSON, mapping, or text. Each must reject
   without writes.
6. Archive relocation or repair that appends a receipt and advances a binding
   without changing the original revision, parser artifact, text version, or
   prior admission proof. Conflicting subject or digest repair makes no writes.
7. Crash during each archive role, after all archive writes and before cloud
   admission, lost admission reply, partial page staging, lease expiry between
   batches, and lost activation reply. Local replay uses the exact catalog;
   cloud-committed journal loss uses the source-scoped lookup. Unassociated
   ciphertext is cleaned as an orphan and is never inferred by hash.
8. Truncated, oversized, changed, wrong-mode, or wrong-owner normalized staging
   bundles fail before a cloud request. A valid near-4 MiB bundle reopens and
   reproduces the same bounded stage requests while the source root is offline.
9. Forget, source change, or actor revocation immediately before and after an
   external commit. The operation cancels or produces only a journaled orphan,
   and stale work cannot admit.
10. Revoked original or executing actors, cross-space IDs, stale scan/work/job
    leases, changed observation or processing epochs, and malformed parent
    chains. Each fails before provenance writes.
11. Maximum valid requests and one-over-limit original, parser artifact, page,
    text, span, row, request, and activation graph. Oversized work remains an
    explicit gap or review state.
12. Missing original path, missing primary archive, missing backup, and missing
    parser artifact while hosted text and citations remain readable and status
    reports ciphertext availability without claiming decryptability.
13. Ciphertext tampering, wrong key, unavailable private identity, successful
    primary restore, and successful
    independent-backup restore. Plaintext SHA-256 and length are recomputed and
    recorded separately from the original worker assertion. Ingest and ordinary
    read credentials cannot perform these operations.
14. Forget during pending archive, staging, and ready states. In-flight work
    stops, hosted reads disappear immediately, archive deletion remains
    retryable, and only the allowed tombstone survives.

The first bounded owner document-Q&A trial requires archive verification,
basic monitoring, source identity recovery, final portable export and isolated
restore against its exact schema, and measured citation acceptance. It publishes
no automatic structured observations and leaves record/date coverage
`not_established`. Representative playbooks and their review workflows are
additional gates before automatic structured-record publication. Passing synthetic binary fixtures establishes this
contract's implementation. It does not establish general PDF quality or
production recovery objectives.
