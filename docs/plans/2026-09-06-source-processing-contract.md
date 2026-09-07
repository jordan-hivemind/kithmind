# Source processing contract

This document records the P1-3 storage and authorization contract. The Phase 1 plan defines the remaining ingestion transport, embeddings, typed records, and family settings work.

## Identity and permissions

A source account belongs to one space. Its connector and account ID identify the configured source; neither field stores credentials. Source items use that account plus the SHA-256 digest of a stable external ID. Locations and titles are metadata.

Web owners and editors can configure source accounts. An ingest API key must name both its allowed spaces and its allowed source accounts. The executing principal and the original submitting credential are checked again during processing. Revocation, membership changes, or disabling an account stop ingestion. Retained reads use current read and space grants, so disabling ingestion does not destroy evidence.

Existing non-ingest keys may omit `sourceAccountIds`; this means no ingest access. New non-ingest keys store an empty list. There is no source-account wildcard.

## Immutable content and publication

Source revisions hash the exact UTF-8 text. Re-observing identical bytes reuses the revision and preserves its original capture metadata; each admission retains its own actor audit. Extracted text versions, pages, spans, documents, and chunks preserve the inputs that produced an answer. Offsets are UTF-16 offsets, with spans relative to their page; split surrogate pairs are invalid. First publication seals page and span collections. Rechunking can reuse them, but changed evidence requires a new extraction fingerprint.

MCP receives decoded tool arguments. Request conflict detection therefore hashes a versioned canonical argument envelope, preserving text exactly. It does not claim to hash the original HTTP body.

Admission uses an expected desired-processing epoch. A matching prior receipt is returned before this comparison; a changed request under the same ID conflicts. Connectors must reconcile provider ordering before submission. A generic lexical ordering of provider revision strings is not used.

Publication requires a valid current lease, complete bounded staging, and the current desired revision and epoch. One mutation changes the active pointers, closes the old generation's interval, and advances the space activation epoch. Document and chunk publication markers are derived operational metadata; their content stays immutable. Search uses these markers and verifies parent pointers before returning content.

Failed replacement processing keeps the previous active evidence readable and marks it stale. Unavailable originals retain indexed evidence. Forgetting immediately hides evidence and invalidates processing, then removes stored payloads in bounded batches. A minimal identity tombstone prevents automatic reimport. Forgetting also invalidates older coverage windows for the source account, so deletion cannot turn a formerly complete inventory into a false negative answer.

## Bounds

| Boundary                      | Limit                                          |
| ----------------------------- | ---------------------------------------------- |
| Inline source text            | 65,536 UTF-8 bytes                             |
| Pages per generation          | 32                                             |
| Evidence spans per generation | 128                                            |
| Documents per generation      | 16                                             |
| Chunks per generation         | 128                                            |
| Chunk text                    | 16 KiB per chunk; 256 KiB total per generation |
| Staging call                  | 25 rows and 128 KiB of text                    |
| Cursor admission transaction  | 4 discoveries                                  |
| Worker lease                  | 5 minutes                                      |
| Worker attempts               | 8                                              |
| Read result limit             | 25                                             |

Bounded reads expose partial or truncated status instead of claiming exhaustive results. Coverage requires fresh covering windows without relevant gaps or unfinished work. A keyword search with no results does not establish that no event occurred.

## Client boundary

`search_documents`, `get_document`, and `list_sources` read hosted indexed information. Results distinguish retained evidence, original availability, stale content, and historical revisions. A client can use this evidence while the original file or local worker is offline. Native mobile connector support remains a separate P2 priority.

P1-3 provides processing primitives and read tools. Public `ingest_text`, the worker pipeline, semantic document embeddings, and exact typed record queries belong to subsequent tasks. Existing facts and narrative capture remain available.
