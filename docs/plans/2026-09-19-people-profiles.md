# People and vehicle profiles through MCP

Date: 2026-09-19. Revised 2026-09-20.
Status: MCP and data implementation authorized; UI deferred.

## Owner outcome

An agent can maintain a named person or vehicle, store structured facts,
retrieve its profile, resolve aliases and relationships, merge duplicates,
and associate supporting documents. The existing entity and fact model is
the source of truth. A birthday belongs to a named person rather than an
ambiguous sentence about “my son.”

The owner held all UI work until the current UI standards work lands
(owner identified PRs #346 through #351; the active stack also includes
#352 and #353). Future profile views must follow those standards. The earlier
proposal for a Browse segment, drawer and conversion screen is superseded.

## Data model

- Add `vehicle` to entity kinds. Its canonical name is its friendly display
  name. Other vehicle fields include VIN, make, model, year, plate and purchase
  date.
- Keep profile values in `kith.facts`, using existing typed values, validity,
  source references and change history.
- Provide a small starter field catalog in code for people and vehicles.
  It describes labels, types, cardinality and sensitivity. Custom predicates
  remain legal. The catalog is guidance, not a permission boundary.
- Keep identifiers in full. Retain existing authorization and owner access.
- Add `entities.merged_into` with a same-space foreign key. Retain merged
  rows so old IDs and keys can resolve to the surviving entity.

Migration 039 is reserved for this work. Registry integration follows the
037 and 038 foundations owned by PRs #351 and #352.

## MCP workflow

| Operation               | Behavior                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `list_profile_fields`   | Fetch the vocabulary for the requested profile kind when needed.                                                     |
| `get_profile`           | Resolve a person or vehicle and return current typed facts, history references, relationships and related documents. |
| `manage_profile_entity` | Create or rename a profile, manage aliases, link the caller's own person, attach a document, or merge duplicates.    |
| `remember_fact`         | Store profile facts and entity-valued relationships through the existing write path.                                 |
| `manage_memory`         | Correct or retire individual facts, including a document-link fact.                                                  |

The initial help resource points to domain help. Profile reads identify the
catalog kind so the complete catalog need not accompany every response.
Historical or document bounds must be explicit to the caller.

## Identity and relationships

Exact canonical names and explicit aliases reuse an unambiguous entity in
the same space and kind. Ambiguous names require an explicit identity.
Relationship selectors follow current relationship facts from the caller's
linked `me` person. Exactly one supported target resolves. An absent or
ambiguous relationship gives an actionable error and does not create a
person named after the relationship.

Qualified relationships must preserve their meaning. A generic `parent`
fact alone does not establish which person is the mother or father. Likewise,
a generic `child` fact alone does not establish a son or daughter. Resolve
qualified labels from explicit supporting relationship facts.

## Duplicate merge

An explicit merge operates within one authorized space and compatible entity
kind. Preserve facts and history while repointing their subject and typed
entity references, member/source links, extracted records, coverage links,
investment links and persisted entity-valued corrections. Preserve evidence
text as evidence. Keep old entity IDs resolvable and retain alternate names.

If current single-valued facts conflict, return their IDs so the agent can
resolve them with existing fact operations. Do not silently select a value.
Coverage condition keys that include an entity ID must remain consistent
with the coverage service when the entity is repointed; merging identities
must not falsely clear an unresolved coverage condition.

A dedicated undo ledger is outside this slice. Existing fact history and
retained entity rows remain available.

## Supporting documents

An explicit attachment uses a `supporting_document` fact with a stable
source-item ID and multiple-value cardinality. The link operation validates
that the source item belongs to the profile's space. Profile reads resolve
that stable ID to current indexed document representations and also include
existing entity-bound records. Return document IDs and citations for the
ordinary document-reading tools.

Retiring the link fact detaches the document from the profile. The source
document remains available. Reprocessing preserves the stable association.

## Acceptance and validation

The MCP/data milestone is complete when an agent can create a named person
or vehicle, write and retrieve facts, discover field vocabulary on demand,
resolve aliases and unambiguous relationships, attach a document, and merge
duplicates while preserving related data and exposing conflicts.

Use synthetic fixtures for the meaningful cases: alias reuse, relationship
ambiguity and qualified labels, custom predicates, full identifier values,
vehicle facts, corrected fact history, old IDs after repeated merges,
document links, and cross-space read/write denial. Apply the migration to
development first and record its command. Run required CI checks and obtain
independent review of MCP and entity behavior before merge.

UI implementation and automatic conversion of old prose notes are deferred.
Existing notes remain available; an agent can convert selected information
through normal fact operations when asked. A recall-ranking rewrite and an
editable catalog table are not prerequisites for these owner workflows.
