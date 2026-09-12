# Document inventory, cards and bounded extraction

Date: 2026-09-12. Status: P2-70 design plan. No implementation lands with this
document.

Parent: [Phase 2 document pipeline](./2026-09-07-phase2-document-pipeline.md).
Related: [architecture](./2026-09-06-architecture.md),
[record-query contract](./2026-09-06-record-query-contract.md),
[inline-ingestion contract](./2026-09-06-inline-ingestion-contract.md),
[original-byte contract](./2026-09-07-original-byte-contract.md),
[PDF document capacity](./2026-09-07-pdf-document-capacity.md),
[provider-original reference](./2026-09-08-provider-original-reference.md),
[embedding contract](./2026-09-06-embedding-contract.md),
[index capacity](./2026-09-12-index-capacity.md),
[structured field evidence](./2026-09-11-structured-evidence.md).

## Purpose

The pipeline embeds every chunk of every document. A read-only preflight of a
108-file sample projected about 705 embedding targets against a per-space
ceiling of 256. That does not scale, and it is the wrong shape for the
questions the owner actually asks.

Those questions fall into four kinds:

| Question shape                     | What answers it                       | Embedding needed |
| ---------------------------------- | ------------------------------------- | ---------------- |
| Is a named document present        | Inventory row                         | No               |
| Which entities over a date range   | Exact record query over cards         | No               |
| A named field of a named document  | Exact record query over a typed card  | No               |
| Whether a clause appears in a text | Retained text keyword search and read | No               |

None of them is a semantic passage-retrieval question. Semantic retrieval is
useful for the fifth shape, finding a document when the owner does not recall
its name, and one target per document serves that better than six chunks of
one document crowding a 32 candidate budget.

This plan replaces "embed everything" with four layers. It does not replace the
provenance, evidence, lease or activation contracts underneath them.

## 1. The four layers

| Layer          | One row per                      | Answers                                | Embedded             |
| -------------- | -------------------------------- | -------------------------------------- | -------------------- |
| Inventory      | File under an admitted source    | Presence, folder contents, exclusions  | Never                |
| Retained bytes | Source revision and text version | Exact quotes, deep reads, keyword hits | Never                |
| Cards          | Text-yielding document           | Dates, entities, amounts, clauses      | One or two targets   |
| Chunks         | Retained text slice              | Keyword hits, citations                | Only under an opt-in |

Chunks are not removed. They remain the keyword search unit and the citation
unit, exactly as the PDF capacity plan specifies. What changes is that a chunk
is no longer automatically an embedding target.

## 2. Inventory

### 2.1 Coverage rule

Every file under an admitted source root gets an inventory row, regardless of
type, size, readability or parse outcome. A file that cannot be parsed is
recorded as present and excluded, never as absent. This is the difference
between "no record was found" and "the file is there and was not read", which
the architecture's coverage rules already require the system to keep apart.

### 2.2 Row shape

`sourceInventory`, one current row per source-local file identity.

| Field                | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `spaceId`            | Owning space.                                                             |
| `sourceAccountId`    | Configured source account.                                                |
| `sourceItemId`       | Present when the file reached item admission. Absent otherwise.           |
| `identityUuid`       | The source-local UUID already assigned at discovery.                      |
| `relativePath`       | Path below the configured root alias. Never an absolute path.             |
| `folderPath`         | The parent directory of `relativePath`, indexed for folder reads.         |
| `fileName`           | Leaf name, indexed for presence reads.                                    |
| `byteLength`         | Observed byte count.                                                      |
| `contentHash`        | SHA-256 of the file bytes, worker asserted.                               |
| `mediaType`          | Declared by the worker from magic bytes, not from the extension.          |
| `modifiedAt`         | Source modification time as observed.                                     |
| `duplicateGroupId`   | Hash of `(contentHash, byteLength)` when a group has two or more members. |
| `contentIndexed`     | Boolean. True only when an active generation holds retained text.         |
| `exclusionReason`    | Absent when `contentIndexed` is true. Otherwise one closed value.         |
| `exclusionDetail`    | The failure class for `parse_failed`. Absent for every other reason.     |
| `firstSeenScanId`    | The committed scan that first observed the file.                          |
| `lastSeenScanId`     | The last committed scan that observed it.                                 |
| `missingSinceScanId` | Set only by a healthy completed reconciliation.                           |

Indexes: `by_space_account_folder`, `by_space_account_fileName`,
`by_space_account_exclusionReason`, `by_space_duplicateGroup`.

### 2.3 Exclusion reasons

The existing worker gap codes are the value set, plus four additions.

| Value                     | Raised by                                                      |
| ------------------------- | -------------------------------------------------------------- |
| `unsupported`             | Media type with no adapter.                                    |
| `oversized`               | Above the binary or text limit for its type.                   |
| `permission_denied`       | Directory or file not readable.                                |
| `unreadable`              | Read failed or the bytes are not what the type claims.         |
| `unstable`                | Changed or moved during reading, or a symlink.                 |
| `empty`                   | Zero bytes.                                                    |
| `enumeration_interrupted` | The scan did not complete over this subtree.                   |
| `encrypted`               | New. The parser could not open the document without a secret.  |
| `duplicate_of`            | New. Another member of the duplicate group is content indexed. |
| `parse_failed`            | New. Parsing ran and produced no usable retained text.         |
| `extraction_pending`      | New. Retained text exists, no card has been accepted yet.      |

`encrypted` closes a real gap. Today an encrypted PDF passes discovery on its
magic bytes and fails later inside the parser as a generic `output_invalid`
protocol error. The worker must classify the encryption failure before that,
so the file lands in inventory as present and excluded rather than as a parser
crash.

`extraction_pending` is the only reason that is expected to clear on its own.
Every other reason requires a review decision or a configuration change.

### 2.4 Relationship to existing scan state

`workerScanEntries` stays as it is. It is per scan run and retention bounded,
which is the right shape for scan forensics and the wrong shape for an
inventory question. `sourceInventory` is upserted from the same
`scan.appendPage` submissions, keyed by the file identity rather than by the
scan, and is not retention bounded. No second identity authority is created:
the identity manifest remains the authority and inventory carries its UUID.

`parse_failed` is set and cleared outside a scan: the shared document job
failure path marks a file's row `parse_failed` (with its failure class in
`exclusionDetail`) the moment a job gives up retrying, and a later job
activating successfully for the same file clears it back to
`extraction_pending`, rather than waiting on the next scan to notice either
change. `missingSinceScanId` is set only in `scan.reconcile`'s completion
branch, and only for a healthy completed reconciliation
(`done && !needsReview`): every row this scan did not touch keeps the scan id
of the reconciliation that first found it missing, and a later scan that
observes the file again clears the field on the same upsert that already
refreshes `lastSeenScanId`.

### 2.5 Duplicate groups

Group members are files whose `(contentHash, byteLength)` match within one
source account. Exactly one member is content indexed. The others carry
`duplicate_of` and are reachable from the group. The group is a label over
distinct identities, never a merge. The existing rule that separate equal
content files receive separate identities is unchanged.

Canonicality is a label, not an admission gate: among the members not yet
content indexed, the one with the lowest `identityKeyHash` is canonical, a
deterministic tie-break that does not depend on scan or arrival order, and
nothing about being labeled `duplicate_of` blocks a file from being read,
scanned or (if the canonical member is later forgotten) becoming canonical
itself. Inbox admission behavior is unchanged.

### 2.6 Read surface

`list_sources` gains an optional `inventory` request and a matching response
block, following the precedent that `query_records` already sets by carrying a
second provider inside one tool rather than adding a tool.

| Input              | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `folderPath`       | Exact folder. Returns its files and its counts.            |
| `fileNameContains` | Case folded substring over the leaf name.                  |
| `contentIndexed`   | Filter to indexed or excluded files.                       |
| `exclusionReason`  | Filter to one reason.                                      |
| `cursor`           | Opaque continuation, same session rules as record queries. |

The response always carries counts by exclusion reason for the selected scope,
so a truncated page never reads as a complete folder. A page of at most 25
rows and the existing 96 KiB result budget apply.

## 3. Retained original and retained text

Unchanged. Original bytes stay behind an archive receipt pair or a verified
provider reference. Retained text stays immutable, page addressed, UTF-16
offset addressed and hash sealed. Keyword search over retained text continues
to work with no embedding involved.

One honest correction to how this gets described. Reading the original bytes
requires the authorized desktop worker: `originalRecoveryStatus` reports
`desktopRecoveryRequired: true` for every provider original today. "Deep
questions read the original on demand" means in practice that they read the
retained text on demand, and read the original only when the worker is
reachable. The hosted answer path never depends on it.

## 4. Cards

### 4.1 A card is a record, not a new store

Cards are events and observations in the existing record store. Nothing new is
built for them beyond record kinds and their schemas.

| Concept        | Existing mechanism                                           |
| -------------- | ------------------------------------------------------------ |
| One card       | One `events` row, identity `(sourceItemId, eventKey)`        |
| Card version   | One `eventVersions` row per processing generation            |
| Card field     | One `observations` row, identity `(eventId, observationKey)` |
| Repeated field | Several observations of one `observationType`                |
| Field evidence | `evidenceSpans` ids on the field's evidence arrays           |

`eventKey` is `card:<recordKind>`. One card of a kind per document. A repeated
line uses `observationKey` of `<type>:<ordinal>` with the shared
`observationType`, so `observation_history` lists every employer or every
payer in one call.

`observationType` is already a free-form string matching
`^[a-z][a-z0-9_]{0,63}$`, so card fields need no validator change. Only
`recordEventTypeValidator` gains literals, and `requireEventSchema` and
`requireObservationSchema` gain the per-kind constraints below.

### 4.2 Card kinds

| Record kind                  | One per                      | Fields                                                                                                                                                                   |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document_card`              | Text-yielding document       | `card_kind`, `card_title`, `card_date`, `card_party` (repeated), `card_summary`                                                                                          |
| `safe_note_card`             | SAFE or convertible note     | `company`, `investor_entity`, `instrument_date`, `principal_amount`, `valuation_cap`, `discount_rate`, `mfn_clause`, `pro_rata_right`, `governing_law`                   |
| `tax_return_card`            | Individual return            | `tax_year`, `filing_status`, `adjusted_gross_income`, `taxable_income`, `total_tax`, `refund_or_amount_due`, plus repeated `w2_employer`, `k1_entity`, `form_1099_payer` |
| `k1_card`                    | Partnership or S corp K-1    | `k1_entity`, `tax_year`, repeated `k1_income` by class, `capital_account_beginning`, `capital_account_ending`                                                            |
| `brokerage_tax_package_card` | Annual brokerage tax package | `tax_year`, repeated `form_present`, repeated `form_total`                                                                                                               |
| `spreadsheet_card`           | Spreadsheet                  | Repeated `sheet_name`, `column_header`, `row_count`, `sheet_total`                                                                                                       |

Value types follow the existing union. Money fields are `money`. Rates such as
`discount_rate` are `decimal` with a unit code. `mfn_clause` and
`pro_rata_right` are `boolean`. `tax_year` is `integer`. `company`,
`investor_entity` and `k1_entity` are `entity` when resolution succeeds and
`text` when it does not, per section 4.4.

The generic card is published for every text-yielding document. A typed card
is published on top of it when the classifier and the gate both accept one.
A document with no recognized type keeps only its generic card.

`documents.title` and `documents.docType` stay what they are today, worker
supplied display metadata with no evidence. Activation writes the card's
accepted `card_kind` into `documents.docType` so `search_documents` type
filtering and the card classification cannot disagree.

### 4.3 Every field carries evidence

A field with no resolvable evidence is not stored. Not stored as null, not
stored with a confidence score, not stored at all. The missing field becomes a
review item.

Every card field binds to one or more `evidenceSpans` rows. That row is
already a page-relative UTF-16 range over sealed retained text with a
`quoteHash` the server recomputes. It is the same guarantee the finance read
contract spells `retained_text_span_v1`; the name is not shared, because the
two stores are separate and the archive's kind names its own retained objects.
Nothing in this plan introduces `retained_text_span_v1` into this repository.

#### Card publication stages its own spans, settled on review 2026-09-12

A card field usually cites text the parser never staged a span over: an amount
in a sentence, a party named in prose. Card publication therefore stages the
spans it needs over the sealed text version.

Sealing protects the retained text and its pages, not pointers into them. The
staging path writes `evidenceSpans` rows and nothing else. It never writes a
page, never writes a text version, never clears `evidenceSealed`, and never
widens a range it was given.

| Rule                | Statement                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Same guarantee      | The page is in this text version, the range is inside it and on UTF-16 boundaries, and `quoteHash` is recomputed from that page's text. |
| Quote form          | A cited quote must occur exactly once on its page and equal the slice character for character. Two occurrences prove nothing.           |
| Unprovable citation | The ref resolves to no span. The field reaches the gate with no evidence and is refused as `evidence_missing`, which leaves a drop row. |
| Reuse               | An existing span over exactly the same range is reused, whether the parser or an earlier card version staged it.                        |
| Indistinguishable   | The gate and evidence hydration treat a card-staged span exactly as a parser span. Nothing downstream asks which staged it.             |
| Reachability        | A card-staged span records every card extraction fingerprint that cited it, so a row an accepted step reused is never swept.            |
| Sweep               | A card-staged span whose fingerprints name no surviving card generation is deleted. A retired generation keeps its row and its spans.   |

Accumulation is bounded by reuse: re-extraction over unchanged text creates no
rows and only adds a fingerprint to rows that exist.

Spreadsheet cells reuse the existing `sheet` locator kind on the same evidence
span, extended if needed with a zero-based row index, a zero-based column
index and the header cell text. The span still points at the cell's text
inside the retained page text and still hashes to `quoteHash`. A locator
never replaces the span; it names the position the span was taken from.

Existing limits hold: at most 16 evidence spans per field, at most 64 spans
and 16 KiB of quotes per hydrated record, at most 32 event versions and 128
observations per generation. A card that would exceed any of them is a review
item, not a raised limit.

### 4.4 Entity resolution

Extraction always stores the literal name it read, bound to its span. Binding
that name to an entity is a separate, deterministic step.

| Match count after normalization | Result                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Exactly one                     | Set `observations.boundEntityId`. The `text` value and its span are unchanged. |
| Zero                            | Leave the field literal-only. Raise an `entity_binding_needed` review item.   |
| Two or more                     | Leave the field literal-only. Raise an `entity_binding_needed` review item.   |

#### Three points settled on implementation, 2026-09-12 during P2-70l

| Point                 | Implemented                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the id is kept  | Beside the literal value, in `observations.boundEntityId`, not as an `entity` value in its place. Replacing the value would delete the literal name from the record and leave only the span quote, and the gate proves a value against its span, so an `entity` value could never pass rule 6. The gate keeps refusing `entity` values with `entity_value_unsupported`. |
| One review kind       | `entity_binding_needed`, with the candidate count on the row, rather than `entity_unresolved` and `entity_ambiguous`. Zero and two-or-more take the same action from the same surface, and the count already says which happened.                                                                                                                              |
| Normalization         | `normalizeEntityName`, the same function that wrote `entities.normalizedName`, so a lookup can never disagree with what was stored. It casefolds and collapses separators; it strips no punctuation and no legal suffix. Adding either would mean rewriting every stored `normalizedName` in the same change, so it is deferred to its own task.                 |

Matching compares against `entities.normalizedName` and
`normalizedAliases` over one bounded scan of the space's entities, because
Convex indexes an array field by its whole value and an alias is therefore
not reachable through `by_spaceId_kind_normalizedName`. A space past the
scan bound never auto-binds, so the failure is a review item rather than a
wrong binding. Extraction never creates an entity and never merges one. The
owner resolving a review item creates the entity (`createEntityFromCard`) or
binds an existing one and gains the alias (`bindCardEntity`), which is the
existing explicit merge rule. An entity that gains an alias makes some
pending names resolvable, and the paged `rebindPendingCardEntities` job binds
every pending row that then matches exactly one entity.

This matters for correctness of the date and entity questions: because the
literal name is always stored with evidence, "which companies over a year"
answers completely even before any entity is bound. Binding improves grouping
and the entity filter; it is not a precondition for an answer.

### 4.5 Which entity a card event belongs to

`events` require an `entityId`. Cards resolve it as follows.

| Record kind                                                | Event entity                                          |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `safe_note_card`                                           | The investor entity, kind `person` or `organization`. |
| `tax_return_card`, `k1_card`, `brokerage_tax_package_card` | The filer or holder, kind `person`.                   |
| `document_card`, `spreadsheet_card`                        | The source account's configured subject entity.       |

Source configuration gains a required `subjectEntityId` before cards are
enabled for that source. A source with none does not publish generic cards,
and its documents remain retained text with an `extraction_pending` inventory
reason. This is deliberate: guessing the subject from the uploader is exactly
the inference the architecture forbids.

A kind whose event entity is a name the document itself writes declares that
field as its `eventEntityField`; `safe_note_card` declares `investor_entity`.
The card publishes on the subject entity, and when P2-70l binds that field's
literal name to exactly one entity of an allowed kind the binding step moves
the event version and its observations to that entity, which is what makes an
entity-filtered `list_events` return the card. The previous entity id is
recorded on the binding row, so a rollback restores it exactly as
`docTypePatch` does for `documents.docType`. Every other kind keeps the
subject entity, and binding only annotates the observation.

### 4.6 Versioning on re-extraction

A card version is a processing generation. Re-extraction reuses the source
revision and the parser artifact, takes a new extraction fingerprint, and
stages a new generation that activates atomically. Old card versions and their
citations remain addressable, which is the existing correction rule for
unchanged bytes.

The extraction fingerprint gains the card schema version, the playbook
version, the prompt version, the gate version and the tier that produced the
accepted output. A tier change therefore produces a new generation, which is
the correct audit result.

#### The sibling rule, settled on review 2026-09-12 during P2-70c

A card generation is a sibling of the text generation, not its successor. The
item invariant becomes **one active text generation plus at most one active
card generation**, and both are current.

| Rule               | Statement                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Payload            | A card generation carries no pages, evidence spans, documents or chunks. It reuses the text generation's revision and sealed text version. |
| Record exclusivity | A generation holds card records or pipeline records, never both, so one event can never have two current versions.                         |
| Chunk identity     | Card publication creates and retires no chunk row, so no chunk embedding target id changes and no re-embed is forced.                      |
| Text generation    | Unchanged by a card publication. It stays the item's active text generation and its documents stay `active`.                               |
| Card retirement    | Publishing a new card version retires the previous card generation only, which keeps its versions snapshot readable.                       |

A successor generation was the first implementation and was wrong. Copying the
document and chunk rows forward gave every chunk a new row id, and chunk
embedding targets are keyed by that id, so each card publication would have
retired and recreated every chunk target for the document and forced a re-embed
of content that never changed. Section 9.2 and invariants I3 and I11 of the
index capacity plan forbid exactly that.

Because a card generation has no documents of its own, the `documents.docType`
rule of section 4.2 is an in-place patch of the active text generation's rows
at card activation. It is idempotent, and the previous value of each patched
row is recorded on the card version so a rollback restores it.

Rejected lower-tier attempts never become generations. Only the accepted
tier's output is staged. Attempts are recorded separately, per section 5.4.

## 5. Extraction ladder

### 5.1 The ladder

| Step | Runner                           | Used when                                      |
| ---- | -------------------------------- | ---------------------------------------------- |
| L    | A local model on the worker host | Configured and reachable. First attempt.       |
| 0    | Tier 0 hosted model              | No local runner, or step L failed the gate.    |
| 1    | Tier 1 hosted model              | Step 0 failed the gate.                        |
| R    | None                             | Step 1 failed the gate. Becomes a review item. |

The local step is optional. When it is not configured, the ladder starts at
step 0 and says so in the attempt record. A skipped step is never reported as
a passed step.

### 5.2 The gate decides, not the model

Escalation is decided by a mechanical check in code. No model is asked whether
an extraction is correct, and no self-reported confidence is read.

For each extracted field, all of the following must hold:

1. The cited span resolves in the sealed retained text of the generation's
   text version, and its recomputed `quoteHash` matches.
2. The span's text, run through the field's declared normalizer, equals the
   stored value exactly.
3. Money normalizes through `canonicalizeDecimal` and `validateCurrencyCode`
   after stripping grouping separators and a currency symbol. No value passes
   through a JavaScript number at any point. `tax_return_card`, `k1_card` and
   `brokerage_tax_package_card` declare their money fields under
   `money_usd_default_v1`, which reads a bare amount with no currency
   indicator as USD instead of failing; every other kind still requires one.
4. Dates normalize under a declared, versioned format list. A span that is
   ambiguous across two formats in that list fails. It does not pick one.
5. Percentages and rates normalize to a canonical decimal with an explicit
   unit code.
6. A name field requires the literal name inside the span.
7. A boolean is storable as true only from a span that asserts the clause, and
   as false only from a span that explicitly negates it. Absence of a span
   means absence of the field, never false.

Rule 7 follows the architecture's rule that an absent value is not zero and an
absent test is not a negative result. It has a cost, described in section 15.

Outcomes per card:

| Gate result                      | Action                                            |
| -------------------------------- | ------------------------------------------------- |
| Every required field passes      | Accept. Stage and activate this tier's output.    |
| A required field fails           | Escalate. Nothing is staged from this tier.       |
| Only optional fields fail        | Accept. Drop those fields. Raise `field_dropped`. |
| A required field fails at step 1 | Raise `card_gate_failed`. Publish no typed card.  |

A failed typed card does not suppress the generic card. A document whose
`safe_note_card` fails the gate still has a title, a date and a summary.

### 5.3 Prompt and tool boundary

The extraction runner receives the retained text of one document, page
delimited, and the card schema with the gate's normalizer expectations. It
receives no credentials, no source access, no network tools and no other
document. Document text is untrusted input: it cannot change the source
access, the tool set, the outbound destinations or the publication rules. This
restates the existing playbook rule rather than adding a new one.

The runner cites a location, never an evidence span id: it holds no ids, and a
location is what a page of sealed text can be checked against. A location is a
page ordinal plus either a UTF-16 range or a quote. The code turns it into a
span under the rules of section 4.3 before the gate sees anything, reusing a
span that already covers exactly that range and refusing one it cannot prove.

Extraction agents read the owner's documents by design. They write only to the
private store. They never write to this repository, and every fixture in this
repository is synthetic.

### 5.4 Attempt records

`cardExtractionAttempts`, one row per attempt, retained for cost reporting and
for evaluating a ladder change without rerunning it.

| Field                                           | Meaning                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentKey`, `recordKind`                     | What was attempted.                                                                                                                                                                                                                                                  |
| `step`                                          | `local`, `tier0` or `tier1`.                                                                                                                                                                                                                                         |
| `promptVersion`, `gateVersion`, `schemaVersion` | Reproducibility.                                                                                                                                                                                                                                                     |
| `outcome`                                       | `accepted`, `escalated`, `review` or `skipped`.                                                                                                                                                                                                                      |
| `failedFields`                                  | The field names that failed the gate.                                                                                                                                                                                                                                |
| `modelId`                                       | Which model ran, or the local stub.                                                                                                                                                                                                                                  |
| `inputTokens`, `outputTokens`                   | Measured from the provider response.                                                                                                                                                                                                                                 |
| `costUsd`                                       | Derived from the measured token counts and the versioned price table, in integer micro-USD so no cost crosses a float. The provider reports tokens, not dollars, so a card cost is always derived; the price table version on the row says which table was in force. |
| `startedAt`, `finishedAt`                       | For the throughput report.                                                                                                                                                                                                                                           |

## 6. Queue, budget and resumption

`cardExtractionQueue`, one row per `(documentKey, recordKind)`.

| Field                      | Meaning                                                 |
| -------------------------- | ------------------------------------------------------- |
| `state`                    | `pending`, `running`, `accepted`, `review`, `skipped`.  |
| `nextStep`                 | The ladder step to try next.                            |
| `attemptCount`             | Bounded. Exhaustion is a review item, not a retry loop. |
| `notBefore`                | Backoff and rate pacing.                                |
| `priority`                 | Newest first by default. Operator settable.             |
| `leaseEpoch`, `leaseToken` | The existing worker lease and fencing, unchanged.       |

Budgets are configuration, not constants in code.

| Control            | Default | Behavior when reached                              |
| ------------------ | ------- | -------------------------------------------------- |
| Documents per hour | 30      | The runner sleeps. Queue state is unchanged.       |
| Daily budget       | 10 USD  | The source reports `budget_paused`. Not a failure. |
| Weekly cap         | 50 USD  | Same, and the daily budget cannot override it.     |

A paused backfill is a visible state in source status, not a silent stop and
not an error. Because the queue row is the durable state, a restart resumes
from it, a killed runner loses at most one in-flight document, and an accepted
card is never re-extracted merely because the process died.

## 7. Review queue

| Item kind           | Raised when                                                 | Resolution                                              |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `skipped_by_type`   | Inventory carries `unsupported`, `encrypted` or `oversized` | Accept as skipped, convert the file, or raise the limit |
| `card_gate_failed`  | A required field failed at the top automatic step           | Correct the field, or accept the card without it        |
| `field_dropped`     | An optional field failed the gate                           | Correct or accept                                       |
| `duplicate_group`   | Two or more files share content                             | Choose the canonical member, or accept the group        |
| `entity_binding_needed` | A name matched zero, or two or more, entities           | `createEntityFromCard`, or `bindCardEntity` explicitly  |

Review items reuse the existing review-candidate rules. They are inert, they
are excluded from active records and exact queries, they block the relevant
record and date coverage, their resolution is single use and idempotent, it
records the actor, and a worker cannot approve its own item by resubmitting it.

Nothing is silently dropped. Every inventory row with an exclusion reason and
every dropped field is reachable from a count in the review surface, and the
counts are what the owner sees first.

## 8. Embedding targets

### 8.1 The new eligibility rule

| Target                 | Eligible                                    |
| ---------------------- | ------------------------------------------- |
| Card summary           | Always, for every accepted generic card.    |
| Section heading digest | When the document has two or more headings. |
| Chunk                  | Only when the document carries the opt-in.  |
| Thought                | Unchanged.                                  |

The card summary target embeds a composed input: `card_kind`, `card_title`,
`card_date`, the `card_party` values and `card_summary`. Its `inputHash` is
therefore stable while those accepted fields are stable, which is what lets a
re-chunk or a parser change reuse the vector.

The heading digest is one target holding the document's section headings in
order. It exists because a heading is often the only place a document names
its own subject, and it is optional so a flat document costs one target.

### 8.2 Full-chunk opt-in

A boolean set from a per-source configuration rule and overridable per
document by an authorized operator. Prose documents that reward passage
retrieval set it. Forms, statements and tables do not.

The 9 documents in the frozen retrieval pilot corpus are grandfathered with
the opt-in set, so their 163 chunk vectors remain eligible and the frozen
scorer's corpus is unchanged. This is required, not a convenience: see
section 9.

#### As implemented in P2-70j

| Item                | Plan said              | Implementation                                                                                                        |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Where the flag lives | `documents`           | `sourceItems.embedFullChunks`, with `sourceAccounts.embedFullChunks` as the per-source rule the item overrides.       |
| Why                 | -                      | A `documents` row is recreated by every processing generation, so an opt-in stored there would be lost on re-extraction. |
| Deploy safety       | Not stated             | `spaceEmbeddingStates.targetPolicy`, absent meaning `all_chunks`. Eligibility is unchanged until an operator flips it. |
| Card target id      | Not stated             | The generic card's `events` row, not the card generation, so re-extraction over unchanged fields reuses the vector.   |
| Heading digest      | One target per document with two or more headings | Not implemented. No stage of the pipeline extracts section headings today, so there is nothing to compose a digest from. It stays a plan item. |

The grandfathering migration is
`models/embeddings/migrations:setChunkEmbeddingOptIn`, which names source items
and writes the field. The pilot corpus is identified by that field afterwards,
never by an id list in code. `setSpaceTargetPolicy` is the flip, and it runs
only after the frozen scorer has been rerun on the grandfathered corpus.

### 8.3 Why this improves retrieval, not only capacity

Vector search returns at most 32 candidates for a request, split across
spaces, and `MAX_RESULTS_PER_DOCUMENT` is 3. At 6.5 chunks per document those
32 candidates can come from as few as 11 documents, and the per-document cap
exists to stop one document from taking the whole budget. At one target per
document the same 32 candidates cover 32 documents. Recall at scale is still
an open retrieval question, and this plan does not claim a measured
improvement. It claims the budget is spent on more documents.

## 9. Relation to the index capacity plan

The index capacity plan is not superseded. Cards ride on it.

### 9.1 The retargeted requirement

| Corpus             | Targets today, at 6.5 per file | Targets with cards |
| ------------------ | -----------------------------: | -----------------: |
| 108-file sample    |                            705 |         108 to 216 |
| 10,000-file corpus |                   about 55,000 |    8,500 to 17,000 |

The realistic requirement becomes low thousands to low tens of thousands of
targets per space. The 50,000 design target stays and no code constant may sit
below it. Two reasons: a prose-heavy space that sets the full-chunk opt-in
widely returns to the chunk-per-document rate, and a corpus larger than 10,000
files is not excluded. Lowering the ceiling to match the card rate would have
to be undone the first time either happens.

### 9.2 What of that plan still applies

| Part                                    | Still applies                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `embeddingTargets` table and counters   | Yes. `targetKind` gains `card`. This is where card eligibility lands.               |
| `embeddingBuildJobs`, paged resume      | Yes, unchanged.                                                                     |
| Content-addressed vectors and `scopeV2` | Yes. Cards make reuse more valuable, since a re-chunk no longer changes any target. |
| Incremental admission                   | Yes. A published document now adds 1 or 2 targets instead of 6 or 7.                |
| Retention and cleanup                   | Yes, and it is how the retired chunk vectors are removed.                           |
| Stats from counters                     | Yes, unchanged.                                                                     |
| Invariants I1 through I10               | Yes, unchanged.                                                                     |
| The 5,000-target growth test            | Yes. Still the right fixture size.                                                  |
| The frozen scorer migration gate        | Yes, and section 8.2 is what keeps it passable.                                     |

### 9.3 Ordering

P2-6a and P2-6b precede P2-70j. Both of them, not just the target table.
P2-6a supplies the `embeddingTargets` table and the counters that card
eligibility is written into, and P2-6b supplies the resumable paged builder
that removes the 256-target per-space bound. Activating card targets before
that bound is raised would fail the whole space's manifest derivation, because
`deriveEmbeddingManifest` is all or nothing: see section 10.3.

Nothing else in this plan depends on the capacity work. Inventory, cards, the
gate, the ladder, the queue and the review surface can proceed in parallel
with it.

## 10. Sizing

### 10.1 Assumptions

Every number below is arithmetic over these assumptions. They are not
measurements, and the first two are derived from one 108-file sample.

| Assumption                            | Value                                                   | Basis                                                           |
| ------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Retained text per document            | about 52 KiB                                            | 705 chunks over 108 files at the 8 KiB chunk target             |
| Input tokens per document             | 15,000                                                  | 52 KiB at four bytes per token, plus 1,500 of schema and prompt |
| Output tokens per card call           | 1,200                                                   | Fields plus their quotes. Quotes dominate.                      |
| Calls per document                    | 1                                                       | Generic and typed cards share one discriminated schema          |
| Escalation rate from step 0 to 1      | 30%                                                     | Assumed. No measurement exists.                                 |
| Local step                            | Unavailable                                             | Conservative. A working local step reduces every figure.        |
| Text-yielding share of a large corpus | 85%                                                     | Assumed.                                                        |
| Tier 0 price                          | 1.00 and 5.00 USD per million tokens, input and output  | Published                                                       |
| Tier 1 price                          | 2.00 and 10.00 USD per million tokens, input and output | Published                                                       |

Per document: step 0 costs 0.021 USD, step 1 costs 0.042 USD, and the blended
cost at a 30% escalation rate is 0.034 USD.

### 10.2 Sizing table

| Quantity                          | 108-file sample | 10,000-file corpus |
| --------------------------------- | --------------: | -----------------: |
| Files                             |             108 |             10,000 |
| Text-yielding documents           |             108 |              8,500 |
| Inventory rows                    |             108 |             10,000 |
| Step 0 input tokens               |       1,620,000 |        127,500,000 |
| Step 0 output tokens              |         129,600 |         10,200,000 |
| Step 1 input tokens               |         480,000 |         38,250,000 |
| Step 1 output tokens              |          38,400 |          3,060,000 |
| Step 0 cost, USD                  |            2.27 |             178.50 |
| Step 1 cost, USD                  |            1.34 |             107.10 |
| Total cost, USD                   |            3.61 |             285.60 |
| Range, all step 0 to all step 1   |    2.27 to 4.54 |   178.50 to 357.00 |
| Embedded targets                  |      108 to 216 |    8,500 to 17,000 |
| Embedded targets today            |             705 |       about 55,000 |
| Wall time at 30 documents an hour |       3.6 hours |          11.8 days |
| Elapsed under the default budget  |           1 day |      about 6 weeks |

The sample fits inside one day's budget. The large corpus is budget bound
rather than rate bound: 285.60 USD against a 50 USD weekly cap is about six
weeks. That is the intended shape. A backfill that takes a month is
acceptable; one that spends the year's budget in a day is not.

These are one-time backfill figures. A playbook or schema change re-extracts
the affected documents and repeats the cost for those documents only.

Embedding cost is not tabulated. The binding constraint on the embedding side
is the target count against the index, not the dollars, which are small at
every corpus size above.

### 10.3 The sample does not fit under the current bound

The card target counts above are added to a space that is not empty.
Production already holds 180 active targets: 17 thoughts and the 163
grandfathered pilot chunks of section 8.2.

| Quantity                | 108-file sample | 10,000-file corpus |
| ----------------------- | --------------: | -----------------: |
| Existing active targets |             180 |                180 |
| Card targets added      |      108 to 216 |    8,500 to 17,000 |
| Total active targets    |      288 to 396 |    8,680 to 17,180 |
| Current per-space bound |             256 |                256 |

Cards cut the growth rate. They do not bring the sample under 256, and an
earlier draft of this plan claimed they did. The claim was wrong.

The consequence is an ordering constraint, not a redesign.
`deriveEmbeddingManifest` raises `EmbeddingManifestLimitError` and fails the
whole space's manifest when the combined thought and chunk count exceeds
`MAX_EMBEDDING_MANIFEST_TARGETS`. It does not embed a subset. Activating card
targets for the sample before the bound is raised would therefore take the
space's semantic index from working to unavailable.

P2-6a and P2-6b must land and the bound must be raised before P2-70j activates
card targets in any space. Until then the sample's cards are published, exactly
queryable and keyword searchable with no vector at all, which is the point of
sections 1 and 2. Only their semantic targets wait.

## 11. Test plan and acceptance

No real document enters this repository. Fixtures are generated by a checked-in
generator with recorded hashes, and every ladder step in tests is a fixture
runner that returns a canned payload. No test calls a model.

| Test                       | Setup                                                                                                                                                      | Assertion                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Inventory completeness     | Synthetic tree with an encrypted PDF, an unsupported type, an oversized file, a zero-byte file, a duplicate pair, a symlink and an unreadable directory    | One row per file. Every excluded file is present with the expected reason. Counts equal the scan.                                 |
| Inventory presence         | Ask for a named file and for a folder                                                                                                                      | The named file is found although it was never content indexed. The folder returns its files and its counts.                       |
| Card per type              | One synthetic fixture per card kind                                                                                                                        | Every declared field publishes with a resolvable span, and the round trip through `query_records` returns the stored value.       |
| Evidence gate, wrong field | A fixture runner returns a value absent from the cited span                                                                                                | The gate fails that field with no model call. The card is not staged.                                                             |
| Evidence gate, wrong span  | A fixture runner cites a span whose quote hash does not match                                                                                              | The gate fails on hash mismatch before value comparison.                                                                          |
| Gate normalizers           | Money with grouping separators, an ambiguous date, a percentage, a negated clause                                                                          | Money passes, the ambiguous date fails, the percentage canonicalizes, the negated clause stores false.                            |
| Absent is not false        | A SAFE fixture with no MFN clause at all                                                                                                                   | `mfn_clause` is absent. It is not stored as false.                                                                                |
| Ladder escalation          | Fixture runner fails at step 0 and passes at step 1                                                                                                        | Exactly one generation is published, at step 1. Step 0 leaves an attempt row and no staged rows.                                  |
| Ladder exhaustion          | Fixture runner fails at every step                                                                                                                         | A `card_gate_failed` review item exists. The generic card still publishes.                                                        |
| Budget and resume          | Backfill with a budget that pauses mid-queue, then a kill and a restart                                                                                    | The source reports `budget_paused`. The restart re-runs at most one document and re-extracts no accepted card.                    |
| Query examples             | Synthetic cards covering several years and companies                                                                                                       | Entities over a year, terms of one instrument, presence of a clause and a named return figure all answer exactly, with citations. |
| Target count               | Publish a synthetic document with 12 chunks                                                                                                                | One or two targets appear. With the opt-in set, 13 or 14 appear.                                                                  |
| Frozen scorer              | The pilot corpus with its opt-in grandfathered                                                                                                             | The score does not move.                                                                                                          |
| Card recall                | A synthetic card corpus of at least 200 documents with distinct summaries, queried by a paraphrase of each summary that shares no distinctive term with it | The card's own document appears in the top five for at least 80% of the queries. The rate is recorded, not only the pass.         |

P2-70j implemented the card recall test as `scripts/measure-card-recall.mjs`
with `scripts/measure-card-recall.test.mjs`. One generated corpus of 200
documents and one scorer serve two embedders:

| Embedder             | What it measures                                                                  | Recorded rate at five |
| -------------------- | --------------------------------------------------------------------------------- | --------------------- |
| Deterministic (unit test) | The ranking path: one target per document, a contested top five, containment  | 0.92, MRR 0.728       |
| `--embedder=openai`  | Meaning. The number this plan's question actually asks for.                        | Unmeasured            |

The deterministic embedder reads each document's identity and its subject,
never its words, because a paraphrase that shares no distinctive term with its
summary is exactly what a term-based embedder cannot resolve. It is calibrated
so a broken ranking path fails it rather than passing by construction. The
meaning number requires a provider key and
`node scripts/measure-card-recall.mjs --embedder=openai`; until that has run,
no claim about recall on meaning is made.

Acceptance for the plan as a whole: the four question shapes in the Purpose
section are answered from synthetic cards, with citations, while the worker and
the original files are unavailable; the fifth shape passes the card recall test
above; and the 108-file sample's target arithmetic in section 10.3 is stated
honestly in the capacity gate rather than assumed to fit.

The card recall test is the first measurement of the section 15 open question
about one target per document. It is a synthetic floor, not a substitute for a
frozen evaluation on a grown real corpus. A paraphrase generated alongside the
summary shares its vocabulary and will overstate recall, which is why the
paraphrase must avoid the summary's distinctive terms and why the measured rate
is recorded.

## 12. Implementation split

Each row is one reviewed PR. Card record kinds, the evidence gate, the ladder,
the cell locator, entity binding and the target policy touch schema, evidence
or space-scoped eligibility, so they are tier 2 and take a second-model review.

| Order | PR                                                                  | Tier | Acceptance line                                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | P2-70a Inventory table, exclusion reasons, encrypted classification | 1    | The synthetic tree produces one row per file, every exclusion reason is populated, and an encrypted PDF is `encrypted` rather than a parser error.                                                                                             |
| 2     | P2-70b Inventory read surface and counts                            | 1    | A named file and a folder answer from inventory, and a truncated page carries counts.                                                                                                                                                          |
| 3     | P2-70c Card record kinds and the generic card                       | 2    | A generic card publishes as an event with observations, every field carries a resolvable span, and a field with an unresolvable span is not stored.                                                                                            |
| 4     | P2-70d Evidence gate and normalizers                                | 2    | A deliberately wrong field and a wrong span both fail with no model in the loop, and an ambiguous date fails rather than resolving.                                                                                                            |
| 5     | P2-70e Ladder, fixture runner and attempt rows                      | 2    | Escalation publishes exactly one generation at the accepted step, and exhaustion becomes a review item.                                                                                                                                        |
| 6     | P2-70f Throttled queue, budgets and resume                          | 1    | A backfill pauses at the budget, resumes after a kill, and re-extracts no accepted card.                                                                                                                                                       |
| 7     | P2-70g SAFE and convertible note card                               | 1    | The fixture publishes every declared field, and an absent clause is absent rather than false.                                                                                                                                                  |
| 8     | P2-70h Tax return, K-1 and brokerage package cards                  | 1    | Repeated employers, entities and payers publish as separate observations of one type and list in one call.                                                                                                                                     |
| 9     | P2-70i Spreadsheet card and the cell locator                        | 2    | A cited cell resolves to the retained page slice and its locator names the sheet, row and column.                                                                                                                                              |
| 10    | P2-70j Card embedding targets and the chunk opt-in                  | 2    | After P2-6a and P2-6b raise the bound: a published document adds one or two targets, a chunk is eligible only under the opt-in, the frozen scorer does not move, and the card recall test reaches at least 80% at five with its rate recorded. |
| 11    | P2-70k Review queue surface and counts                              | 1    | Every skipped file, dropped field and duplicate group is reachable from a count.                                                                                                                                                               |
| 12    | P2-70l Entity resolution and binding review                         | 2    | One match binds, zero and two or more raise the right review item, and extraction creates no entity.                                                                                                                                           |

Order is strict where it is load bearing. P2-70d precedes P2-70e, because a
ladder without a gate would escalate on nothing. P2-70j depends on P2-6a and
P2-6b, not on P2-6a alone: the 108-file sample's cards take the space past the
current 256-target bound, per section 10.3, and the manifest fails whole rather
than embedding a subset. P2-70l lands last on purpose: the literal name is
stored with evidence from P2-70c onward, so every entity question answers
before binding exists, and binding is additive.

### Migration commands

Run against the development deployment first, then with `--prod`. Record the
exact command in the owner tracker. Deployment names, space ids and source
ids stay out of this file.

```
npx convex run models/documents/inventory:startInventoryBackfill '{"sourceAccountId":"<SOURCE_ACCOUNT_ID>","dryRun":true}'
npx convex run models/documents/inventory:runInventoryBackfillPage '{"jobId":"<JOB_ID>","cursor":null,"batchSize":128}'
npx convex run models/documents/inventory:auditInventoryCounts '{"spaceId":"<SPACE_ID>","sourceAccountId":"<SOURCE_ACCOUNT_ID>"}'
npx convex run models/records/cards:setSourceSubjectEntity '{"sourceAccountId":"<SOURCE_ACCOUNT_ID>","subjectEntityId":"<ENTITY_ID>","expectedSubjectEntityId":null}'
npx convex run models/records/cards:startExtractionBackfill '{"spaceId":"<SPACE_ID>","sourceAccountId":"<SOURCE_ACCOUNT_ID>","dailyBudgetUsd":10,"weeklyCapUsd":50,"dryRun":true}'
npx convex run models/records/cards:auditCardEvidence '{"spaceId":"<SPACE_ID>","cursor":null,"batchSize":64}'
npx convex run models/embeddings/migrations:setChunkEmbeddingOptIn '{"spaceId":"<SPACE_ID>","documentKeys":["<DOCUMENT_KEY>"],"embedFullChunks":true}'
npx convex run models/records/cardEntityBinding:bindCardEntity '{"observationId":"<OBSERVATION_ID>","entityId":"<ENTITY_ID>","actorUserId":"<USER_ID>","note":"<WHY>"}'
npx convex run models/records/cardEntityBinding:createEntityFromCard '{"observationId":"<OBSERVATION_ID>","kind":"organization","actorUserId":"<USER_ID>","note":"<WHY>"}'
npx convex run models/records/cardEntityBinding:rebindPendingCardEntities '{"spaceId":"<SPACE_ID>","cursor":null,"batchSize":64}'
npx convex run models/embeddings/migrations:setSpaceTargetPolicy '{"spaceId":"<SPACE_ID>","policy":"cards_and_opted_in_chunks","expectedPolicy":"all_chunks"}'
npx convex run models/embeddings/migrations:runTargetRetirePage '{"jobId":"<JOB_ID>","cursor":null,"batchSize":128}'
```

Each page command returns the next cursor and is rerun until it reports done.
The audits are rerun after every step. The policy and subject-entity commands
take the expected current value so a concurrent change cannot be overwritten.
`setSpaceTargetPolicy` runs only after the frozen scorer has been rerun on the
grandfathered pilot corpus.

## 13. Where this plan changes an existing plan

| Plan                       | Statement today                                                                       | What changes                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding contract         | "The canonical semantic manifest includes current thoughts and active source chunks." | Changes. It becomes current thoughts, accepted document cards and chunks of documents carrying the full-chunk opt-in. P2-70j updates the paragraph.                                                                       |
| PDF document capacity      | "Expand the parsed embedding manifest budget consistently" with the chunk budget.     | Changes. The manifest no longer grows with chunks. The 256 chunk and evidence-span per-document budgets stay; they are keyword and citation budgets, not index budgets.                                                   |
| Index capacity             | 705 chunks over 108 files projects the target scale.                                  | The rate changes, the ceiling does not. 50,000 stays as the design target for the reasons in section 9.1.                                                                                                                 |
| Record-query contract      | "Version 1 supports `lab_panel`, `vehicle_service`, and `financial_transaction`."     | Changes. Six card kinds are added, with their entity-kind and value-type constraints. The 256-row scan, 25-row page, 96 KiB and 2 MiB limits are unchanged and still bind, so a year with many cards pages with a cursor. |
| Inline-ingestion contract  | "Typed extraction: no model extraction in this phase."                                | Unchanged for that endpoint. Cards are the later extractor it anticipates, and they run in the worker, not in `POST /api/ingest`.                                                                                         |
| Original-byte contract     | First-trial mapper, chunk policy, full page coverage.                                 | Unchanged. Chunks keep their coverage and citation rules. Only their embedding eligibility changes.                                                                                                                       |
| Phase 2 document pipeline  | P2-10 playbooks define accepted document classes, required fields and evidence.       | Cards are the mechanism P2-10 called for. The financial field catalog and the review-candidate workflow are reused, not duplicated.                                                                                       |
| Phase 2 document pipeline  | "An unsupported type or a file above the binary limit is a visible discovery gap."    | Strengthened. A gap becomes a durable inventory row rather than retention-bounded scan detail.                                                                                                                            |
| Pilot retrieval evaluation | The frozen gate is 17 of 18 with MRR 0.758 over 180 targets, 163 of them chunks.      | Preserved by grandfathering. If those 163 chunk targets were retired, the frozen score would move and the capacity migration gate could not be evaluated.                                                                 |
| Structured field evidence  | The finance archive's evidence kind is `retained_text_span_v1`.                       | No change. That name stays in the archive contract. Kith Mind card fields bind to `evidenceSpans` rows, which carry the same guarantee under a different name in a different store.                                       |

## 14. Security review scope

`packages/convex/convex/models/records/*` gains new record kinds and their
schema constraints, and eligibility for the space-scoped embedding index
changes. Both are schema and space-isolation surfaces, so P2-70c, P2-70d,
P2-70e, P2-70i, P2-70j and P2-70l each require a second-model review before
merge, and every implementation PR runs the four repository checks.

## 15. Decisions settled on review, and what stays open

Three decisions were carried into review as uncertain. All three are settled
as written. They are recorded here with their cost, because a settled decision
with a known cost is worth more later than a decision whose cost was forgotten.

| Item                                                     | State                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The event entity for a generic card                      | Settled on review, 2026-09-12: a required `subjectEntityId` per source. Its cost is that a source with none publishes no generic cards, which is visible as `extraction_pending` rather than as silence.                                                                                                                                                                    |
| Absent versus false for clause booleans                  | Settled on review, 2026-09-12: absent is not false. Rule 7 stands. Its cost is that "did that instrument have an MFN clause" answers "not recorded" for a document whose text never mentions one. A negation playbook that turns checked silence into false is deferred to its own task; it needs its own evidence rule and does not belong in this plan.                   |
| One embedding target per document                        | Settled on review, 2026-09-12. The fifth question shape now has a measurement rather than an assertion: the card recall test in section 11 requires the card's own document in the top five for at least 80% of paraphrase queries over a 200-document synthetic corpus, with the rate recorded. That is a synthetic floor. Recall on a grown real corpus stays open below. |
| The 30% escalation rate and the 15,000-token average     | Every dollar figure in section 10 rests on them, and both come from one 108-file sample. The first 200 documents of a real backfill replace them.                                                                                                                                                                                                                           |
| The local step                                           | Unmeasured. It is in the ladder because it is free and first, not because it is known to pass the gate at any rate.                                                                                                                                                                                                                                                         |
| Card counts against the per-generation observation limit | A dense brokerage package could approach 128 observations. This plan makes that a review item rather than raising the limit. If it turns out to be common, raising the limit is a capacity decision with its own read-budget analysis.                                                                                                                                      |
| Recall at 10,000 documents with a 32-candidate budget    | Open, and the card recall test does not close it. A synthetic corpus of 200 documents with deliberately distinct summaries is easier than a real corpus of 8,500 with overlapping ones. This needs a frozen evaluation after the corpus grows, which is the same open item the index capacity plan records.                                                                 |

## Verification

Run `pnpm lint`, `pnpm check-types`, `pnpm test:once` and `pnpm build` for
every implementation PR. Run the frozen scorer before and after the target
policy change on the grandfathered pilot corpus. Keep owner paths, space ids,
source ids and document descriptions out of this repository.
