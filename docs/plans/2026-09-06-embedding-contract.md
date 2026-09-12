# Embedding provider and compatibility contract

Date: 2026-09-06

Status: P1-4 implementation contract. Profile activation is deployment-specific;
run the migration audit to verify an installation.

Parent: [Phase 1 implementation plan](./2026-09-06-phase1-brain-implementation.md)

## Purpose

Phase 1 retains the existing 1,536-dimensional embedding deployment while
making its compatibility identity explicit. A vector is usable only with the
embedding profile and generation that created it. Exact and keyword retrieval
remain available when semantic retrieval is unavailable.

The provider adapter accepts an OpenAI-compatible embeddings response. Tests
inject a mocked fetch implementation. Unit tests do not create credentials or make live provider calls.

## Provider configuration

| Environment variable         | Default                                | Contract                                                                                                                               |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAIN_EMBED_ENDPOINT`       | `https://api.openai.com/v1/embeddings` | Embeddings endpoint. HTTPS is required, except loopback HTTP during `development` or `test`. URLs containing credentials are rejected. |
| `BRAIN_EMBED_PROVIDER_ID`    | `openai`                               | Immutable provider identity. It is required for a custom endpoint.                                                                     |
| `BRAIN_EMBED_MODEL`          | `text-embedding-3-small`               | Immutable model identity. Slash-separated model identifiers are supported.                                                             |
| `BRAIN_EMBED_MODEL_REVISION` | `legacy-openai-small-1536-v1`          | Immutable model compatibility assertion. It is required for a custom endpoint or changed provider or model.                            |
| `BRAIN_EMBED_DIMENSIONS`     | `1536`                                 | Must remain `1536` while the current vector index is in use. Other values fail safely before a request.                                |
| `BRAIN_EMBED_API_KEY`        | none                                   | Optional bearer token for the configured endpoint.                                                                                     |

`legacy-openai-small-1536-v1` is a local declaration for compatibility with
the deployment's existing vectors. It is not a claim that an upstream OpenAI
model alias is pinned to a particular release. Operators must create a new
profile and generation when changing a provider, model, declared revision,
normalization, preprocessing, or dimensions.

The endpoint is operational routing data. It is not proof that two endpoints
produce compatible vectors. A custom endpoint therefore requires explicit
provider and revision declarations, even when it is intended to emulate the
baseline model.

## Authentication and request boundary

`BRAIN_EMBED_API_KEY` is sent only as a bearer token to the configured
endpoint. `OPENAI_API_KEY` is used only as a fallback when the endpoint is
exactly the official default endpoint. It is never forwarded to a custom
endpoint. The adapter rejects redirects so input is not forwarded to a new
location by a provider response.

Each request sends the configured model, input text, and dimensions. The
adapter accepts exactly one returned vector, checks the declared response model
when present, requires the configured length and finite numeric values, and
rejects all-zero vectors. Provider error bodies and credentials are not
returned to callers.

Current adapter bounds are 64 KiB of UTF-8 input, 1 MiB of response data, and
a 15-second request timeout. Empty input is rejected before a network request.
These are provider-request limits. A missing key for the official endpoint
fails locally before any query text is sent.

## Immutable profile identity

The canonical profile contains only these fields:

```ts
type EmbeddingProfile = {
  protocol: string;
  providerId: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  preprocessing: string;
};
```

The fingerprint is a SHA-256 digest of a versioned, fixed-position canonical
encoding of those fields. Endpoint URLs and authentication values are excluded.
This lets an operator explicitly declare compatible routing changes without
storing secrets in immutable profile metadata. A stored profile must recompute
the same digest at the trusted server boundary rather than accepting a
caller-supplied fingerprint.

## Versioned vectors and activation

The implementation stores vectors separately from legacy
thought rows. Each vector is scoped to a space and carries its fingerprint,
embedding generation, target identity, source input hash, and the fixed-size
vector. Existing `thought.embedding` values are retained as compatibility and
audit data. They are not semantic authority after versioned-vector cutover.

An embedding generation stages a complete server-derived manifest of eligible
current thoughts and active published chunks. Staging and activation must
recompute the manifest and compare its hash, eligibility epoch, target count,
input hashes, parent references, dimensions, and vectors. A manifest with a
missing, stale, duplicate, or extra vector cannot activate.

Activation flips a space's active profile and generation atomically only after
the whole manifest validates. Failed or partial staging leaves the existing
active profile and vectors unchanged. A new or changed target invalidates a
staged manifest through its eligibility epoch. The detailed table schema,
capacity limits, and migration commands are described below.

## Retrieval behavior

One configured provider profile is active for a request. Vector retrieval is
allowed only when every requested space has an active generation with the same
fingerprint as the configured profile. A mixed, missing, stale, or failed
space set uses keyword retrieval for the whole request and returns
`vectorStatus: "unavailable"`.

When compatible, the system creates one query vector and searches only vectors
filtered by a canonical `searchScope` encoding of space, fingerprint, generation,
and target kind. Convex vector filters have no AND operator, so one equality
comparison enforces the complete scope. It rechecks
authorization and active-generation state while resolving results. This keeps
incompatible fingerprints from mixing in a ranked result.

Document hybrid search uses bounded reciprocal-rank fusion with `k = 60`, a
keyword weight of `1`, and a semantic weight of `1.25`. It retains 32 candidates
from each source within the existing 64-candidate budget. This modest weighting
is a pilot-informed candidate policy for a hosted acceptance gate. It does not
select an embedding model or establish held-out retrieval quality.

Legacy vectors remain retained. If the corresponding compatible profile is
configured and active again, they can serve through their matching generation.
Changing the configured identity never reinterprets those vectors as vectors
from a new profile.

## Operational state

P1-4 is not a declaration that a production provider change has been made.
Any future model or dimensionality change requires a benchmarked migration,
development-first verification, a complete staged generation, and a reviewed
atomic activation. Exact and keyword search remain the fallback during provider
or vector-generation unavailability.

## Phase 1 bounds and maintenance

A staged generation supports a manifest of at most 256 eligible targets and
2 MiB of estimated input/vector bytes. The thought scan also stops after 256
rows, including history. Generation validation reads at most 256 vector rows.
This paragraph previously said 128 for the first two bounds. The code has used
256 since the pilot; the code is right and the stale number is corrected here.
Raising these bounds is P2-6 work, specified in the
[index capacity plan](./2026-09-12-index-capacity.md); its first
implementation PR replaces this paragraph.
These are conservative Phase 1 bounds, not a bulk ingestion capacity claim.
An overflow cannot activate a partial generation. Narrative capture requires a
complete active thought index for admission and duplicate detection. A capture
that would exceed the manifest bound rolls back with an explicit error. Source
publication and legacy writes can continue while marking vector coverage
unavailable; keyword retrieval remains available. Later bulk ingestion needs a
resumable manifest builder.

Source publication and forget operations update the embedding eligibility epoch
in the same database transaction. Forget immediately hides evidence, then removes
vectors and provenance in batches of at most 25 rows. It also invalidates any
staged embedding manifest. The active profile remains stored for audit. Source replacement removes obsolete
chunk vectors from the active embedding generation. Forget completion reconciles
coverage after deletion. Other stale extra vectors mark the affected target kind
unavailable until cleanup and reconciliation or a complete rebuild. Narrative transitions remove the previous thought from the active
vector generation while retaining vectors in retired profile generations.

Historical thoughts and source revisions remain available through explicit
historical keyword reads. The canonical semantic manifest includes current
thoughts and active source chunks. Semantic availability is not a claim that
historical records were searched by vectors or that event coverage is complete.

Operator-only Convex functions live under `models/embeddings/operator`:

1. `createGeneration` derives the manifest from the current space.
2. `getStagingManifest` returns bounded target IDs, input text, and hashes.
3. Embed those inputs with the matching configured provider. Submit batches of
   1 to 10 vectors with `stageVectorBatch`.
4. `stageGeneration` verifies complete coverage. `activateGeneration` compares
   the expected previous generation and flips the pointer atomically.
5. Use `failGeneration` to abandon a failed build, then start a fresh generation.

These are trusted operator functions, not public MCP tools. Their input text is
private data and must not be saved in public logs. Provider metadata remains
separate from credentials. A long-running automatic rebuild worker is later work.

The legacy baseline uses `models/embeddings/migrations`:
`prepareBaselineGeneration` supports dry runs; `backfillBaselineThoughtVectors`
is paginated and copies current thought vectors without a provider request;
`stageBaselineGeneration`, `activateBaselineGeneration`, and
`auditBaselineGeneration` complete and verify the migration. Prepare reuses an
existing active baseline on rerun. The preparation helper refuses spaces with
active chunks, because those chunks have no attributable legacy vector to
copy. Preparation and backfill both refuse a space when its bounded generation
history contains a non-baseline profile, including retired profiles after a
switchback, because the legacy thought field no longer has attributable
baseline provenance. Historical baseline generations remain auditable after
later profile changes. Future generation cleanup must preserve profile-use
evidence or permanently retire the legacy-copy path before deleting generation
history.
