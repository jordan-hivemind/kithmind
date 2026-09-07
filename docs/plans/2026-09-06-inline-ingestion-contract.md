# Bounded text capture

Phase 1 accepts text that a caller already has. It retains the exact UTF-8
content and evidence in the cloud, so indexed answers do not depend on the
original file or a running desktop worker. It does not extract medical or
financial records from prose. Those typed records require a future extractor
using the existing evidence and publication boundary.

## Text endpoint

Send `POST /api/ingest` with `Authorization: Bearer <key>` and
`Content-Type: application/json`. The key needs the `ingest` capability, access
to the destination space, and an explicit grant for the configured source
account. A read or write grant alone does not permit ingestion.

```json
{
  "requestId": "synthetic-capture-1",
  "expectedDesiredProcessingEpoch": 0,
  "source": {
    "connector": "mcp-client",
    "accountId": "desktop-capture",
    "externalId": "synthetic-note-1",
    "capturedAt": "2026-09-06T18:00:00Z"
  },
  "title": "Synthetic service note",
  "text": "The synthetic vehicle received an oil change on 2026-09-01.",
  "docType": "vehicle-service"
}
```

Supply `spaceId` to select a destination explicitly. Otherwise the user's
configured default destination applies, with Personal as the initial default.
The server checks current access before accepting the request. It never creates
a source account from an untrusted request.

All strings must contain well-formed Unicode and must not be whitespace-only.
`source.uri` is optional; omitted `docType` defaults to `generic`. `capturedAt`
must be an RFC3339 instant with an explicit known timezone offset and at most
three fractional second digits. The unknown offset `-00:00` is rejected.

Keep `source.externalId` stable across changes to the same source. Start with
`expectedDesiredProcessingEpoch: 0`. A response returns `desiredProcessingEpoch`; use
it for a later replacement with a new request ID. A stale epoch is a conflict.
This prevents a delayed capture from overwriting a newer correction.

For an interrupted response, repeat the original request ID and every original
argument, including the original epoch. A matching receipt resumes or returns
the accepted work. Different arguments under that request ID are a conflict.
A retry of an older successful request does not restore its historical content.
Inspect `isActive` and the current epoch in the response. A new accepted epoch
creates a distinct processing generation, including when text returns to an
earlier value or only document metadata changes. Reused exact bytes retain the
original immutable revision capture timestamp.

The response includes source item, immutable revision, processing generation,
and job IDs. A published result includes a document ID. State is `ready`,
`queued`, `needs_review`, or `failed`. `queued` means durable work remains;
it does not mean the source is searchable yet. Only complete generations become
visible. A prior active generation remains available while its replacement is
being processed.

`ready` returns HTTP 200. `queued` and `needs_review` return HTTP 202. An admitted
job that reports `failed` returns HTTP 500 with its IDs and state, so retain the
request identity rather than inventing a new one.

Rejected requests return `{ "error": { "code": "...", "message": "..." } }`.

| HTTP status | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| 400         | Invalid request fields or JSON                               |
| 401         | Missing, invalid, or revoked credential                      |
| 403         | Destination or source access denied                          |
| 409         | Request identity, source epoch, or source lifecycle conflict |
| 413         | Body or source text exceeds the byte limit                   |
| 415         | Unsupported content type                                     |
| 429         | Admission rate limit exceeded                                |
| 500         | Unexpected processing failure                                |
| 503         | Authentication or ingestion service unavailable              |

When delivery is uncertain, retry the original request unchanged. Resolve a
409 conflict before making a new replacement request. A `needs_review` job
requires explicit operator repair; repeated calls do not override that state.

## Limits and processing

| Boundary                     | Limit or behavior                                                   |
| ---------------------------- | ------------------------------------------------------------------- |
| Encoded JSON body            | 512 KiB, enforced while streaming before JSON parsing               |
| Account identity             | 512 UTF-8 bytes, matching source configuration                      |
| Request identity             | 128 UTF-8 bytes                                                     |
| External identity and URI    | 2,048 UTF-8 bytes each                                              |
| Text title and document type | 200 and 100 UTF-16 code units, respectively                         |
| Decoded source text          | 65,536 UTF-8 bytes; empty and malformed Unicode rejected            |
| Text representation          | One immutable text page with exact retained offsets                 |
| Chunking                     | At most 2,048 UTF-8 bytes per code-point-safe chunk                 |
| Processing                   | Bounded batches with leases and fencing; durable retry recovery     |
| Admission rate               | 60 new requests per credential per minute; matching receipts exempt |
| Search                       | Retained text and keyword chunks available after activation         |
| Semantic vectors             | Unavailable until compatible vectors are populated                  |
| Typed extraction             | No model extraction in this phase                                   |

The chunk size is a bounded initial implementation recorded in the processing
fingerprint. It is not a measured recommendation for every document corpus.
Automatic embedding scheduling and parser evaluation belong to the Phase 2
worker. Existing compatible embedding-generation operators remain available.

Workers retain the admitting actor's identity. Every processing mutation
rechecks current permissions. Revoking that credential or its membership blocks
publication. A recovery process cannot silently replace it with an administrator.
An authorized operator can explicitly replace the actor and requeue the job;
that repair also restores its durable recovery entry. Failed or exhausted work
is reported in source status rather than being treated as successfully indexed.

## URL queue

The `ingest_url` MCP tool accepts a request ID, optional space ID, the same
configured source identity (without `capturedAt`), an HTTP(S) URL, and an
optional title. The title belongs to the queued request until it is fetched;
source inventory may therefore show an untitled item. URLs with embedded
credentials are rejected.

It returns `state: "queued"` and `workerRequired: true`. The URL is stored as a
fetch request, not as invented source text or an indexed document. Phase 1 does
not fetch, follow redirects, download files, or make model calls. Queued URLs
count as pending work in source status and coverage. Forgetting the source
removes those queued requests along with its retained content.

A later fetch worker must add redirect, private-network, content-size, and
credential defenses before it performs any URL requests.
