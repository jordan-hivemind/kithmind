# MCP owner data management

Date: 2026-09-20. Status: implemented by MCP-1.

This is the implemented contract for this owner-management release. It
supersedes the management, confirmation, write-receipt, undo and domain-grant
proposals in `2026-09-19-agent-operable-mcp.md`. That document remains an
unadopted design record.

## Contract

The authenticated MCP gateway exposes task-shaped wrappers over the same Kith
store services used by the web application. It does not implement parallel
business rules and does not accept SQL. Every call reloads the credential and
checks its current capabilities, space grants and membership. Existing
sensitivity ceilings continue to apply to the read services that support them.

| Domain               | MCP operations                                            | Store authority                                                                                      |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Investments          | create, update, archive, restore                          | `admin.createInvestment`, `updateInvestment`, `archiveInvestment`                                    |
| Entries              | create, update, delete                                    | `admin.createInvestmentEntry`, `updateInvestmentEntry`, `deleteInvestmentEntry`                      |
| Supporting documents | list, confirm, reject                                     | `admin.listInvestmentDocumentLinks`, `confirmInvestmentDocumentLink`, `rejectInvestmentDocumentLink` |
| Entities             | paged name and alias lookup, replace aliases              | `memory.listEntities`, `setEntityAliases`                                                            |
| Attention            | page, dismiss, reopen, snooze, bulk actions, mute, unmute | the existing `admin.attention` services                                                              |
| Memory               | fact update and retirement, thought update and retraction | the existing fact and thought lifecycle services                                                     |
| Finance accounts     | set or clear display overrides                            | `admin.setAccountOverride`                                                                           |
| Extraction           | correct one typed observation                             | authenticated wrapper over `extraction.applyCorrection`                                              |

Entry deletion is the existing real delete. It also deletes dependent link
rows and has no MCP undo. The tool description says this directly. Entry
creation exposes the existing optional `importKey` for idempotent source-row
imports; it does not require a new write key for ordinary owner actions.

## Discovery

Startup instructions are a short router to `kith://help/start`. Domain pages
under `kith://help/` provide schemas, relationships, ID distinctions, examples
and known gaps on demand. `get_kith_help` mirrors every page for clients that
do not read MCP resources. `get_kith_capabilities` reports the live
credential's read, write and ingest capabilities, sensitivity ceiling, grant
counts and tool profile.

The help contract distinguishes these identities:

| ID             | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `investmentId` | One outside position                                          |
| `entryId`      | One dated investment money event                              |
| `entityId`     | A person, organization, project, place or other named subject |
| `accountId`    | An opaque account in the separate finance archive             |
| `sourceItemId` | A stable ingested source item that survives re-extraction     |
| `documentId`   | One parsed Brain document representation                      |
| `linkId`       | One persisted investment-to-source-item relationship          |

Entity aliases participate in retrieval and investment document matching
through `investment.entity_id`. Finance account display overrides are a
separate overlay and do not participate in entity matching.

## Known boundaries

- OAuth grants currently issue read and write, not ingest. `ingest_url` still
  requires ingest plus the applicable source-account grant. This release
  reports that gap and does not widen credentials.
- Space membership, API-key management, source-root mutation, re-extraction,
  financial-archive writes, trades and transfers are not exposed.
- Supporting-link reads use the store's bounded candidate limit and have no
  cursor. Other new list surfaces are paginated.
- An extracted-value correction reports whether it updated the exact record,
  is pending extraction, or became orphaned from a changed list line. A stored
  correction is not always an immediate exact-record fix.
- Search and exact-record results remain limited by reported source coverage.
  A missing result does not prove an event did not occur.
