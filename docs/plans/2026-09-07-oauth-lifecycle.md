# OAuth grant lifecycle and key management

**Date:** 2026-09-07

**Status:** Implemented under P1-10. Deployment acceptance is recorded in the work tracker.

## Problem

Before this change, consent created an active API key before the authorization code is delivered. A crash or lost response could leave an unused permanent key, and repeating consent could create another. The Settings key query also loaded the user's entire key collection.

## Required behavior

- A grant being prepared or awaiting exchange cannot authenticate normal MCP requests, ingestion, or other credential-authorized operations.
- Unfinished grants expire. Cleanup reads and deletes bounded batches, and authorization enforces expiry even when cleanup has not run.
- Repeating the same uncompleted consent request returns the same grant and code. Concurrent requests and a crash between preparation and finalization cannot create multiple active credentials.
- Token exchange validates the registered client, exact redirect, resource, PKCE proof, grant expiry, live user, current membership, and granted capabilities. Activation and code consumption commit atomically.
- Authorization codes remain single-use. A lost token response does not turn a consumed code into a reusable credential. The client must begin a new authorization request. Replay handling follows [RFC 6749 section 4.1.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2), including denial and revocation of the associated issued token after a validated replay. Invalid client or PKCE proof cannot revoke a credential.
- Any identity used only for grant exchange is rejected by normal MCP authorization. It cannot be used as a shortcut around live key checks.
- Settings lists active credentials in bounded pages and allows revocation from every page. Unfinished grant material and encrypted authorization codes are not displayed.
- Existing active keys retain their hashes, ownership, and scopes. Additive schema changes and any required migration are verified in development before production.

## Stored lifecycle and limits

| State         | Behavior                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Preparing     | Inert credential with a 30-second preparation lease and nonce fencing. A crashed preparation can be replaced after its lease expires. |
| Pending       | Inert credential with the finalized encrypted code. Exact consent retries return that code.                                           |
| Active        | All lifecycle fields are absent. This also describes existing credentials, so no key backfill is needed.                              |
| Consumed code | A receipt prevents another exchange or silent reissue for the same consent request until the code expires.                            |

Unfinished grants expire five minutes after preparation starts. Each user can have at most 20 live unfinished grants, independently of the number of active keys. Cleanup runs every five minutes with a default batch of 100 and a maximum of 200. A full batch reports that another pass may be needed. Expiry checks do not depend on the cleanup schedule.

Consent identity includes the client, redirect, canonical resource, PKCE challenge, state, scope, key name, and sorted capabilities and spaces. Activation rechecks the live account and access to each space. A read/write credential still obeys the member's current role in each space; it does not upgrade a reader to an editor.

Settings loads 25 active keys at a time and supports revocation from every loaded page. The API accepts page sizes from 1 through 50. The legacy list endpoint rejects collections above 100 instead of silently returning an incomplete list.

## Deployment and audit

The additive schema preserves existing active keys without rewriting their hashes or scopes. Authorization codes issued by the previous implementation lack the new binding fields. An in-flight authorization at deployment may therefore need to restart during its five-minute code lifetime. Existing bearer credentials continue to work.

Run the read-only lifecycle audit in development before production:

```sh
pnpm --filter @repo/db exec convex run --deployment dev models/apiKeys/migrations:auditOAuthLifecycle '{"batchSize":100}'
```

Continue with the returned cursor until `isDone` is true. Every page must report zero invalid rows. Use `--deployment prod` for the production audit after deployment. This audit does not migrate or delete records.

## Verification

Use synthetic accounts and credentials. Cover concurrent and repeated consent, abandoned preparation, expired pending grants, atomic activation, invalid PKCE and client binding, consumed-code replay, revocation and membership changes before activation, exchange-only identity rejection, bounded cleanup, and multiple pages of active keys.

Run the repository's four checks before review. Security-sensitive changes receive an independent second-model review. Deployment verification exercises the actual hosted authorization and MCP endpoints with a temporary credential, removes temporary verification state, and audits preservation of existing content and credentials.

## Scope

This work does not add a new identity provider, refresh-token grant, native mobile compatibility promise, or document connector. It preserves the existing externally visible authorization-code flow while tightening its stored credential lifecycle.
