# Scoped credentials and space authorization

P1-2 rolls out in two deployments. The first changes every ordinary content writer
and reader while keeping transitional schema fields optional. The second makes
ownership and credential scopes required after both deployments pass the audits.
Do not mark P1-2 complete after only the first deployment.

## Authorization contract

Web sessions derive their user from Convex Auth. MCP sessions carry a signed API
key ID and subject. Database operations reload the key and current membership.
A removed membership, revoked key, or reduced grant applies to the next database
operation, including final hydration and mutations after model calls.

| Operation                | Required credential capability       | Allowed membership roles   |
| ------------------------ | ------------------------------------ | -------------------------- |
| Read content             | `read`                               | owner, editor, reader      |
| Write content            | `write`                              | owner, editor              |
| Manage family membership | authenticated web session            | owner; implemented in P1-8 |
| Source ingestion         | unavailable until P1-3 source scopes | no implicit grant          |

Reads accept optional `spaceIds`. Omitted or empty filters select all currently
authorized spaces. Explicit inaccessible IDs fail without revealing whether the
space exists. Writes accept one optional `spaceId`, then use the configured write
default, then Personal. An inaccessible configured default fails rather than
silently choosing another destination. Joining a space does not change defaults.
Returned `userId` identifies the author; authorization follows `spaceId`.

Narrative capture requires both `read` and `write` because its admission gate
compares existing memories. Write-only keys can use operations that do not expose
existing content, such as structured fact writes.

New API keys and OAuth connections require explicit space and capability choices.
Existing keys receive `read` and `write` for their owner's Personal space only.
Existing personal lists and reports also require that Personal-space grant.
OAuth authorization-code consumption authenticates the current key but does not
require a content capability; it is replay bookkeeping, not a content read.

## Deployment procedure

Use the explicit deployment selector on every command. Run on development first,
then production after the four repository checks and independent auth review.
Keep a private export before production migrations. Do not commit exports, key
material, deployment-specific IDs, or owner records.

1. Deploy the transitional schema and updated functions. Existing unscoped keys
   deliberately fail closed until the following migration finishes.
2. Repeat the Personal-space bootstrap and content backfill/audit procedure in
   [Personal-space migration](personal-spaces.md). All ordinary content writers
   now assign a destination, so a clean final audit can establish cutover readiness.
3. Run `models/apiKeys/migrations:backfillLegacyScopes` with `dryRun: true`.
   Follow each returned cursor until `isDone` is true. Stop on invalid rows.
4. Repeat with `dryRun: false`. A page containing invalid legacy keys is blocked
   before any patch on that page. Resolve the reported integrity issue before
   resuming; do not invent shared grants.
5. Run `models/apiKeys/migrations:auditScopes` through all pages. Repeat the
   backfill and verify that it changes zero keys.
6. Deploy the paired web frontend. Verify the settings key picker, OAuth consent,
   `list_spaces`, scoped reads, and denied writes using synthetic credentials.
7. In a separate cutover commit, require entity/fact/thought `spaceId` and API-key
   `capabilities`/`spaceIds` in the schema. Run all checks and deploy development
   before production. Preserve migration regression tests with a transitional
   test schema.

Example first dry run:

```sh
pnpm -F @repo/db exec convex run --deployment dev models/apiKeys/migrations:backfillLegacyScopes '{"dryRun":true,"batchSize":25}'
```

Use the returned cursor in the next JSON argument. Record exact commands, counts,
commit IDs, and deployment results in the operator's private work log.

## Existing surface inventory

| Surface                                        | Authorization location                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Fact search/core/history and entity resolution | space helpers before indexed reads; same-space entity and history hydration |
| Thought keyword/vector/hybrid search           | space-filtered candidates and fresh authorized final hydration              |
| Core/recent/stats/direct IDs/timeline          | authorized space query helpers                                              |
| Narrative capture and transitions              | one resolved destination; current grants checked after model work           |
| Blended recall                                 | identical filters on both stores and thought hydration                      |
| Personal lists/reports/insights                | current key capability plus Personal-space access; user-scoped records      |
| API-key create/update/revoke                   | web identity; explicit current membership scopes                            |
| Internal fixtures and migrations               | internal-only entry points; Personal defaults and integrity checks          |
| Source/document/exact-record ingestion         | later P1-3/P1-7/P1-5 tasks; no claim of current implementation              |
