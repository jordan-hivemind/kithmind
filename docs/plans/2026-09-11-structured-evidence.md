# Structured field evidence for the finance read contract

Status: agreed for F1-29 on 2026-09-11 (Issue 57). Decisions: JSON pointer
targets may be strings or numbers, bound by exact source token; the contract
accepts `text/csv; charset=utf-8`; one orchestrator owns every slice, and the
contract slice takes a second-model review.

The three list operations withhold every row today. The reason is stated in
`retainedTextSpanEvidence` in `packages/finance-archive/src/mcp/pgRead.ts`: the
contract's only evidence kind is a character span in a retained text artifact,
and the parsers produce a row index and a column label. A row index is not a
character offset. Synthesizing text to fill the span is the one failure this
archive refuses, so the rows stay withheld.

This proposal adds a second evidence kind for the two formats the existing
parsers can already verify against retained bytes: JSON and delimited text. It
does not widen the claim beyond those two. A record whose datum cannot be bound
to retained bytes stays withheld, and coverage stays partial.

The name is `structured_field_v1`. It cites one scalar datum, not a row, so
"field" is the accurate noun and the `_v1` suffix matches the existing kind.

## 1. The evidence type

`sourceObject` is lifted out of `RetainedTextSpanEvidence` and shared. It is
the same shape with the same meaning. One media type is added, because a
delimited export is CSV and the current union has no spelling for it.

```ts
/**
 * The immutable retained bytes an evidence item cites. Shared by both evidence
 * kinds: same identities, same byte length, same SHA-256 binding, one
 * definition. Not a path. The retained tree is content addressed, so
 * `retainedSha256` is what resolves the bytes.
 */
export type RetainedSourceObject = {
  sourceId: FinanceSourceId;
  documentId: FinanceDocumentId;
  revisionId: FinanceRevisionId;
  captureId: FinanceCaptureId;
  retainedSha256: string;
  retainedByteLength: number;
  mediaType:
    | "application/pdf"
    | "application/json"
    | "text/csv; charset=utf-8"
    | "text/plain; charset=utf-8";
};

export type RetainedTextSpanEvidence = {
  kind: "retained_text_span_v1";
  evidenceId: FinanceEvidenceId;
  sourceObject: RetainedSourceObject;
  /** Unchanged from version 1. */
  locator: {
    relativePath: string;
    textSha256: string;
    textByteLength: number;
    textCodepointLength: number;
    offsetUnit: "unicode_code_points";
    start: number;
    end: number;
    quote: string;
    quoteSha256: string;
  };
};

/**
 * Exactly two formats. Each one resolves to a single scalar inside the
 * retained bytes named by `sourceObject`, and each one carries that scalar as
 * retained so a consumer can check the cited datum rather than trust it.
 */
export type StructuredFieldLocator =
  | {
      format: "json_pointer_v1";
      /**
       * An RFC 6901 JSON Pointer into the retained bytes parsed as JSON. Must
       * resolve to a JSON string or a JSON number. See the format rules below.
       */
      pointer: string;
      /** The target's exact JSON source token, quotes and escapes included. */
      rawValue: string;
      rawValueSha256: string;
    }
  | {
      format: "delimited_row_v1";
      encoding: "utf-8";
      delimiter: "," | "\t" | ";" | "|";
      quote: '"' | "none";
      headerRows: 0 | 1;
      recordSeparator: "lf" | "crlf";
      /** Zero based, over data records only, after `headerRows`. */
      rowIndex: number;
      /** Zero based, within the record. */
      columnIndex: number;
      /** The header cell at `columnIndex`. Empty only when `headerRows` is 0. */
      columnName: string;
      /** The field's text after unquoting, untrimmed, exactly as retained. */
      rawValue: string;
      rawValueSha256: string;
    };

export type StructuredFieldEvidence = {
  kind: "structured_field_v1";
  evidenceId: FinanceEvidenceId;
  sourceObject: RetainedSourceObject;
  locator: StructuredFieldLocator;
};

export type FinanceEvidence =
  | RetainedTextSpanEvidence
  | StructuredFieldEvidence;
```

Every `RetainedTextSpanEvidence[]` on a record, an issue, and the
`get_evidence` response becomes `FinanceEvidence[]`. No other contract type
changes.

### json_pointer_v1 format rules

| Rule                | Statement                                                                        |
| ------------------- | -------------------------------------------------------------------------------- |
| Document            | The retained bytes, decoded as UTF-8 and parsed as JSON.                           |
| Duplicate keys      | A document with a duplicate key in any object is refused. A pointer into it is ambiguous. |
| Pointer syntax      | RFC 6901. Starts with `/`. `~0` and `~1` escapes only. Array indices are decimal with no leading zero. The `-` array token is refused. |
| Target              | Must be a JSON string or a JSON number. An object, array, boolean or null target is refused. |
| `rawValue`          | The target's exact source token as retained: a string token with its quotes and escapes, or a number token as written. Never a decoded or re-serialized value. |

Numbers are allowed because the token, not the parsed value, is what is
bound. `JSON.parse` with a source-text reviver (`context.source`, Node 22 and
later, already used by `retention.ts` and re-emitted through `JSON.rawJSON`)
returns every primitive's exact source token without a custom scanner, so a
provider that states an amount as a JSON number is cited with the digits it
sent. A double appears nowhere: the archive compares the token to its stored
decimal by canonical decimal equality, and a consumer verifies by token
equality. Binding the token for strings as well keeps one rule for both.

### delimited_row_v1 format rules

The format name is the version. Changing any rule below means a new format
name, never a redefinition of this one.

| Rule              | Statement                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Decoding          | UTF-8. Invalid sequences and a leading byte order mark are refused.                             |
| Records           | Split on `recordSeparator`. One trailing separator at end of file does not create a final record. Any other empty record is refused. |
| Header            | The first `headerRows` records are header. Data records are the rest, indexed from zero.        |
| Quoting           | With `quote: "\""`, RFC 4180: a quoted field may contain the delimiter, a doubled quote, and a record separator. With `quote: "none"`, only the delimiter and the record separator are special. |
| Field count       | Every record, header included, must have the same field count. A ragged file is refused.        |
| `rawValue`        | The field at `columnIndex` after unquoting. No trimming.                                        |
| `columnName`      | Must equal the header cell at `columnIndex` when `headerRows` is 1. Must be empty when it is 0.  |

### How a consumer verifies a citation

From the retained bytes alone, with no access to the archive database:

1. Fetch the retained object named by `sourceObject.retainedSha256`.
2. Check its byte length equals `retainedByteLength` and its SHA-256 equals
   `retainedSha256`. Stop on either mismatch.
3. Check `mediaType` is the one the format expects: `application/json` for
   `json_pointer_v1`, `text/csv; charset=utf-8` or `text/plain; charset=utf-8`
   for `delimited_row_v1`.
4. Apply the format rules above to those bytes and resolve the locator. For
   JSON, parse with a source-text reviver so the target's token is available.
5. Check the resolved token or field equals `rawValue` byte for byte.
6. Check `sha256(rawValue)` equals `rawValueSha256`.

Step 5 is the binding the coordination decision asks for. The bytes are pinned
by hash, the parse is pinned by a versioned description, the position is pinned
by a pointer or a row and column, and the datum itself is pinned by value. A
citation that survives all six steps cannot be a row label pointing at nothing.

## 2. Validator rules for `evidence()`

`evidence()` keeps its signature and its failure mode: it throws
`FinanceContractError` with the caller's code, never returns a partial value.

Discrimination is on `kind`, read before any key set is checked. An unknown
`kind` fails. The top-level key set is identical for both kinds, so the
existing `exact(input, ["kind", "evidenceId", "sourceObject", "locator"], [])`
call stands unchanged. `sourceObject` is parsed by one shared helper for both
kinds. `locator` dispatches on `kind` and, for `structured_field_v1`, again on
`locator.format` before its own key set is checked.

Required for `structured_field_v1`, in addition to the shared `sourceObject`
rules already enforced:

| Field              | Rule                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| `format`           | Exactly `json_pointer_v1` or `delimited_row_v1`. Anything else fails.               |
| `pointer`          | 1 through 1024 bytes. Starts with `/`. Every `~` is followed by `0` or `1`. Every segment is non-control. No absolute path, no traversal, no credential material. |
| `rawValue`         | 1 through `MAX_FINANCE_EVIDENCE_QUOTE_BYTES` (4096) UTF-8 bytes. Never empty. For `json_pointer_v1` it must lex as exactly one JSON string token or one JSON number token. |
| `rawValueSha256`   | Lowercase hex 64. Recomputed from `rawValue` and refused on mismatch, the same way `quoteSha256` already is. |
| `encoding`         | Exactly `utf-8`.                                                                    |
| `delimiter`        | One of `,` `\t` `;` `\|`.                                                           |
| `quote`            | Exactly `"` or `none`.                                                              |
| `headerRows`       | Exactly 0 or 1.                                                                     |
| `recordSeparator`  | Exactly `lf` or `crlf`.                                                             |
| `rowIndex`         | Integer, 0 through 16777215.                                                        |
| `columnIndex`      | Integer, 0 through 4095.                                                            |
| `columnName`       | 0 through 128 bytes. Empty only when `headerRows` is 0, non-empty only when it is 1. |

Refused outright:

- An unknown `kind`, an unknown `format`, or any extra or missing key in either
  the locator arm or `sourceObject`. Both arms go through `exact()` with their
  own key list, so a `json_pointer_v1` carrying `rowIndex` fails.
- A `rawValueSha256` that does not match `rawValue`.
- An empty evidence list. `evidenceList` keeps its minimum of one and its
  maximum of `MAX_FINANCE_EVIDENCE_REFS`, and keeps requiring unique
  `evidenceId` values within one list. The nonempty requirement is not
  weakened anywhere in this proposal.
- A locator that would need bytes the `sourceObject` does not name. There is no
  path field on this locator by design; the retained object is the only thing
  it can be read from.

Not checked by the validator, and stated so no one assumes otherwise: the
validator does not fetch retained bytes and cannot prove that the pointer
resolves, that the row exists, or that `rawValue` is what is actually there.
That is the storage adapter's obligation, exactly as it already is for the text
span kind. The validator proves the citation is well formed and internally
consistent.

An id is opaque under the existing `OPAQUE_ID` rule: 1 through 128 characters,
first character alphanumeric, remainder alphanumeric or `.` `_` `:` `-`. It is
a stable reference, not a hash and not a path. Producers may give it internal
structure; consumers must not parse it, compare it to anything but another id
of the same kind, or infer a document layout from it. `evidenceId`, `sourceId`,
`documentId`, `revisionId` and `captureId` are all opaque under this rule.
`retainedSha256` and `rawValueSha256` are hashes and are not opaque ids.

## 3. Archive side changes

### `documents` columns

| Column                 | Type    | Meaning                                                                     |
| ---------------------- | ------- | ---------------------------------------------------------------------------- |
| `retained_sha256`      | TEXT    | SHA-256 of the retained bytes this row's data was parsed from.                |
| `retained_byte_length` | BIGINT  | Byte length of those same bytes.                                              |
| `media_type`           | TEXT    | Media type of those same bytes, declared by the adapter.                      |
| `capture_id`           | TEXT    | The capture that acquired them (`CaptureManifest.captureId`).                 |

All four are nullable and all four are added by one additive migration. No
backfill. A row with any of them null produces no evidence and stays withheld,
which is the correct answer for a document imported before this work.

`retained_sha256` cannot reuse `documents.sha256`. For a single acquired file
the two are equal, but a paginated structured pull is captured as one
`RawFile` and split into one `documents` row per page, and each page row's
`sha256` is a derived hash of `contentHash + page key` with a `#page` suffix on
`file_path`. Those derived values name no bytes. `documents.sha256` keeps its
current role as row identity and its UNIQUE constraint; `retained_sha256`
names the bytes and is not unique, because every page row of one pull shares
them.

`media_type` is declared by the adapter, not inferred from the capability
tier. Inferring `pdf_statement` to `application/pdf` would make the synthetic
fixture lie: its statement bytes are UTF-8 text. `AcquisitionManifestEntry` in
`adapter.ts` gains a required `mediaType` field for this, which is the honest
place for it since only the adapter knows what it retained.

No `revision_id` column. Revision here means one immutable retained byte
object: the thing that changes when a document is re-acquired and the retained
bytes differ, whether because the institution reissued the document or because
the retention declaration changed. That is exactly what `retained_sha256`
already identifies, so `revisionId` is derived at read time as
`sha256-<retained_sha256>` rather than stored as a second copy of one value.
Page rows of one pull therefore share a `revisionId` and differ by
`documentId`, which is the correct reading: one byte revision, several row
slices of it.

### Reused, not added

| Thing                                          | Role                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `institutions.slug`                            | `sourceObject.sourceId`, as `pgRead` already joins it.     |
| `documents.id`                                 | `sourceObject.documentId`.                                 |
| `documents.file_path`, `documents.text_path`   | Unchanged. Neither appears in structured evidence.         |
| `transactions/positions/balances.source_document_id` | The join to the document. Already present and indexed. |
| `transactions/positions/balances.source_locator` | Carries the new binding. It is already `JSON.stringify(row.locators)`, so a richer `FieldLocator` needs no column and no migration. |
| `review_items`                                 | Unchanged. Ambiguous money still routes here.              |

### `FieldLocator`

`FieldLocator` keeps `source`, `index` and `field` for human review, and gains
one optional field. Optional because a parser that cannot bind a datum must be
able to say so structurally, and because the PDF tier will never fill it in
this slice.

```ts
export type FieldBinding =
  | {
      readonly format: "json_pointer_v1";
      readonly pointer: string;
      readonly rawValue: string;
    }
  | {
      readonly format: "delimited_row_v1";
      readonly encoding: "utf-8";
      readonly delimiter: "," | "\t" | ";" | "|";
      readonly quote: '"' | "none";
      readonly headerRows: 0 | 1;
      readonly recordSeparator: "lf" | "crlf";
      readonly rowIndex: number;
      readonly columnIndex: number;
      readonly columnName: string;
      readonly rawValue: string;
    };

export type FieldLocator = {
  readonly source: CapabilityTier;
  readonly index: number;
  readonly field?: string;
  /** Present only when this exact datum resolves inside the retained bytes. */
  readonly binding?: FieldBinding;
};
```

`rawValueSha256` is not carried here. It is derived from `rawValue` at
assembly time, and storing a hash of a value stored beside it is a second copy
of one fact.

Parser changes this forces on `adapters/syntheticTrust/index.ts`:

| Tier              | Change                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `structured_api`  | Emit a binding for the load-bearing money field with pointer `/pages/<arrayIndex>/items/<arrayIndex>/amount` and `rawValue` set to the exact source token read through the source-text reviver. The pointer uses the array index, not the `page` value in the payload, which is a provider page number and not a position. |
| `tabular_export`  | Emit a `delimited_row_v1` binding with `delimiter: ","`, `quote: "none"`, `headerRows: 1`, `recordSeparator: "lf"`. The row index must be the physical data record index. Today `parseTabularExport` filters blank lines before indexing, so its index is not a position in the file; that is a real bug for citation purposes and this is where it gets fixed. |
| PDF tier          | No binding. See section 4.                                                                    |

One binding per record, on the record's load-bearing money field: `amount` for
a transaction, market value for a position, total value for a balance. That is
the datum the record asserts and the one a reader needs to check. A record
whose load-bearing money value is null or ambiguous already becomes a review
item and is not publishable, so nothing is lost by not binding it.

### Write path

`ImportDocument` gains `retainedSha256`, `retainedByteLength`, `mediaType` and
`captureId`. `collectDocuments` in `adapterImport.ts` fills all four from
`pull.acquired.manifest` and `pull.persisted`, which it already holds, and
`importer.ts` adds them to its `INSERT INTO documents`. This threads through
the importer rather than following `recordRetainedTextPath`'s targeted
`UPDATE ... WHERE sha256 = ?`, because that predicate misses every page row of
a paginated pull, whose `sha256` is derived.

### `retainedTextSpanEvidence` in `pgRead.ts`

It becomes `evidenceFor(record, document): FinanceEvidence[] | null` and stops
returning a constant. It returns null, and the row stays withheld with
`retained_evidence_unavailable`, whenever any of the following is missing or
unusable: a `source_document_id`, any of the four new `documents` columns, a
parsable `source_locator`, a `binding` on the load-bearing money field, or a
usable money value and currency for that field. It returns one
`structured_field_v1` item otherwise, with `evidenceId` derived as
`ev:<recordId>:<field>`, which satisfies the opaque id rule and is stable
across responses.

The three list operations stop returning `items: []`. They select the
record columns they already have SQL for, map them through the existing
`decimalOrNull` and `currencyOrNull` helpers, and include a record only when
its evidence is non-null. A holding with a null `instrument_id` or a null
`valuation_basis` and a balance with a null `total_value` still cannot satisfy
the contract's record shape and are still withheld, with the reason they
already carry. `get_evidence` returns the same assembled item for a record it
can bind, and keeps its current behavior otherwise. Nothing else in the file
changes, which is what the existing comment block predicted.

## 4. The PDF tier

For `pdf_statement` and `trade_confirmation` rows the archive emits nothing in
this slice, and those rows stay withheld.

`retained_text_span_v1` is the right eventual kind for them. It cites a
retained UTF-8 text artifact, and the contract is already explicit that a PDF
byte offset is never a text offset, so citing extracted text rather than the
PDF is the intended shape and not a workaround. What is missing today:

| Missing                            | Detail                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| The text artifact                  | `documents.text_path` is written only when a caller hands `persistAcquiredDocument` an `extractedText` string. Nothing in this package extracts text from a PDF. |
| Its hash, byte length and code point length | The contract requires all three. `documents` has no column for any of them. |
| Code point offsets                 | `parseStatementText` splits on newlines and tracks a page number and a line ordinal. No parser in this package has ever produced a character offset. |
| A pinned extractor                 | An offset is only meaningful against one extractor at one version. There is no extractor and no version pin to record.                              |

A character offset locator is realistic in principle, because the offset is
into the retained text artifact and that artifact can be made immutable and
hashed like any other retained object. It is not realistic in v1. It needs an
extractor chosen and version pinned, the text artifact retained and hashed,
three more `documents` columns, and offset tracking threaded through a parser
that currently works line by line. That is a separate task of its own size.

Recommendation: PDF-derived rows stay withheld in the first slice, and the
response keeps saying so through `retained_evidence_unavailable` and partial
coverage. The synthetic fixture's statement text will demonstrate this
honestly: it carries page markers, comment lines and a holdings section, so it
is not a uniform delimited file and must not be cited as one, even though its
bytes happen to be text.

## 5. Implementation slices

Each row is one PR. Slice 1 must be agreed on the coordination issue before it
is written. Slices 2 and 3 have no dependency on each other and can run in
parallel once slice 1 is merged.

| # | Slice                                        | Tier | Shared contract | Acceptance in one line                                                                                             |
| - | -------------------------------------------- | ---- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 | Contract union and validator                 | 2    | Yes             | `evidence()` accepts both kinds and both formats, refuses an unknown kind, an unknown format, a mismatched `rawValueSha256`, a wrong-arm key and an empty list, and the four verification commands pass. |
| 2 | Archive additive migration and write path    | 2    | No              | A versioned Postgres migration adds the four nullable `documents` columns, an existing archive migrates without data loss, and a fresh adapter pull writes all four. |
| 3 | Parser locator change and synthetic adapter  | 1    | No              | `FieldLocator.binding` exists, the JSON and tabular tiers emit a binding whose locator resolves in the retained bytes, the tabular row index is the physical data record index, and the PDF tier emits none. |
| 4 | `pgRead.ts` assembly and withholding removal | 2    | No              | A record whose binding is established is returned with one `structured_field_v1` item and passes the contract's own exchange parser; every other record is still withheld with `retained_evidence_unavailable`. |
| 5 | End-to-end evidence tests                    | 1    | No              | A synthetic pull imported and read back returns citable JSON and tabular rows whose citations verify from retained bytes alone, PDF-tier rows stay withheld, and coverage is partial whenever anything is withheld. |

Slice 4 is tier 2 because it is the point where a wrong join publishes a
citation that points at the wrong bytes. Slices 1 through 4 each carry their
own unit tests; slice 5 is the proof that the four compose.

## 6. Decisions on the open questions

| Question | Decision, 2026-09-11 |
| --- | --- |
| CSV media type | `text/csv; charset=utf-8` is added to the shared media type union. Declaring CSV as plain text would misstate the bytes. |
| Money as a JSON number | Allowed. The pointer binds the exact source token, so no `json_pointer_v2` is needed. The retention projection already preserves number tokens through `JSON.rawJSON`. |
| Slice ownership | One orchestrator owns both workstreams as of 2026-09-11, so it owns every slice. The contract slice still takes an independent second-model review before merge. |
