# Web and MCP surface on PostgreSQL

Date: 2026-09-16. Status: P2-39i design plan. No implementation lands with this
document.

Parent: [PostgreSQL consolidation](./2026-09-12-postgres-consolidation.md),
row P2-39i of section 6.
Related: [architecture](./2026-09-06-architecture.md) sections 3.1 and 8,
[OAuth grant lifecycle](./2026-09-07-oauth-lifecycle.md),
[scoped credentials](../migrations/scoped-credentials.md),
[personal spaces](../migrations/personal-spaces.md).

Row i moves `apps/web` off Convex and onto `@repo/kith-store`. It adds no
domain logic. Where a service function does not yet exist on the PostgreSQL
side this plan names it and says which row owes it rather than inventing one.

Every count below is from the tree at `b84314f`. Section 6 of the parent plan
counts 12 routes, 28 tools, 10 pages and 14 hook files. Three of those are
stale after P2-39l: the tree has 17 tools, 9 pages and 12 hook files.

## 1. Inventory

### 1.1 Route handlers, 12

| Route                                           | Backend today                                                                              | Target                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `app/.well-known/mcp-jwks.json/route.ts`        | `getPublicMcpJwk`                                                                          | Deleted with the JWT bridge                                                                                          |
| `app/api/ingest/route.ts`                       | `api.models.ingestion.inlineMcp.ingest`                                                    | Inline ingest service, missing, see 1.5                                                                              |
| `app/api/mcp/authorize/route.ts`                | none, 7-line redirect                                                                      | Unchanged                                                                                                            |
| `app/api/mcp/authorize/complete/route.ts`       | `convexAuthNextjsToken`, `api.models.oauth.web.{begin,finalize,abandon}AuthorizationGrant` | `identity.{beginAuthorizationGrant,finalizeAuthorizationGrant,abandonAuthorizationGrant}` plus `requireWebPrincipal` |
| `app/api/mcp/discovery/route.ts`                | none, reads `tool-policy.ts`                                                               | Unchanged                                                                                                            |
| `app/api/mcp/health/route.ts`                   | none, reads `environment.ts`                                                               | Variable list changes, see 3.4                                                                                       |
| `app/api/mcp/oauth-metadata/route.ts`           | none                                                                                       | Unchanged                                                                                                            |
| `app/api/mcp/oauth-protected-resource/route.ts` | none                                                                                       | Unchanged                                                                                                            |
| `app/api/mcp/register/route.ts`                 | none                                                                                       | Unchanged                                                                                                            |
| `app/api/mcp/route.ts`                          | `authenticateApiKey`, `createConvexMcpToken`, `createMcpServer`                            | `identity.authenticateApiKey` in the route, no token, see 3                                                          |
| `app/api/mcp/token/route.ts`                    | `createConvexMcpToken`, `api.models.oauth.mcpMutations.activateAuthorizationGrant`         | `identity.{requireOAuthExchangeIdentity,activateAuthorizationGrant}`                                                 |
| `app/api/worker/route.ts`                       | `api.models.workers.mcp.dispatch`                                                          | `workers.handlePostgresWorkerRequest`, already written                                                               |

Five routes reach a backend. One is deleted. Six are unchanged.

### 1.2 MCP tools, 17

Capability is the `tool-policy.ts` annotation class, which is a host risk hint,
not a grant. The authority a call actually needs is the `Capability` in
`src/identity/authorization.ts` (`read`, `write`, `ingest`), shown in the third
column and enforced by `getAuthorizedReadSpaceIds` or `requireSpaceAccess`.

| Tool                | Policy class       | Capability | Convex function today                  | kith-store target                                                                |
| ------------------- | ------------------ | ---------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `list_spaces`       | readOnly           | read       | `spaces.mcpQueries.list`               | `identity.listSpaces` (`identity/spaces.ts`)                                     |
| `query_records`     | readOnly           | read       | `records.queryMcp.run`                 | `records.executeRecordQuery` (`records/query.ts`)                                |
| `search_documents`  | readOnly           | read       | `documents.mcpActions.search`          | `embeddings.searchChunkAndCardVectorCandidates` then `documents.searchDocuments` |
| `get_document`      | readOnly           | read       | `documents.mcpQueries.get`             | `documents.getDocument`                                                          |
| `ingest_url`        | idempotentAdditive | ingest     | `ingestion.urlQueue.enqueue`           | Missing, see 1.5                                                                 |
| `list_sources`      | readOnly           | read       | `documents.mcpQueries.listSources`     | `documents.listSources`                                                          |
| `list_inventory`    | readOnly           | read       | `documents.mcpQueries.listInventory`   | `documents.listInventory` (`documents/inventory.ts`)                             |
| `list_review_queue` | readOnly           | read       | `records.mcpQueries.listReviewQueue`   | `records.listReviewQueue` (`records/reviewQueue.ts`, i3)                         |
| `search_facts`      | readOnly           | read       | `facts.mcpQueries.search`              | `embeddings.searchFacts` (`embeddings/search.ts`)                                |
| `remember_fact`     | idempotentAdditive | write      | `facts.mcpActions.remember`            | `memory.rememberFact` (`memory/facts.ts`)                                        |
| `search_thoughts`   | readOnly           | read       | `thoughts.mcpActions.searchWithStatus` | `embeddings.searchThoughtsHybrid`                                                |
| `recall_context`    | readOnly           | read       | five calls across facts and thoughts   | `embeddings.recallCandidates` then `memory.recallContext`                        |
| `browse_recent`     | readOnly           | read       | `thoughts.mcpQueries.listByUser`       | `memory.listBySpaces` (`memory/thoughts.ts`)                                     |
| `get_thoughts`      | readOnly           | read       | `thoughts.mcpActions.getByIds`         | `memory.getThoughtsByAuthorizedIds`                                              |
| `timeline_thoughts` | readOnly           | read       | `thoughts.mcpActions.timeline`         | `memory.listAroundTime` (`memory/timeline.ts`, i3)                               |
| `get_stats`         | readOnly           | read       | `thoughts.mcpQueries.getStats`         | `memory.computeSpaceStats` (`memory/stats.ts`, i3)                               |
| `capture_thought`   | idempotentAdditive | write      | `thoughts.mcpActions.capture`          | `memory.captureThought`                                                          |

`query_records` also serves the finance archive when `query.provider` is
`finance_archive`. That leg already runs on PostgreSQL through
`apps/web/src/lib/mcp/finance.ts` and does not change, except that its
`authorizedSpaceIds` stops coming from a Convex query. See 4.4.

### 1.3 Pages, 9, and layouts, 2

| File                                           | Convex use                                                          | Target                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/layout.tsx`                               | `ConvexAuthNextjsServerProvider`                                    | Provider removed                                                                                                                                                    |
| `app/ConvexClientProvider.tsx`                 | `ConvexReactClient`, `ConvexAuthNextjsProvider`                     | Deleted                                                                                                                                                             |
| `app/(authenticated)/layout.tsx`               | `useAuthActions`, `Authenticated`, `AuthLoading`, `Unauthenticated` | Server component, session read in the layout, `POST /api/auth/sign-out`                                                                                             |
| `app/(authenticated)/page.tsx`                 | `thoughts.public.getStats`, `thoughts.public.listRecent`            | `memory.listBySpaces`, stats missing, see 1.5. Live surface, see 5                                                                                                  |
| `app/(authenticated)/browse/page.tsx`          | `facts.public.listRecent`                                           | `memory.listFacts`                                                                                                                                                  |
| `app/(authenticated)/settings/page.tsx`        | 9 hooks over apiKeys, spaces, sourceAccounts                        | `identity.listApiKeysPage`, `createApiKey`, `revokeApiKey`, `listSpaces`, `getSettings`, `setDefaultWriteSpace`, `ensurePersonal`. Source accounts missing, see 1.5 |
| `app/(authenticated)/spaces/page.tsx`          | none, renders `FamilySpaceManager`                                  | Unchanged                                                                                                                                                           |
| `app/(authenticated)/getting-started/page.tsx` | none                                                                | Unchanged                                                                                                                                                           |
| `app/invite/page.tsx`                          | none, renders `InvitationAcceptance`                                | Unchanged                                                                                                                                                           |
| `app/mcp/authorize/page.tsx`                   | `useAuthActions`, `Authenticated` gates                             | Session gate plus `SpaceGrantPicker`                                                                                                                                |
| `app/sign-in/page.tsx`                         | none, 11 lines                                                      | Form posts to `/api/auth/sign-in`                                                                                                                                   |
| `app/sign-up/page.tsx`                         | none, 11 lines                                                      | Form posts to `/api/auth/sign-up`                                                                                                                                   |

### 1.4 Files using Convex React hooks, 12

`grep -rl "convex/react\|useQuery\|useMutation\|useAction" apps/web/src` returns 12. `app/layout.tsx` uses the server provider and is not in that 12, so 13 files
import Convex on the UI side.

| File                                            | Hooks                               | Slice                   |
| ----------------------------------------------- | ----------------------------------- | ----------------------- |
| `app/(authenticated)/layout.tsx`                | auth gates                          | i1                      |
| `app/(authenticated)/page.tsx`                  | 2 queries                           | i5                      |
| `app/(authenticated)/browse/page.tsx`           | 1 query                             | i5                      |
| `app/(authenticated)/settings/page.tsx`         | 3 queries, 1 paginated, 5 mutations | i5                      |
| `app/ConvexClientProvider.tsx`                  | provider                            | i1                      |
| `app/mcp/authorize/page.tsx`                    | auth gates                          | i2                      |
| `components/family-space-manager.tsx`           | 3 queries, 9 mutations, 1 action    | i5                      |
| `components/invitation-acceptance.tsx`          | 1 mutation                          | i5                      |
| `components/space-grant-picker.tsx`             | 1 query, 1 mutation                 | i2                      |
| `components/worker-heartbeat-status.tsx`        | 1 query                             | i6, live surface, see 5 |
| `features/thoughts/components/QuickCapture.tsx` | 1 action                            | i5                      |
| `features/thoughts/components/ThoughtsView.tsx` | 1 query, 1 action                   | i5                      |

`lib/family-api.ts` is two re-exports of Convex API handles. It is deleted and
its callers import the route paths instead.

### 1.5 What PostgreSQL does not have yet

| Missing                                                                                                                                               | Needed by                          | Owed by                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thought space stats digest (`_computeSpaceStats`)                                                                                                     | `get_stats`, dashboard             | Landed in i3 as `memory/stats.ts` `computeSpaceStats`, over P2-39g2's `readSpaceCounters`. Question 4 adopted                                                                             |
| Thought embedding writes on capture and transition (`markEligibilityTargets`, `bumpEmbeddingEligibilityEpoch`, `deleteActiveThoughtEmbeddingVectors`) | `capture_thought`, `remember_fact` | Landed in P2-39g2 (PR 237), wired in `memory/thoughts.ts`. Capture writes no vector by design; the fill covers the owed target through `insertThoughtEmbedding` in `embeddings/write.ts`  |
| Thought timeline                                                                                                                                      | `timeline_thoughts`                | Landed in i3 as `memory/timeline.ts` `listAroundTime`                                                                                                                                     |
| Record review queue (`models/records/reviewQueue.ts`)                                                                                                 | `list_review_queue`                | Landed in i3 as `records/reviewQueue.ts` `listReviewQueue`                                                                                                                                |
| Inline ingest admit, process, result                                                                                                                  | `/api/ingest`                      | Landed in P2-39e2. `admitInlineWork`, `processInlineWork`, `getInlineIngestResult` and the composed `ingestInlineText` in `packages/kith-store/src/ingestion/inlineWork.ts`                |
| URL ingest enqueue (`models/ingestion/urlQueue.enqueue`)                                                                                              | `ingest_url`                       | Landed in P2-39e2. `enqueueSourceFetch` in `packages/kith-store/src/ingestion/urlQueue.ts`                                                                                                 |
| Source account create, update, list for the owner UI                                                                                                  | settings page                      | Landed in `feat(kith-store): port source accounts to PostgreSQL`                                                                                                                          |
| `models/spaces/people` list, create, `setMemberPerson`                                                                                                | family space manager               | P2-39h. `identity/spaces.ts` line 162 says the module lands with entities                                                                                                                 |
| `READ ONLY` option on `withSchemaTransaction`                                                                                                         | every read path                    | i1                                                                                                                                                                                        |
| App-role write grants for the identity, memory, records and coverage tables                                                                           | every write                        | i1, see 4.2                                                                                                                                                                               |

Two smaller gaps in `src/identity/webAuth.ts`, both i1's:
`kith.sessions.last_used_at` is written at insert and never updated, and `signUp`
does not call `ensurePersonalSpace` although its doc comment says it creates the
personal space records.

### 1.6 Security-sensitive files

The repository rule names `packages/convex/convex/lib/*Auth.ts`,
`lib/spaces.ts` and `apps/web/src/lib/mcp/*`. That is 4 Convex files
(`mcpAuth.ts`, `sourceAuth.ts`, `webAuth.ts`, `spaces.ts`) and every file under
`apps/web/src/lib/mcp/`.

| File                                                 | Slice             | Second-model review |
| ---------------------------------------------------- | ----------------- | ------------------- |
| `lib/mcp/auth.ts`                                    | i2                | Yes                 |
| `lib/mcp/convex-auth.ts`, deleted                    | i2                | Yes                 |
| `lib/mcp/oauth.ts`, `oauth-validation.ts`            | i2                | Yes                 |
| `lib/mcp/environment.ts`, `cors.ts`, `root-alias.ts` | i2                | Yes                 |
| `lib/mcp/finance.ts`, `record-query.ts`              | i3                | Yes                 |
| `lib/mcp/server.ts`, `tools.ts`, `tool-policy.ts`    | i3, i4            | Yes                 |
| Convex `lib/*Auth.ts`, `lib/spaces.ts`               | i7, deletion only | No                  |

The rule matches by path, so every slice that touches `apps/web/src/lib/mcp/`
needs the review. That is i2, i3 and i4. i1 needs it on its own merits: it is
the session.

## 2. Web session design

Plan 1.5 ports `kith.users` and `kith.auth_accounts` and gives the app its own
signed httpOnly cookie over `kith.sessions`. `src/identity/webAuth.ts` and
`src/identity/scrypt.ts` implement all of it. Row i wires them to routes and
adds nothing to the credential itself.

### 2.1 The cookie

| Property      | Value                                                                                                       | Where                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Name          | `__Host-kith_session`                                                                                       | `SESSION_COOKIE_NAME`, `webAuth.ts` line 46 |
| Value         | `v1.<64 hex token>.<HMAC-SHA256 base64url>`                                                                 | `serializeSessionToken`                     |
| Signing key   | `KITH_SESSION_SECRET`, at least 32 characters, read by the route and passed in as `SessionConfig.secret`    | `requireSecret` refuses a shorter one       |
| Attributes    | `Path=/`, `HttpOnly`, `SameSite=Lax`, `Secure`, `Expires`                                                   | `sessionCookie`                             |
| Lifetime      | 10 years, the Convex Auth lifetime unchanged                                                                | `SESSION_DURATION_MS`                       |
| Server record | `kith.sessions`, SHA-256 of the token, `expires_at`, `revoked_at`                                           | migration 006                               |
| Rotation      | None on read. The token rotates only on password change, where `changePassword` revokes every other session | see 2.4                                     |

The library never reads the secret itself, by design. The route reads
`process.env.KITH_SESSION_SECRET` and builds one `SessionConfig` per request.
`secure` is left at its default, so `Secure` is always set; a local plain-HTTP
run passes `secure: false` from a development-only branch.

### 2.2 Routes

Four new route handlers under `app/api/auth/`, all `POST`, all in one
`withKithTransaction`.

| Route             | Calls                                                     | Response                     |
| ----------------- | --------------------------------------------------------- | ---------------------------- |
| `sign-in`         | `identity.signIn`, then `identity.ensurePersonalSpace`    | 204 with `Set-Cookie`        |
| `sign-up`         | `identity.signUp`, then `identity.ensurePersonalSpace`    | 204 with `Set-Cookie`        |
| `sign-out`        | `identity.signOut`                                        | 204 with the clearing cookie |
| `change-password` | `identity.requireWebPrincipal`, `identity.changePassword` | 204, current session kept    |

`signIn` and `signUp` both return one message, `Invalid credentials`, for an
unknown account and a wrong password. The routes must not widen that. Rate
limiting replaces the retired `authRateLimits` table and lives at the route.
See question 2. The client address the limiter keys on is never read as
`x-forwarded-for`'s first (leftmost) entry, which a client controls; it is the
rightmost entry or the platform-set `x-real-ip`, and a single shared bucket
when neither is present.

### 2.3 Middleware

`apps/web/src/middleware.ts` keeps its two jobs and loses the third.

1. The MCP root rewrite from `shouldRewriteMcpRootRequest` is unchanged.
2. The public route matcher is unchanged, plus `/api/auth(.*)`.
3. The authentication gate no longer calls `convexAuth.isAuthenticated()`. It
   parses the cookie with `parseSessionToken` and redirects to `/sign-in` when
   the MAC does not verify.

The middleware does not open a database connection. Next.js middleware runs on
the edge runtime and `pg` does not. A valid MAC over an unknown, expired or
revoked token therefore passes the middleware and is refused by the page or
route, which does call `requireWebPrincipal`. That is the correct split: the
middleware is a cheap forgery filter, not the authorization boundary.

### 2.4 The 4.3 questions, answered for the session

| 4.3 row            | Answer                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session            | A forged cookie fails `timingSafeEqual` in `parseSessionToken` before any query. A replayed cookie is a live token and authenticates until revoked, which is what a session cookie is. Logout is server side: `signOut` sets `revoked_at` and `resolveSessionToken` returns null for it on the next request |
| Credential scoping | A web session carries no space grant. `webPrincipal` sets no `credentialSpaceIds`, so authority is live membership only and a client-supplied space can only narrow it through `getAuthorizedReadSpaceIds`                                                                                                  |
| Space isolation    | Every page and route reaches data through `identity` or a domain service that takes an already-authorized space set. No page issues SQL                                                                                                                                                                     |
| SQL construction   | `webAuth.ts` uses bind parameters throughout. The only interpolated identifier on the path is the schema name, validated by `assertPgSchemaName`                                                                                                                                                            |
| Revocation         | `resolveSessionToken` and `userExists` both run inside the request's transaction, so a revocation or user deletion that commits mid-request is seen by that request                                                                                                                                         |
| Secret handling    | `KITH_SESSION_SECRET` and `KITH_DATABASE_URL` are server-only. No `NEXT_PUBLIC_` prefix, so neither reaches the browser bundle                                                                                                                                                                              |

### 2.5 Convex Auth sessions at cutover

Not migrated. Plan 1.2 lists `authSessions`, `authRefreshTokens`,
`authVerificationCodes`, `authVerifiers` and `authRateLimits` as recreated
empty, and decision 3 of 2026-09-13 accepts one maintenance window with a
single re-login. On cutover the owner's browser holds a Convex Auth JWT that
nothing reads any more. The new middleware sees no `__Host-kith_session` cookie
and redirects to `/sign-in`. The owner signs in once with the same password,
because `auth_accounts.secret` is the same Lucia Scrypt string and `scrypt.ts`
reproduces the exact parameters. No password reset, no backfill.

## 3. MCP route design

### 3.1 Authentication in the route

`apps/web/src/lib/mcp/auth.ts` hashes the bearer and calls a Convex action.
It becomes one transaction.

```
withKithTransaction(pool, (client) =>
  identity.authenticateApiKey(identityCtx(client, now), { rawKey }))
```

`identity/apiKeys.ts` `requireMcpPrincipal` runs the same checks in the same
order, one hop shorter: hash shape, key lookup by hash, `hasNoOAuthLifecycle`,
live user, `touchApiKey`. `authenticateApiKey` wraps it and returns null rather
than throwing, because the caller is an authentication route and every failure
it can distinguish is a failure it can leak.

Opaque key and OAuth bearer are the same credential. There is no second path.
The OAuth flow ends by clearing `oauth_lifecycle`, which is the moment the key
starts authenticating, so `/api/mcp` does not need to know which way a key was
issued.

### 3.2 The JWT bridge is deleted

Every deletion below moves to i7. i2 stops using the bridge on the PostgreSQL
surface and deletes none of it, because the surface must stay dark until the
pages move: `KITH_POSTGRES_SURFACE` still defaults to `convex`, `main` deploys,
and every page and tool that has not been ported yet reaches Convex through a
token this bridge mints. Each file below carries a comment naming i7.

| Deleted in i7                                                                   | Reason                         |
| ------------------------------------------------------------------------------- | ------------------------------ |
| `apps/web/src/lib/mcp/convex-auth.ts` and its test                              | Nothing to mint a token for    |
| `apps/web/src/app/.well-known/mcp-jwks.json/route.ts`                           | No verifier                    |
| `packages/convex/convex/auth.config.ts`                                         | Deleted at teardown, step 11.3 |
| `MCP_JWT_ISSUER`, `MCP_JWT_PRIVATE_JWK`, `MCP_JWT_PUBLIC_JWK`, `MCP_JWT_KEY_ID` | No signer, no verifier         |
| `scripts/generate-mcp-jwks.mjs`                                                 | Generates a key nothing uses   |

The public origin is still needed. It is used in `WWW-Authenticate`, the OAuth
metadata documents and the resource identifier, which is a different fact from
the JWT issuer that happened to share the variable. i2 renames the variable to
`MCP_PUBLIC_ORIGIN`, renames `getMcpIssuer()` to `getMcpPublicOrigin()` and keeps
the same `isAllowedOrigin` validation.

Because the four `MCP_JWT_*` names are not deleted in i2, the rename is a read
preference rather than a cutover. Under `convex`, `MCP_JWT_ISSUER` is still
accepted when `MCP_PUBLIC_ORIGIN` is absent and `validateMcpEnvironment` reports
it as `deprecated`, which is a notice rather than a failure. Under `postgres`,
`MCP_PUBLIC_ORIGIN` is required. The Convex side of the bridge keeps reading
`MCP_JWT_ISSUER`, because `auth.config.ts`, `lib/mcpAuth.ts` and `lib/webAuth.ts`
must agree on one issuer and the last two are i7's to delete rather than i2's to
rename; a deployment that sets both names to different origins is refused.

`requireOAuthExchangeIdentity` in `src/identity/oauth.ts` already takes the four
exchange fields as arguments instead of reading them from JWT claims, and drops
only the issuer and `oauthPurpose` checks, which existed to keep two JWT
audiences apart.

### 3.3 Capability and space checks

`tool-policy.ts` stays exactly what it is: the single table of registered tool
names and their host annotations, read by the server, by `/api/mcp/discovery`
and by the skill drift check. It gains nothing. Annotations are hints, and
putting an authority decision in them would turn a host-facing hint into a
permission.

Authority stays where it already is, in `src/identity/authorization.ts`:

| Check                                                | Function                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Read tools resolve their space set once              | `getAuthorizedReadSpaceIds(ctx, ref, requestedSpaceIds)`                                 |
| Write and ingest tools resolve one destination space | `resolveWriteSpace`, then `requireSpaceAccess(ctx, ref, spaceId, "write")` or `"ingest"` |
| Every statement carries the set                      | `authorizedSpacePredicate`, or the domain function's own `spaceIds` argument             |

The server holds a `PrincipalRef`, not a `Principal`. Each tool call reloads it
inside its own transaction through `currentPrincipal`, so a revoked key or a
removed membership denies on the next call rather than at the end of the
session. This is the same rule the current `financeTrustedContext` follows by
re-querying Convex per call.

### 3.4 Environment variables

| Added                                     | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `KITH_DATABASE_URL`                       | Pooled writer endpoint for the `kith` schema          |
| `KITH_SESSION_SECRET`                     | Cookie HMAC key, at least 32 characters               |
| `KITH_POSTGRES_SURFACE`                   | `convex` or `postgres`, the dark-deploy switch, see 6 |
| `BRAIN_EMBED_API_KEY` or `OPENAI_API_KEY` | Query embedding, read by `loadEmbeddingConfig`        |

| Removed                                                       | Replaced by                      |
| ------------------------------------------------------------- | -------------------------------- |
| `NEXT_PUBLIC_CONVEX_URL`                                      | `KITH_DATABASE_URL`, server only |
| `MCP_JWT_ISSUER`                                              | `MCP_PUBLIC_ORIGIN`              |
| `MCP_JWT_PRIVATE_JWK`, `MCP_JWT_PUBLIC_JWK`, `MCP_JWT_KEY_ID` | Nothing                          |

Kept: `MCP_OAUTH_ENCRYPTION_KEY`, `MCP_TOOL_PROFILE`, the three
`FINANCE_ARCHIVE_*` values, the optional `BRAIN_EMBED_*` profile values.
`validateMcpEnvironment` is updated to the new required list and keeps its
property of naming variables without returning their values.

## 4. Data access

### 4.1 One pool per instance

`createKithPool(connectionString, max = 2)` in
`packages/kith-store/src/schema.ts` already implements section 2.8's bound: two
connections per serverless instance, `search_path` pinned on connect and again
inside every transaction, no session-level state.

Row i holds it in one module-scoped variable, the shape
`apps/web/src/lib/mcp/finance.ts` already uses for `createArchivePool`:

```
let pool: pg.Pool | undefined;
pool ??= createKithPool(requireEnvironmentVariable("KITH_DATABASE_URL"));
```

Row i reuses the finance config shape and its lazy module-scoped pool, and does
not reuse its pool object. Two pools, because the two connections are different
roles against different schemas: finance connects as `finance_reader` with
`default_transaction_read_only`, and `kith` connects as the writer. Sharing one
`pg.Pool` would mean one of the two runs under the wrong role.

### 4.2 Read-only versus read-write

`withSchemaTransaction` in `packages/pg/src/transaction.ts` has no `READ ONLY`
option today. i1 adds `readOnly?: boolean` to `SchemaTransactionOptions` and a
`withKithReadTransaction` beside `withKithTransaction` that issues
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.

| Path                                                   | Transaction                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Read tools, pages, `GET` routes                        | `REPEATABLE READ READ ONLY`, no retry                        |
| Write tools, auth routes, `/api/worker`, `/api/ingest` | `SERIALIZABLE`, bounded retry, already `withKithTransaction` |

One read tool is not read-only. `query_records` creates, advances or consumes
a single-use cursor in `kith.record_query_sessions` and takes `FOR UPDATE`
locks on the snapshot rows, so it runs under `SERIALIZABLE` with the bounded
retry, which is why its Convex original is a `mutation` rather than a `query`.
Its authority is still `read`: `executeRecordQuery` reloads the principal and
calls `requireSpaceAccess(..., "read")` inside that transaction. i3 recorded
this; the row above means every read tool that can be read-only is.

`REPEATABLE READ` rather than `SERIALIZABLE` for reads, because a read-only
transaction at `REPEATABLE READ` gets the snapshot it needs without adding a
serialization failure the caller would have to retry.

A separate gap blocks every write: `grantProofAppRole` in
`packages/kith-store/src/index.ts` grants `INSERT, UPDATE, DELETE` on 24 named
tables, and the identity, memory, records and coverage tables are not among
them. `kith.sessions` cannot be written by the app role as the code stands.
i1 extends the grant, and the integration test asserts a write to each table
group the surface writes.

### 4.3 One transaction per tool call

A tool that calls several services opens one transaction and passes the same
client to all of them. `recall_context` is the worked example: it needs
`getAuthorizedReadSpaceIds`, `embeddings.recallCandidates`,
`memory.getFactsByIds`, `memory.getThoughtsByIds` and `memory.recallContext`.
All five run on one client inside one `REPEATABLE READ READ ONLY` transaction,
so the facts and the thoughts come from one snapshot and a capture that commits
mid-call cannot appear in one half of the blend and not the other.

One seam has to be crossed carefully. The domains disagree on their context
argument:

| Domain                             | First argument                      |
| ---------------------------------- | ----------------------------------- |
| `identity`, `memory`, `embeddings` | `IdentityCtx` from `identity/db.ts` |
| `documents`, `provenance`          | `ClientBase`                        |
| `records`                          | `QueryCtx`                          |
| `workers`                          | `WorkerCtx` from `workers/db.ts`    |

All four wrap the same `pg.ClientBase`. The MCP server builds one client, then
the two or three context objects each call needs from it, with the same `now`.
It must not open a second transaction to satisfy a second context type.
`withSchemaTransaction` joins rather than nests, so a service that opens its
own transaction on a client already inside one is safe, but a service handed a
second client is not.

### 4.4 Embedder wiring

The three search tools need a query vector. `src/embeddings/search.ts` takes it
as an injected `EmbedQuery`, and the caller supplies it:

```
const config = loadEmbeddingConfig(process.env);
const embedQuery: EmbedQuery = async (text) => {
  const result = await requestEmbedding(text, config);
  return { vector: result.vector, fingerprint: fingerprintEmbeddingConfig(config) };
};
```

The embedding request is an outbound HTTP call and must happen before the
transaction opens, not inside it. Holding a `pg` connection across a provider
round trip is what `KITH_IDLE_TRANSACTION_TIMEOUT_MS` is set to five seconds to
prevent.

The authorization read comes before the embedding call, not after it. i3 first
wrote the provider call at the top of the tool, which satisfies the rule above
and loses Convex's ordering: `mcpActions.search` resolved the space set, read
the active targets and compared fingerprints, and embedded only if that left a
compatible one. Without that, a revoked key, a credential with no readable
space and a deployment with no compatible index each still send the caller's
text to the provider, and in the last case every `search_thoughts` and
`recall_context` ships it and discards the vector. So a vector-backed tool opens
a short `REPEATABLE READ READ ONLY` transaction first, reloads the credential,
resolves the authorized set and reads the active targets, closes it, and calls
the provider only if `compatibleSearchFingerprint` is non-null. The tool's own
transaction opens afterwards and remains the authority: it resolves the set
again and rechecks the targets, so a change between the two narrows the answer
rather than widening it. Those three tools therefore open two read-only
transactions and every other read tool opens one, which is what the row i3 tests
assert.

Every argument whose text reaches the provider carries a length bound. i3 found
`search_thoughts`' `query` unbounded, which let a client send an arbitrarily
large body to the embedding provider through a read tool; it now matches the
store's own `MAX_THOUGHT_QUERY_CHARS`.

`vectorStatus` is surfaced exactly as today. `searchThoughtsHybrid` and
`recallCandidates` return `"ready"` or `"unavailable"`, and
`searchChunkAndCardVectorCandidates` adds `coverageIncomplete`. The tools pass
all three through to the client unchanged, because T14 requires a degraded
semantic leg to be labelled rather than silently returned as complete. A failing
embedder yields `vectorStatus: "unavailable"` and the keyword leg still answers.

The vector legs qualify pgvector's type and operators as `public.vector` and
`OPERATOR(public.<=>)`, because `withKithTransaction` pins `search_path` to
`kith` alone. Nothing in row i changes that, and nothing in row i may widen the
pin to work around it.

## 5. Live surfaces

Plan 5.1 says two surfaces get a 10 second poll instead of a subscription, and
names them worker heartbeat and queue depth. The tree has the first and does
not have the second. The two surfaces that actually rely on reactivity are:

| Surface                              | File                                                                                             | Convex query                                             | Replacement                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Worker heartbeat                     | `components/worker-heartbeat-status.tsx`, rendered per source account at `settings/page.tsx:667` | `diagnostics.public.status`                              | `GET /api/status/worker?sourceAccountId=`, backed by `workers.getWorkerDiagnosticsStatus`, polled every 10 seconds |
| Dashboard counts and recent thoughts | `app/(authenticated)/page.tsx`                                                                   | `thoughts.public.getStats`, `thoughts.public.listRecent` | Server component for the first render, `GET /api/status/dashboard` polled every 10 seconds                         |

Queue depth is not surfaced in the web app today. Row i does not add a surface
that does not exist. See question 3.

Poll design, applied to both:

- A `useEffect` interval of 10,000 ms, cleared on unmount.
- The interval does not run while `document.visibilityState` is `hidden`, and
  one immediate fetch runs when the tab becomes visible again.
- Each response carries `Cache-Control: no-store`.
- A failed poll keeps the last good value and shows a stale marker. It does not
  blank the panel, because a heartbeat panel that empties on a network blip
  reads as a dead worker.
- The first paint comes from the server component, so the poll is a refresh and
  never the only source of the value.

Worker staleness is computed at read time from
`worker_watcher_states.lastHeartbeatAt` against
`WORKER_HEARTBEAT_OVERDUE_MS` in `src/workers/diagnostics.ts`, per plan 2.6, so
a host that is down reports itself stale without needing to be up.

## 6. Slices

Dark deployment is the same mechanism for every slice: `KITH_POSTGRES_SURFACE`
defaults to `convex`, each ported route or page reads it once and picks a
backend, and the PostgreSQL branch is exercised in preview and by tests while
production still reads Convex. The flag flips in row m, not here. One slice
cannot be dark and is marked below.

| Slice | Scope                                                                    | Files                                                                                                                                                                                                                                                        | Tier | Tests it adds                                                                                                                                                                                                                                                                                               | Depends on                                           | Dark | Review |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---- | ------ |
| i1    | Session, login, middleware, pool, read-only transaction, app-role grants | `app/api/auth/*` new, `middleware.ts`, `app/layout.tsx`, `app/(authenticated)/layout.tsx`, `app/sign-in`, `app/sign-up`, `packages/pg/src/transaction.ts`, `packages/kith-store/src/index.ts`. `ConvexClientProvider.tsx` is kept and deleted in i7                                                          | 2    | Cookie forge and truncation rejected, logout revokes server side, revoked session denied mid-request, Scrypt fixture from a stored secret verifies, middleware redirect matrix, read-only transaction refuses a write, one grant test per table group                                                       | none beyond c                                        | Yes  | Yes    |
| i2    | MCP and OAuth authentication, route, environment                         | `lib/mcp/auth.ts`, `lib/mcp/principal.ts` new, `lib/mcp/consent-spaces.ts` new, `lib/mcp/server.ts` credential seam only, `app/api/mcp/route.ts`, `token/route.ts`, `authorize/complete/route.ts`, `health/route.ts`, `lib/mcp/environment.ts`, `lib/mcp/oauth*.ts`, `app/mcp/authorize/page.tsx` split into `components/{convex,kith}-authorize-flow.tsx`, `components/space-grant-picker.tsx` split over `components/space-grant-choices.tsx`. `convex-auth.ts` and the JWKS route are kept and deleted in i7, see 3.2 | 2    | Bearer authenticates and a revoked key does not, a `preparing` or `pending` key authenticates nothing, consumed-code replay revokes, exchange identity is refused as an MCP credential, the route binds the authenticated credential and ignores body identity, environment validation names variables only, a deleted user's key does not authenticate, a revoked key denies on the next per-call reload, environment validation reports the `MCP_PUBLIC_ORIGIN` rename by name | i1                                                   | Yes  | Yes    |
| i3    | Read tools, plus the timeline and review-queue services                  | `lib/mcp/reads.ts` new (one method per read tool, one implementation per surface), `lib/mcp/server.ts` read tools, new `memory/timeline.ts`, `memory/stats.ts` and `records/reviewQueue.ts`, `embeddings/search.ts` (`recallCandidates` returns thought scores). Review follow-ups: `keyset.ts` new, shared by `documents/inventory.ts` and `records/reviewQueue.ts`. `lib/mcp/record-query.ts` and the `lib/mcp/finance.ts` context needed no change: the schema is surface independent and the finance context is i2's `authorizedSpaceIds` | 2    | `postgres-reads.test.ts`: one case per read tool on PostgreSQL, a two-space isolation case per tool, `vectorStatus` under a failing injected embedder, one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` per read call, two for the three tools that may embed, one `SERIALIZABLE` for `query_records`, no provider call for an unauthorized or incompatible query, and one transaction for `list_sources` with an archive configured, and a byte-for-byte comparison against hand-written Convex rows for `list_spaces`, `search_facts`, `browse_recent`, `get_thoughts`, `timeline_thoughts` and `get_stats`. Store side: `memoryTimeline.test.mjs`, `memoryStats.test.mjs`, `recordsReviewQueue.test.mjs`, `documentsInventory.test.mjs` (each filter, paging to the end, tied timestamps, malformed cursors, the empty authorized set) | i2, g2 for `get_stats`                               | Yes  | Yes    |
| i4    | Write and ingest tools, worker and ingest routes                         | `lib/mcp/writes.ts` new (one method per write and ingest tool, one implementation per surface, `reads.ts`'s shape), `lib/mcp/server.ts` write tools and credential seam (i3's unported-gateway stub deleted), `lib/mcp/auth.ts` (i2's `authenticateApiKeyOnConvex` pin deleted), `app/api/ingest/route.ts`, `app/api/worker/route.ts`, `lib/ingest/http.ts` and `lib/worker/http.ts` (the published code-to-status tables exported, so both surfaces answer one contract from one mapping). `packages/kith-store/src/memory/captureAdmission.ts` new: the three provider-free gate helpers ported out of `@repo/db`'s `memoryAnalysis.ts`, because i7 deletes that dependency and removing the import mechanically would have dropped the content bound and the derived-age refusal with no failing test. **`capture_thought`'s model-backed admission gate does not cross, and this blocks the row m flag flip.** The PostgreSQL lane keeps every provider-free branch of `mcpActions.capture` and then takes its ADD branch, which inverts the gate's failure direction: Convex is fail-closed and returns `needs_confirmation` storing nothing when the classifier is unavailable (`actions.ts:300-308`), while this lane has no classifier and stores unconditionally. It also loses SKIP for sensitive content, which `classify.ts:95` and `classify.ts:101-102` make cover credentials and secrets, along with duplicate detection, supersession and extracted metadata. Two published claims were false under `postgres` and are corrected at the seam until the gate lands: `mcpToolAnnotations` returns `idempotentHint: false` for `capture_thought`, and `server.ts` sends a description that drops the "server deduplicates" sentence and says what the surface actually does. See the module comment in `writes.ts`                                                                                                                                                                        | 2    | `postgres-writes.test.ts`: write denied without `write`, capture denied without read and write, ingest denied without `ingest`, destination resolution over Personal, an explicitly named granted space and a configured default write space, a space the credential was not granted refused in words that name no space id, one `BEGIN ISOLATION LEVEL SERIALIZABLE` per call including per denial, a key revoked between two calls denied on the second, the provider-free gate branches storing nothing, `/api/ingest` idempotent by `requestId`, `/api/worker` identical in status and body to `handlePostgresWorkerRequest` on the worker suite's own fixtures, and the route's error table checked code for code against the store's own `WORKER_ERRORS`. Store side: `captureAdmission.test.mjs`, the ported unit cases for the content bound, the derived-age and broad-bucket refusals and the fallback metadata shape. `surface-routing.test.ts` replaces `surface-pinning.test.ts`: each route resolves the bearer on the flagged backend and reaches no other                                                                                                                     | i2, e for both ingest paths                          | Yes  | Yes    |
| i5    | Pages, components, hooks                                                 | The 8 remaining hook files, delete `lib/family-api.ts`                                                                                                                                                                                                       | 1    | Each page renders from the service with no Convex import, unauthenticated page redirects, settings pagination and revocation from every page                                                                                                                                                                | i1, i3, h for people, question 1 for source accounts | Yes  | No     |
| i6    | Live surfaces and status routes                                          | `components/worker-heartbeat-status.tsx`, `app/(authenticated)/page.tsx`, `app/api/status/*`                                                                                                                                                                 | 1    | Read-time staleness predicate, `no-store`, hidden tab does not poll, failed poll keeps the last good value                                                                                                                                                                                                  | i5, j for the staleness contract                     | Yes  | No     |
| i7    | Cutover switch and Convex removal from `apps/web`                        | `apps/web/package.json`, remaining Convex imports, `validateMcpEnvironment` required list                                                                                                                                                                    | 1    | `scripts/check-self-hosting.mjs --web`, no `convex` in the web dependency tree, no `NEXT_PUBLIC_CONVEX_URL` reference                                                                                                                                                                                       | all                                                  | No   | No     |

i1 is dark. This plan first said it could not be, because a browser holds one
session cookie and the app cannot authenticate two ways at once for one request.
That is true of one request and not of one build, and the difference decides
merge safety: `main` deploys, i1 lands before i5 moves the pages, and removing
the Convex provider then would break every page that still calls a Convex hook.
So `KITH_POSTGRES_SURFACE` gates the middleware's authentication check and the
two layouts; the four `app/api/auth/` routes exist in both modes because they
only ever write `kith.sessions`, and under `convex` nothing observable changes.
i7 is not dark because removing the flag is the switch. i6 is dark but pointless
before i5, so it lands after.

`apps/web/package.json` gains `@repo/kith-store` and `pg` in i1 and loses
`@convex-dev/auth`, `convex`, `@repo/db` and `jose` in i7.

The production route switch stays row m. Row i ends with the flag present,
defaulting to `convex`, and both branches passing their tests.

## 7. Security review checklist

A reviewer runs this against the diff of i1 through i4. Each group maps to one
4.3 row.

**Session.** Is `parseSessionToken` the only path from a cookie to a token, and
does it compare with `timingSafeEqual`? Does every authenticated route call
`requireWebPrincipal` inside its own transaction rather than trusting the
middleware? Does `sign-out` set `revoked_at` and not merely clear the cookie?
Is `KITH_SESSION_SECRET` read by the route and passed in, never defaulted?

**Credential scoping.** Does any tool pass a caller-supplied space id to a
domain function without it first passing through `getAuthorizedReadSpaceIds` or
`requireSpaceAccess`? Does any handler build a `Principal` from request data
instead of reloading it from the key hash or the session? Does the OAuth
consent path recheck live membership at activation and not only at consent?

**Space isolation.** Does every read, count, history and by-id call carry an
authorized space set? Is there a by-id read that resolves a row first and
checks its space second, or not at all? Does the finance leg still pin the
archive's configured space and refuse a request naming another?

**SQL construction.** Is every identifier in new SQL from a closed allowlist?
Is every value a bind parameter? Is `search_path` still pinned to `kith` alone,
with pgvector reached as `public.vector` and `OPERATOR(public.<=>)`?

**Revocation.** Does a key revoked between two tool calls deny on the second?
Does a member removed from a space lose every read path within one request?
Does `requireMcpPrincipal` still refuse a key whose `oauth_lifecycle` is set?

**Secret handling.** Is `KITH_DATABASE_URL` absent from the browser bundle, the
health response, logs and error messages? Does `validateMcpEnvironment` still
return variable names without values? Is no secret given a `NEXT_PUBLIC_`
prefix?

## 8. Open questions for the owner

| Question                                                                                                                                                                                                                        | Recommendation                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The settings page creates and edits source accounts, and no PostgreSQL service does. Add a row to port `models/sourceAccounts` (3 functions), or drop the editor and configure source accounts by script?                    | Added, landed in `feat(kith-store): port source accounts to PostgreSQL`. It was small at tier 1 and the editor is how the owner adds a source without a database credential                                              |
| 2. `authRateLimits` is not migrated and plan 1.2 says "rate limit at the route". Ship i1 with a per-process token bucket, or block i1 on a durable `kith.auth_rate_limits` table?                                               | Ship the token bucket and open a row for the durable table. A serverless per-process bucket is weaker than the Convex table, and saying so is better than delaying the session. One user, pre-launch. The durable table landed as migration 019 (`kith.auth_rate_limits`), with `identity.consumeAuthAttempt` and a sweep in `tick`; the sign-in and sign-up routes spend from it under `KITH_POSTGRES_SURFACE=postgres` and keep the token bucket under `convex`                      |
| 3. Queue depth has no web surface, although plan 5.1 names it as one of the two live surfaces. Add one in i6, or correct the parent plan?                                                                                       | Correct the parent plan. Row i does not invent a surface, and the dashboard is the second reactive surface that actually exists                                                                                           |
| 4. `get_stats` and the dashboard counts need the thought stats digest, which P2-39g2 did not port although its counters landed. Port the digest in i3, or ship i3 and i5 with `get_stats` returning a typed unavailable result? | Answered: port, adopted and landed in i3. `memory/stats.ts` `computeSpaceStats` reads `readSpaceCounters` for every total and keeps the bounded scan only for the `byType`, `topTopics` and `topPeople` digest and for a space whose counters were never seeded. `get_stats` strips `dateRange`, as `mcpQueries.getStats` did. i5 no longer needs the unavailable shape for the dashboard counts
| 5. Rename `MCP_JWT_ISSUER` to `MCP_PUBLIC_ORIGIN`, which is a deployment environment change, or keep the old name to avoid touching the deployment?                                                                             | Answered: rename, adopted and landed in i2. The variable outlives the JWT, and keeping the name leaves the next reader looking for a signer that no longer exists. Under `convex` the old name is still read and reported as `deprecated`; under `postgres` the new name is required. See 3.2 |
