# Source-bound PDF table bypass

Status: implemented for P2-22.

The P2-20 comparison showed that disabling Docling table reconstruction can
recover worksheet fields, but applying that mode to a complete document removes
useful row and column relationships elsewhere. A bounded proof established that
the pinned local pipeline can skip only the table stage for selected original
pages while producing one valid Docling document. The selection must be tied to
the captured source bytes. A page number alone is not a safe identity.

## Configuration and bounds

Add an optional `pdfDocQa.parser.tableStructureBypass` object. Its keys are
lowercase SHA-256 digests of complete captured PDFs. Each value is a nonempty
array of original one-based page numbers. Accept at most 32 source entries and
at most 64 page numbers from 1 through 64 per entry. Reject an empty policy,
empty page arrays, duplicates, unsorted arrays and out-of-range pages. Require
each page array to be strictly increasing and canonicalize digest keys in
lexicographic order.

Omission preserves the current normalized configuration and journal binding.
An explicit policy changes the binding. A policy is valid only with table
structure enabled or omitted, where omission still means enabled. Reject a
policy combined with whole-document `tableStructure: "off"`. Keep the global
default enabled and do not add automatic selection, filename matching, folder
matching or content heuristics.

The 32 by 64 bound keeps the complete normalized policy, parser descriptor and
profile response below the existing 16 KiB launcher result limit. PDF conversion
remains limited to 64 pages, 16 MiB input, 64 MiB raw output and 4 MiB normalized
output.

## Static parser identity

Use parser descriptor schema 3 only when a bypass policy is configured. Its
closed configuration contains the existing conversion limits, global
`tableStructure: "on"` and the complete normalized digest-to-pages policy. The
fingerprint is static for the configured profile. It must not vary according to
the PDF currently being converted. The implementation identity includes the
custom pipeline and table-stage wrapper source as well as the existing serializer,
pinned runtime and model manifest.

Configuration accepts the policy as a digest-keyed object. Schema 3 records its
canonical form as a lexicographically sorted array of
`{sourceSha256, pages}` objects, with each page array already strictly increasing.

Keep schema 1 as implicit whole-document table-on. Keep schema 2 as the existing
whole-document on or off contract. Their strict validation, archived inspection
and recovery behavior do not change. Do not reinterpret either legacy schema as
a page policy.

Source SHA-256 remains part of extraction identity. During conversion, derive the
matched page selection from the static policy and the already verified input
digest. Return the derived selection in the bounded launcher result. Validate it
against the caller's policy and derive it again while inspecting the persisted
bundle. An unknown digest reports an empty selection and uses ordinary table-on.
It must never claim that another policy entry matched.

## Conversion

Validate the policy before profile preparation and conversion. For a matching
digest, read the PDF page count inside the existing sandbox and resource limits,
then reject any selected page beyond the actual count before model conversion.
Unknown digests do not activate a policy entry. A changed PDF therefore follows
ordinary table-on under its new digest; any owner workflow expecting an override
can detect the empty matched selection and keep that source in review.

Construct one converter from immutable policy-bearing pipeline options so Docling's
pipeline cache identity includes the complete policy. Keep `do_table_structure`
enabled. Replace its table model with a wrapper that receives one conversion's
page batch, sends unselected pages through the normal enabled model, passes
selected pages through without a table prediction and restores the original page
order. The assembler's existing empty-table fallback then retains independently
detected text on selected pages. OCR, layout, normalization, raw serialization,
sandboxing and resource limits remain unchanged. Produce one raw Docling document;
do not merge conversion graphs or supplement them with another parser.

Pass the policy through TypeScript configuration, profile preparation, conversion,
the Python API and launcher arguments. Profile and conversion validation must
reject an ignored, changed or falsely reported policy or matched selection before
accepting outputs. Runner preparation and conversion must use the same normalized
policy so archived work cannot resume under another parser identity.

## Verification

- Prove omitted configuration keeps its historical journal binding, while an
  explicit normalized policy changes it. Reject invalid digests, entry limits,
  empty arrays, duplicates, unsorted pages, out-of-range pages and mode conflicts.
- Prove schema 3 fingerprints the full static policy and wrapper implementation.
  Verify profile identity stays the same across matching and unknown sources.
- Prove conversion derives the exact selected pages from the verified source hash,
  reports an empty selection for an unknown hash and rejects a matched page beyond
  the actual PDF page count before starting the converter.
- Convert a synthetic multi-page table fixture with one selected and one ordinary
  page. Verify selected-page source fields, ordinary-page row and cell associations,
  original page order and exact raw-to-normalized provenance in the single raw
  document.
- Reject launchers that ignore or alter the policy or matched selection. Repeat
  strict schema 1 and schema 2 profile, conversion, inspection and recovery tests.
- Keep owner documents and comparisons private. After synthetic checks and all
  four repository checks pass, separately replay the two measured owner documents
  and confirm that selected worksheet fields recover while all other page tables
  and provenance remain unchanged.

Acceptance requires exact source-bound activation, static inspectable identity,
one valid raw document, preserved ordinary tables and no behavioral or journal
identity change when the policy is omitted. The implementation fingerprint can
still change when conversion code changes. A maximum-size policy test must
serialize the complete schema 3 descriptor and launcher response and prove that
each remains below the existing 16 KiB protocol limit.

A bounded private replay covered nine documents and 155 pages. Both selected
worksheet pages retained all six reviewed fields. All 153 unselected pages
matched the table-on baseline for normalized text, raw semantics, provenance and
table structures. The replay produced no mapping gaps and left every source
unchanged.
