# @repo/epic-feed

An unattended daily pull of a household's Epic MyChart records into Postgres:
one SMART on FHIR authorization per person (the owner, and family members
through the owner's own proxy access in MyChart), every record carrying the
person it belongs to. See
[`docs/plans/2026-09-22-simplification-and-feeds.md`](../../docs/plans/2026-09-22-simplification-and-feeds.md),
order of work items 4 and 5, for why this exists, and
[`docs/onboarding.md`](../../docs/onboarding.md)'s "Health records with Epic
MyChart" section for registering the app at fhir.epic.com.

Two commands:

| Command                                             | What it does                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `kith-epic-feed authorize --person <id-or-name> [--org "<health system>"] [--sandbox]` | One SMART standalone launch (PKCE) for one person, ending in a Keychain item and a `kith.health_sources` row. |
| `kith-epic-feed pull`                                | For every linked source: refreshes its token, fetches `Patient` and every incoming resource type, upserts into Postgres.      |

## One-time setup

1. **App registration.** Registered at fhir.epic.com as a patient-facing,
   confidential client (client secret, not a certificate), SMART on FHIR R4,
   SMART v1 scopes, refresh tokens enabled. Redirect URIs:
   `https://brain.hive-mind.com/api/epic/callback` (production -- the page
   there only displays the returned code and state for pasting into the
   terminal; it does not authenticate or store anything) and
   `http://localhost:8766/callback` (sandbox, unused by this CLI's own flow
   since `authorize` prompts for a pasted code rather than running a local
   server, but registered to match the app's configuration). Client IDs are
   public values, not secrets:

   | Environment | Client ID |
   | --- | --- |
   | Production | `59762e7c-760c-4cbe-89d8-3bfd8906d828` |
   | Non-production (sandbox) | `9860f2e0-b9c5-4c42-8bdf-8a04cdf9852d` |

   These are the built-in defaults; override with `EPIC_CLIENT_ID` or a
   Keychain item when a different registration is used.

2. **Client secret.** Add a Keychain item (never commit this):

   ```sh
   security add-generic-password -a "$USER" -s com.kithmind.epic.client-secret -w <secret>
   ```

   `EPIC_CLIENT_SECRET` overrides the Keychain if set.

3. **Database.** `DATABASE_URL` overrides; otherwise this reads the same
   `com.kithmind.deferred-work.database-url` Keychain item
   `@repo/plaid-feed` reads (see that package's own README and
   `docs/worker-service.md`, "Deferred work daemon").

4. **Environment.** `EPIC_ENV` is `sandbox` or `production`, defaulting to
   `production`. `authorize --sandbox` forces sandbox for that one call
   regardless of `EPIC_ENV`.

## Keychain items

| Item | Holds |
| --- | --- |
| `com.kithmind.epic.client-id` | Production client id (optional; falls back to the public default above). |
| `com.kithmind.epic.client-id-nonprod` | Sandbox client id (optional; falls back to the public default above). |
| `com.kithmind.epic.client-secret` | The client secret. Required (no built-in default -- a secret is never public). |
| `com.kithmind.epic.token.<person-slug>` | One person's refresh token, access token, expiry, patient FHIR id, FHIR base and org name, as JSON. Written by `authorize`, read and rewritten by `pull`. |
| `com.kithmind.deferred-work.database-url` | The Postgres connection string (shared with `@repo/plaid-feed`). |

## `authorize`

```sh
kith-epic-feed authorize --person <kith_id-or-name> [--org "<health system name>"] [--sandbox]
```

1. Resolves `--person` to a `kith.entities` row of kind `person` (exact
   `kith_id`, then an exact canonical-name or alias match; ambiguous names
   are refused, asking for the `kith_id` instead).
2. In production, looks up `--org` (required) by name against Epic's public
   R4 endpoint directory (`https://open.epic.com/Endpoints/R4`), fetched
   fresh at authorize time -- this repository never vendors that list. In
   sandbox, `--org` is optional and defaults to Epic's own public sandbox
   FHIR base.
3. Discovers the authorize/token endpoints from
   `<fhir-base>/.well-known/smart-configuration`, falling back to
   `/metadata`'s `oauth-uris` extension.
4. Builds a standalone SMART launch URL with PKCE (S256) and an anti-CSRF
   `state`, requesting `openid fhirUser offline_access launch/patient` plus
   `patient/<Resource>.read` for every incoming resource (Patient,
   Observation, DiagnosticReport, Condition, MedicationRequest,
   AllergyIntolerance, Immunization, Encounter, Procedure, DocumentReference,
   Binary, Specimen, Goal), `aud` pinned to the FHIR base.
5. Prints the URL, then prompts `Paste the code shown by the callback page:`
   -- accepts either the bare code or the full pasted callback URL (the
   production callback page shows both the code and the state to copy).
6. Exchanges the code at the token endpoint with HTTP Basic client
   authentication and the PKCE code verifier, then writes the result to
   `com.kithmind.epic.token.<person-slug>` and upserts
   `kith.health_sources`.

Nothing here ever prints a secret, a token, or patient data -- only the
authorization URL (a public value) and a confirmation line.

## `pull`

```sh
kith-epic-feed pull
```

For each linked source: refreshes the access token (an `invalid_grant`
response sets `needs_reauth_at` and reports -- it is never retried in this
process; run `authorize` again for that person), fetches `Patient` by id,
then pages through every other incoming resource type's search by patient
with `_count=200`, following `link[rel=next]`, retrying 429 and 5xx with
backoff. `DocumentReference`'s `Binary` attachment is fetched when its
content type is text, HTML, RTF or PDF; text and HTML get their text
extracted, RTF and PDF are stored as bytes under
`~/.local/share/kithmind/health/<person-slug>/` with no text extraction yet.

```
epic pull source=... org="Synthetic Health System" status=ok documents=1 Patient=1 Observation=42 DiagnosticReport=6 Condition=3 MedicationRequest=5 AllergyIntolerance=2 Immunization=8 Encounter=11 Procedure=4 Goal=0 Specimen=6 DocumentReference=3
```

Only counts are ever printed -- never a value, a diagnosis, a medication
name or a note's text. Exits non-zero when any source needed reauth, failed
outright, or had a resource-type fetch error.

## Tables (migration `053_health_feed.sql`)

| Table | Holds |
| --- | --- |
| `kith.health_sources` | One row per (person, health system): the Keychain pointer, the granted scopes, `patient_fhir_id`, and pull/reauth state. |
| `kith.health_records` | One row per (source, resource type, FHIR id): the mapped fields (`effective_at`, `status`, `code_display`, `value_text`/`value_number`/`value_unit`, `category`, `encounter_fhir_id`) plus the raw resource as `jsonb`. |
| `kith.health_documents` | One row per `DocumentReference` whose attachment was fetched: content type, byte length, extracted text (text/HTML) or a storage note pointing at a file (PDF/RTF). |

The read surface (`packages/kith-store/src/admin/medicalRecords.ts` --
named that rather than `health.ts`, which already exists for ADM-2's
"System Health" screen) exports `listHealthOverview` and `listHealthRecords`
for the admin `/admin/medical` screen ("Health Records" in the nav) and the
`list_health_records`/`get_health_document` MCP tools.

## Sandbox test procedure

1. Set `EPIC_ENV=sandbox` (or pass `--sandbox` to `authorize`).
2. Run `kith-epic-feed authorize --person <a synthetic person's kith_id> --sandbox`.
3. When Epic's sandbox login page opens, sign in with one of Epic's own
   published sandbox test patients -- see
   [fhir.epic.com's "Test Patients" documentation](https://fhir.epic.com/Documentation?docId=testpatients)
   for the current published logins. Do not invent or guess credentials;
   only that page's own published values work against the sandbox.
4. Paste the code the callback shows, then run `kith-epic-feed pull` and
   confirm counts print for at least `Patient` and a few resource types.

## LaunchAgent (daily pull at 06:30)

Copy `com.kithmind.epic-feed.plist.example` into a real `.plist` under
`~/Library/LaunchAgents/`, replace every `ABSOLUTE/PATH/...` placeholder,
and `launchctl load` it.

## Tests

```sh
pnpm --filter @repo/epic-feed build
pnpm --filter @repo/epic-feed test:once
```

Unit tests (mocked `fetch`, no network, no Keychain, no database) cover
PKCE, endpoint discovery, the token exchange/refresh, `invalid_grant`
handling, the endpoint directory lookup, paging with `next` links, and every
resource mapper. One test (`test/sandboxDiscovery.test.mjs`) calls Epic's
real public sandbox `.well-known/smart-configuration`/`/metadata` once, to
prove discovery works against the live sandbox rather than only a mocked
fixture of it -- it skips cleanly with no network path to `fhir.epic.com`
(set `EPIC_FEED_REQUIRE_NETWORK=1` to turn that skip into a failure). One
Postgres test (`test/postgres.test.mjs`) starts and stops its own throwaway
local Postgres server (`initdb`/`pg_ctl` on `PATH`; skips cleanly without
them), seeds a synthetic person profile, upserts a mixed page of records
twice to prove idempotency, and asserts `@repo/kith-store`'s overview read
model.
