# @repo/epic-feed

An unattended daily pull of a household's Epic MyChart records into Postgres:
one SMART on FHIR authorization per person (the owner, and family members
through the owner's own proxy access in MyChart), every record carrying the
person it belongs to. See
[`docs/plans/2026-09-22-simplification-and-feeds.md`](../../docs/plans/2026-09-22-simplification-and-feeds.md),
order of work items 4 and 5, for why this exists, and
[`docs/onboarding.md`](../../docs/onboarding.md)'s "Health records with Epic
MyChart" section for registering the app at fhir.epic.com.

Three commands:

| Command                                             | What it does                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `kith-epic-feed authorize --person <id-or-name> [--org "<health system>"] [--sandbox]` | One SMART standalone launch (PKCE) for one person, ending in a Keychain item and a `kith.health_sources` row. |
| `kith-epic-feed pull`                                | For every linked source: refreshes its token, fetches `Patient` and every incoming resource type, upserts into Postgres.      |
| `kith-epic-feed check [--org "<health system>"] [--sandbox]` | Diagnoses whether an organization has picked up this app's client ID, with no browser, no database and no Keychain token write -- see "`check`" below. |

## One-time setup

1. **App registration.** Registered at fhir.epic.com as a patient-facing,
   confidential client (client secret, not a certificate), SMART on FHIR R4,
   SMART v1 scopes, refresh tokens enabled. Redirect URIs:
   `https://brain.hive-mind.com/api/epic/callback` (production -- the page
   there only displays the returned code and state for pasting into the
   terminal; it does not authenticate or store anything) and
   `https://brain.hive-mind.com/api/epic/callback` for both environments (the sandbox rejected the localhost redirect; `EPIC_REDIRECT_URI` overrides it
   since `authorize` prompts for a pasted code rather than running a local
   server, but registered to match the app's configuration). Client IDs are
   public values, not secrets:

   | Environment | Client ID |
   | --- | --- |
   | Production | `59762e7c-760c-4cbe-89d8-3bfd8906d828` |
   | Non-production (sandbox) | `9860f2e0-b9c5-4c42-8bdf-8a04cdf9852d` |

   These are the built-in defaults; override with `EPIC_CLIENT_ID` or a
   Keychain item when a different registration is used.

2. **Client secret.** Epic issues a refresh token for an organization only
   when a client secret is configured for it (fhir.epic.com's app page:
   "select the key icon next to the organization... if you forgo adding
   client secrets, refresh tokens will be unavailable for that
   organization"), and recommends a distinct secret per organization and per
   environment. Add one Keychain item per organization, named after a slug
   of its `--org` name (lowercase, non-alphanumeric runs collapsed to a
   single hyphen, trimmed) -- e.g. for `--org "Virginia Mason Franciscan
   Health"`:

   ```sh
   security add-generic-password -a "$USER" \
     -s com.kithmind.epic.client-secret.virginia-mason-franciscan-health \
     -w <secret>
   ```

   `authorize --org N` and `pull` both look up a secret in this order: the
   organization's own item (`com.kithmind.epic.client-secret.<org-slug>`),
   then the shared item (`com.kithmind.epic.client-secret`, for a
   registration that uses one secret everywhere, or the sandbox), then
   `EPIC_CLIENT_SECRET`. `authorize` prints which one it used (never the
   value) as `Client secret: <item or env var name>`. No secret configured
   at all is not an error -- see `authorize` step 7 below, "falls back to a
   public-client request".

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
| `com.kithmind.epic.client-secret.<org-slug>` | That organization's own client secret, e.g. `com.kithmind.epic.client-secret.virginia-mason-franciscan-health` for `--org "Virginia Mason Franciscan Health"`. Checked first; see "Client secret" above. |
| `com.kithmind.epic.client-secret` | The shared client secret, used when no per-org item exists. No secret configured at all is not an error -- see `authorize` step 7 below, "falls back to a public-client request". |
| `com.kithmind.epic.token.<person-slug>.<org-slug>` | One person's refresh token (`null` if Epic did not grant one), access token, expiry, patient FHIR id, FHIR base, org name, and `clientAuth` (`"secret"` or `"public"` -- see `authorize` step 7), as JSON. Written by `authorize`, read and rewritten by `pull`. Suffixed by both person and organization -- e.g. `com.kithmind.epic.token.jamie-synthetic.virginia-mason-franciscan-health` -- so authorizing the same person at a second organization (say, Virginia Mason Franciscan Health and then Optum Care Washington through the owner's own MyChart proxy access) gets its own item instead of overwriting the first, matching `kith.health_sources`'s one row per (`person_id`, `fhir_base`). A token stored before `clientAuth` existed is treated as `"secret"`. A `keychain_service` column written before this org suffix existed is read as-is by `pull` (see "Keychain item migration" below) rather than renamed. |
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
3. Looks up the client secret for that org name (see "Client secret" above)
   and prints `Client secret: <item or env var name>` -- never the value.
4. Discovers the authorize/token endpoints from
   `<fhir-base>/.well-known/smart-configuration`, falling back to
   `/metadata`'s `oauth-uris` extension.
5. Builds a standalone SMART launch URL with PKCE (S256) and an anti-CSRF
   `state`, requesting `openid fhirUser offline_access launch/patient` plus
   `patient/<Resource>.read` for every incoming resource (Patient,
   Observation, DiagnosticReport, Condition, MedicationRequest,
   AllergyIntolerance, Immunization, Encounter, Procedure, DocumentReference,
   Binary, Specimen, Goal), `aud` pinned to the FHIR base.
6. Prints the URL, then prompts `Paste the code shown by the callback page:`
   -- accepts either the bare code or the full pasted callback URL (the
   production callback page shows both the code and the state to copy).
7. Exchanges the code at the token endpoint with HTTP Basic client
   authentication and the PKCE code verifier. Epic's sandbox has been
   observed to answer that Basic request with `invalid_client` for this
   app's registration regardless of the configured secret, treating it as a
   public client instead; on a 400/401 `invalid_client` response (or when
   no client secret is configured at all) the exchange retries once with no
   Authorization header and `client_id` in the form body. Whichever method
   succeeds is stored as `clientAuth: "secret" | "public"` alongside the
   token, and the same method is reused on every later refresh -- it is
   never re-probed. The result is written to
   `com.kithmind.epic.token.<person-slug>.<org-slug>` and
   `kith.health_sources` is upserted.
8. Prints `Authorized as <public|confidential> client; refresh token:
   <present|absent>`. If Epic did not grant a refresh token, a second line
   says the daily pull will need a new authorization once the access token
   expires; what was received is still stored either way.

Nothing here ever prints a secret, a token, or patient data -- only the
authorization URL (a public value) and confirmation lines.

## `pull`

```sh
kith-epic-feed pull
```

For each linked source: when a refresh token is on file, refreshes the
access token, using whichever client authentication method (`clientAuth`)
that source's stored token was obtained with -- it is never re-probed here,
only at `authorize` time (an `invalid_grant` response sets `needs_reauth_at`
and reports -- it is never retried in this process; run `authorize` again
for that person). When no refresh token is on file (Epic's sandbox has been
observed to issue an access token with no refresh token at all, and any
organization with no client secret configured never grants one at all --
see "Client secret" above), the stored access token is used directly as
long as it still has more than 60 seconds of life left, and the summary line
carries `note="access token only; expires in <n> minutes"`; otherwise the
source is marked `needs_reauth`, same as an `invalid_grant` refresh. Either
way, fetches `Patient` by id, then pages through every other incoming
resource type's search by patient with `_count=200`, following
`link[rel=next]`, retrying 429 and 5xx with backoff. `DocumentReference`'s
`Binary` attachment is fetched when its content type is text, HTML, RTF or
PDF; text and HTML get their text extracted, RTF and PDF are stored as
bytes under `~/.local/share/kithmind/health/<person-slug>/` with no text
extraction yet.

```
epic pull source=... org="Synthetic Health System" status=ok documents=1 Patient=1 Observation=42 DiagnosticReport=6 Condition=3 MedicationRequest=5 AllergyIntolerance=2 Immunization=8 Encounter=11 Procedure=4 Goal=0 Specimen=6 DocumentReference=3
epic pull source=... org="Epic Sandbox" status=ok documents=0 Patient=1 Observation=12 ... note="access token only; expires in 47 minutes"
```

Only counts (and, for an access-token-only source, the expiry note above)
are ever printed -- never a value, a diagnosis, a medication name or a
note's text. Exits non-zero when any source needed reauth, failed
outright, or had a resource-type fetch error.

### Keychain item migration

`pull` always reads and writes whatever name is stored in that source row's
`keychain_service` column -- it never recomputes a name from the person and
org and assumes the Keychain item lives there. A row written before
`tokenKeychainService` suffixed its item with the org slug still has the
older, person-only name (`com.kithmind.epic.token.<person-slug>`, with no
trailing `.<org-slug>`); `pull` detects that and checks whether an item
already exists under the newly suffixed name. If it does, `pull` uses that
one; if it does not (the common case until that person/org pair is
authorized again), `pull` keeps reading and writing the original, unsuffixed
name -- no rename. Running `authorize` again for that person and
organization is what moves a source onto the current, org-suffixed name (it
writes the new Keychain item and updates `keychain_service` together).

## `check`

```sh
kith-epic-feed check [--org "<health system name>"] [--sandbox]
```

Diagnoses whether an organization has picked up this app's client ID,
without ever opening a browser, writing to Postgres, or writing a Keychain
token item -- run it before `authorize` to avoid an ambiguous
`invalid_client` at the real token exchange, or any time later to check
whether a pending production activation has landed yet.

1. Resolves `--org` the same way `authorize` does (directory lookup by name
   in production, defaulting to Epic's own public sandbox FHIR base with
   `--sandbox`).
2. Discovers the token endpoint the same way `authorize` does.
3. Sends one `authorization_code` token request with a deliberately bogus
   code and the configured client secret (HTTP Basic), and a second one with
   no secret at all -- the same two shapes `authorize`'s real code exchange
   tries, but run independently here instead of one falling back to the
   other. Neither is expected to succeed; only the `error` each one returns
   is read.
4. Prints which Keychain item name (or env var) it used for the client ID
   and for the client secret -- never a secret value -- then a diagnosis:

   | Result | Diagnosis |
   | --- | --- |
   | `invalid_grant` on either attempt | The client ID is known at this organization; `authorize` should work. |
   | `invalid_client` on both attempts | Either the client ID has not reached this organization yet (Epic says up to a day, and organizations sync on their own schedule), or the wrong client ID is stored. |
   | `invalid_client` with the secret, `invalid_grant` without it | The client ID is known, but this organization's own client secret is not set or does not match. |

Nothing here ever prints a secret or touches `kith.health_sources` --
`check` reads and diagnoses only, it never links anything.

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
handling, the per-organization client secret lookup order, `orgSlug` and
`tokenKeychainService` (`test/config.test.mjs`), authorizing the same
person at two organizations into two distinct Keychain items and source
rows, the Keychain item migration path (a pre-org-suffix `keychain_service`
with and without an already-migrated item present), pulling with an access
token only (no refresh token, both the still-valid and the expired case),
the endpoint directory lookup, paging with `next` links, every resource
mapper, and `check`'s three diagnoses plus the no-secret-configured and
sandbox-default-org cases (`test/check.test.mjs`). One test
(`test/sandboxDiscovery.test.mjs`) calls Epic's
real public sandbox `.well-known/smart-configuration`/`/metadata` once, to
prove discovery works against the live sandbox rather than only a mocked
fixture of it -- it skips cleanly with no network path to `fhir.epic.com`
(set `EPIC_FEED_REQUIRE_NETWORK=1` to turn that skip into a failure). One
Postgres test (`test/postgres.test.mjs`) starts and stops its own throwaway
local Postgres server (`initdb`/`pg_ctl` on `PATH`; skips cleanly without
them), seeds a synthetic person profile, upserts a mixed page of records
twice to prove idempotency, and asserts `@repo/kith-store`'s overview read
model.
