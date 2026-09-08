# PDF document capacity

Status: implementation in progress. Tracked as P2-19, following P2-18.

Ordinary long PDFs exceed the initial page, evidence and processing budgets.
A dense document can produce thousands of parser items even when its retained
text is small. Increasing evidence counts alone would exceed document-row and
verification-read budgets. Successful extraction must still produce one complete,
citable logical document before activation.

## Document Q&A evidence profile

Validate every normalized segment against the immutable raw parser output before
mapping. Retain detailed item, table and bounding-box provenance in the archived
parser artifacts. For the new document Q&A profile, create one page-local evidence
span per chunk. Its authoritative citation remains a text revision, page, UTF-16
range and exact quote hash.

The new `parser_page_v1` locator carries the page number and normalized page hash.
The server binds it to the parser artifact and checks both fields against the
source page at insertion and sealing. This explicitly offers page/range precision;
it does not claim that a chunk corresponds to one Docling item or bounding box.
Structured extraction may retain finer evidence in a separate profile later.
Sealing and reopening require one document, one unique evidence span per chunk,
matching quote/range hashes, complete span consumption and nonoverlapping chunks.
Mixing page locators with a legacy item/table profile is rejected.

Retain the 8 KiB UTF-8 chunk target, splitting only between Unicode scalars and never
across pages. Version the mapping and chunking identity. Preserve existing mapping
identities and archived replay behavior rather than interpreting old work with the
new chunk policy.

| Constraint                   | New parsed-document profile                 |
| ---------------------------- | ------------------------------------------- |
| Pages                        | 64                                          |
| Retained text                | 1 MiB total, 64 KiB per page                |
| Chunks and evidence spans    | 256 each                                    |
| Primary logical documents    | One per PDF                                 |
| Stored parsed payload        | 4 MiB aggregate                             |
| Verification read budget     | Existing 8 MiB, including required headroom |
| Raw and normalized artifacts | Existing 64 MiB and 4 MiB                   |
| Parser JSON structure        | 500,000 nodes; existing depth limit 48      |
| Input PDF                    | Existing 16 MiB                             |

The 256-count budget accommodates page fragmentation within the 1 MiB text
budget. A larger byte target could exceed the embedding provider token limit
on dense or unusual text. The current OpenAI embeddings API documents an
[8,192-token input limit](https://developers.openai.com/api/reference/ruby/resources/embeddings/methods/create). Retain the smaller target and expand the parsed
embedding manifest budget consistently.

Keep existing per-row limits and general inline-ingestion limits. Enforce actual per-row serialized sizes during staging. Enforce the 4 MiB
aggregate at sealing and activation for the new page-locator profile. Staging
remains bounded by row sizes and counts; an aggregate failure publishes nothing.
Older item/table profiles retain their previous aggregate rules. A profile must reject output beyond its own declared limits, even if a
newer profile permits more. No silent truncation or partial activation.

## Cross-page text

For a raw text item with ordered, nonoverlapping spans on multiple pages, retain
the full exact provenance list in every derived slice. Record the selected
provenance-index interval and raw item codepoint interval. Permit only explicit
Unicode White_Space in uncovered intervals. Assign inter-page separator whitespace
consistently and verify the complete slice inventory, including order, without
omissions or duplicates. Existing normalization rules still apply; the archived
raw artifact preserves the original text.

## Processing resources

The measured result supports retaining bounded conversion of the whole document. The production defaults are 1,800 seconds of CPU
per process (including its threads), a 600-second sandbox process-group wall
limit, 8 GiB sampled process-tree RSS and a 480-second Docling timeout. Docling
remains configured for four threads. Network denial, output limits, process-count
monitoring and precise failure codes remain enforced.

A 57-page private pilot document completed with this policy in 185,651 ms and
4,444,389,376 bytes peak RSS. These measurements used a 32 GiB machine with ten logical CPU cores; they are
not performance guarantees for other hardware. Unsupported documents still fail
explicitly; limits are not removed or retried indefinitely.

The timeout changes the parser fingerprint. Extraction code and the v2 mapping
configuration change the extraction identity. Existing durable artifacts with the
old timeout remain inspectable. Incomplete work cannot silently continue with a
new parser identity; profile transitions remain governed by P2-15. Local parsing
occurs before cloud job reservation, so the longer conversion does not hold a
cloud processing lease.

The JSON node limit is 500,000 rather than 50,000. A modest-size pilot artifact
exceeded the previous structural limit. Raw/bundle byte limits and depth 48 remain
unchanged, and node-limit failures are distinguished from depth-limit failures.

## Acceptance

- Synthetic maximum-size Unicode and fragmented-page fixtures fit all count,
  row, aggregate-byte and read budgets. Over-limit fixtures fail explicitly.
- Raw segment, slice inventory, page/hash, quote/range and artifact tampering
  fail validation. Cross-page chunks remain forbidden.
- Staging, sealing, activation, retry and archived replay preserve one document
  and exact citations. Previous generations remain readable.
- Compare retrieval and citation behavior with the previous chunk policy using
  synthetic documents. The chunk target is a bounded initial policy,
  not a claim of optimal retrieval quality.
- Repeat the private PDF pilot locally and separately report parser acceptance,
  mapper admission and citation spot-checks. Verify originals are unchanged.
- Complete independent review, all four repository checks and development-first
  hosted tests before release. Owner publication still requires the independent
  backup and key-recovery setup.

The embedding manifest remains bounded across the whole space. Resumable
manifest construction and historical vector cleanup remain P2-6 work before
bulk ingestion; exceeding the bound must report unavailable semantic coverage
while preserving keyword access.

This work does not change the independent financial archive implementation.

## Verification in progress

Independent backend and pipeline review resolved legacy-profile limit regressions.
Development HTTP staging, sealing, activation and exact retries passed for a
64-page, 1 MiB fixture containing 191 chunks and evidence spans. It remained one
searchable document. Reads returned all retained text with a matching hash and
reported partial citations when the existing citation output budget was reached.
Synthetic fixtures were forgotten and their credentials removed afterward.

Offline remapping of seven retained pilot outputs passed with zero mapping gaps;
13 selected invoice fields remained unchanged. A fresh complete parser replay and
the final repository checks remain release gates.

A synthetic comparison used three pages, seven segments and 26,563 UTF-8 bytes.
Both chunk policies produced five chunks with identical text, ranges and hashes.
Seven exact-query hit sets matched. Current page/range evidence reconstructed all
seven query quotes, including one across a segment separator; legacy item evidence
reconstructed six individually. A query crossing an 8 KiB chunk boundary missed
under both policies. This demonstrates unchanged search inputs and the bounded
citation improvement, not an optimal chunk policy or a live ranking comparison.

Source completeness remains a separate pilot gate. A worksheet in the private
corpus lost visible fields in Docling's raw output even though all retained text
mapped correctly. Capacity and citation validation cannot establish that every
source field was extracted. A bounded alternative extraction experiment is tracked
separately; owner trial readiness must report and resolve that gap.
