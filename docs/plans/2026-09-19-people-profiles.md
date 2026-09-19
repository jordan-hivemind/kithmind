# People profiles: a structured person record over the existing fact model

Date: 2026-09-19. Status: proposed.

The owner's complaint is correct and narrow. A stored thought said a family
member was born on a date, named that person by relationship rather than by
name, and put a schematizable statement in prose. This plan says what the code
already supports, what is missing, and what to build.

## 1. Diagnosis

The structured half exists and is good. The guidance, the vocabulary, the
resolution and the view do not.

| Capability                                            | Where                                                  | State   |
| ----------------------------------------------------- | ------------------------------------------------------ | ------- |
| Subject, predicate, typed value                       | `packages/kith-store/src/memory/facts.ts`               | Present |
| Value types text, date, datetime, number, boolean, entity | `facts.ts` `FactValueInput`                         | Present |
| Validity window, supersede, correct, retire           | `facts.ts` `rememberFact`, `updateFact`, `retireFact`   | Present |
| Single and multi valued predicates                    | `facts.ts` `cardinality`                                | Present |
| Entity valued facts                                   | `facts.ts` `normalizeFactValue` case `entity`           | Present |
| Person entities with aliases, per space               | `packages/kith-store/src/memory/entities.ts`            | Present |
| Name to entity lookup over names and aliases          | `entities.ts` `loadSpaceEntityIndex`, `resolveLiteralName` | Present, unused by capture |
| A catalog of which predicates exist                   | Nowhere                                                 | Missing |
| Relationship label to named person                    | Nowhere                                                 | Missing |
| Merge two person entities                             | Nowhere                                                 | Missing |
| Sensitivity level on a predicate                      | Nowhere                                                 | Missing |
| A person profile read or screen                       | Nowhere                                                 | Missing |

`facts.predicate` is validated only by a regex and a nine entry denylist
(`normalizePredicate`). Any string passes. `confidence` is hardcoded to 1.
`kith.entities` allows kinds person, organization, project, place, other.

Why assistants wrote prose instead of facts:

| Cause                                                                                    | Evidence                                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `remember_fact` names three example predicates and no vocabulary. An assistant that does not know a predicate exists writes a sentence | `rememberFact` tool description in `server.ts`                 |
| `remember_fact` requires a subject name. `capture_thought` requires no name, so a missing name routes the statement to prose | `entitySelectorSchema` against `captureThought`'s `content`    |
| The server instructions never say to ask for a name                                       | `SERVER_INSTRUCTIONS` in `server.ts`                           |
| The gate's routing rule is advisory. ASK stores nothing and hands the decision back        | `captureClassifier.ts` prompt, `capture.ts` ASK branch         |
| The gate's covering fact leg is a keyword search, so an empty space shows nothing to route toward | `capture.ts` `searchCoveringFacts`                       |
| `person_note` is picked by the classifier, not the caller, so no call site forces the question | `captureAdmission.ts` `THOUGHT_TYPES`                      |
| Nothing shows an empty profile, so the gap is invisible                                   | `kith-browse.tsx` offers Facts and Thoughts only               |

Early captures also predate the gate, on the Convex surface. Those rows are
section 4's work.

## 2. The person profile

The catalog is data, not code, exactly as document kinds are rows in
`kith.document_types` (migration 022). One table, `kith.predicates`, with the
same shape: space, predicate, label, group, value type, cardinality, history,
sensitivity, object kind for entity values, example, version, active.

Sensitivity uses the three levels the separate sensitivity work defines:
normal, sensitive, restricted. Full government identifiers and account numbers
are never stored. Only a masked last four is, under a predicate ending
`_last_four`. `normalizePredicate` gains a refusal for the unmasked spellings,
beside the existing age and credential refusals. History means the old value
stays reachable after a change; a value that is only ever corrected has none.

| Predicate                    | Value  | Card. | Hist. | Sens.      | Example              |
| ---------------------------- | ------ | ----- | ----- | ---------- | -------------------- |
| `legal_name`                 | text   | one   | yes   | normal     | full legal name      |
| `preferred_name`             | text   | one   | yes   | normal     | the name used daily  |
| `date_of_birth`              | date   | one   | no    | sensitive  | `YYYY-MM-DD`         |
| `place_of_birth`             | text   | one   | no    | sensitive  | city and country     |
| `citizenship`                | text   | many  | yes   | sensitive  | country name         |
| `home_address`               | text   | one   | yes   | sensitive  | with `validFrom`     |
| `mailing_address`            | text   | one   | yes   | sensitive  | when it differs      |
| `mobile_phone`               | text   | many  | yes   | sensitive  | E.164                |
| `email_address`              | text   | many  | yes   | normal     | one per fact         |
| `parent`                     | entity | many  | no    | normal     | person entity        |
| `child`                      | entity | many  | no    | normal     | person entity        |
| `spouse`                     | entity | one   | yes   | normal     | person entity        |
| `sibling`                    | entity | many  | no    | normal     | person entity        |
| `guardian`                   | entity | many  | yes   | normal     | person entity        |
| `emergency_contact`          | entity | many  | yes   | sensitive  | person entity        |
| `attends_school`             | entity | many  | yes   | normal     | organization, dated  |
| `grade_level`                | text   | one   | yes   | normal     | school year          |
| `degree_earned`              | text   | many  | no    | normal     | with `validFrom`     |
| `employer`                   | entity | one   | yes   | normal     | organization         |
| `job_title`                  | text   | one   | yes   | normal     | current title        |
| `primary_care_provider`      | entity | one   | yes   | sensitive  | person or org        |
| `dentist`                    | entity | one   | yes   | sensitive  | person or org        |
| `health_insurer`             | entity | one   | yes   | sensitive  | organization         |
| `allergy`                    | text   | many  | yes   | sensitive  | one allergen         |
| `medication`                 | text   | many  | yes   | sensitive  | one medication       |
| `blood_type`                 | text   | one   | no    | sensitive  | `O+`                 |
| `ssn_last_four`              | text   | one   | no    | restricted | four digits only     |
| `passport_number_last_four`  | text   | one   | yes   | restricted | four digits only     |
| `licence_number_last_four`   | text   | one   | yes   | restricted | four digits only     |
| `insurance_member_last_four` | text   | one   | yes   | restricted | four digits only     |
| `passport_expires_on`        | date   | one   | yes   | sensitive  | `YYYY-MM-DD`         |
| `licence_expires_on`         | date   | one   | yes   | sensitive  | `YYYY-MM-DD`         |
| `wedding_anniversary`        | date   | one   | no    | normal     | `YYYY-MM-DD`         |
| `date_of_death`              | date   | one   | no    | sensitive  | `YYYY-MM-DD`         |

Expiry dates feed the attention queue as informational items only, at the
quiet class the investment matching plan already defines. They never alert.

What stays a thought: narrative, reasons, preferences expressed as a
paragraph, working patterns, project state, and anything whose parts change
together. The rule for choosing has one test. If the statement is one subject,
one attribute and one value, and the attribute is in the catalog, it is a
fact. Everything else is a thought.

## 3. Entity resolution

One person is one `kith.entities` row per space. Four inputs must reach it.

| Input             | Resolution                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| Full name         | `resolveLiteralName` over `loadSpaceEntityIndex`, which already indexes names and aliases |
| First name        | Same index. The first name is stored as an alias on the entity                            |
| Nickname          | Same index. The nickname is stored as an alias                                            |
| Relationship word | Not a name. Resolved through `me` and the relationship facts, never by text match         |

A relationship label resolves in two steps. Load the caller's own person
through `space_members.person_entity_id`, which `resolveEntity` already does
for `key: "me"`. Read that person's current facts for the matching
relationship predicate. Exactly one match resolves. Zero or more than one
refuses and asks the owner for the name. A label never creates an entity. A
new person comes from `resolveEntity` with an explicit name, or from the owner
in the People screen.

Merging duplicates is new work. Keep both rows. Add `entities.merged_into`
and one `kith.entity_merges` row recording the losing id, the winning id and
the fact ids repointed. In one transaction, repoint `facts.subject_entity_id`
and every entity valued `facts.value`, and fold the loser's names into the
winner's aliases. Only the entity pointer moves, so no fact is rewritten and
no history link breaks. The loser row survives, so old ids still resolve and
the merge reverses from its own row. Merges stay explicit, as the architecture
requires, and are never inferred from matching names.

Scope is per space throughout. Entity keys are unique per space and nothing
crosses a space boundary.

The catalog generalizes by carrying a subject kind. Organizations, pets,
vehicles and properties get catalog rows under their own kind, and the rest of
this plan applies unchanged. Vehicle service records and home projects are
dated events, not attributes of a thing, so they belong to `query_records`,
not to a profile.

## 4. Migrating what exists

One reviewable pass, not a background job.

A command proposes facts from current `person_note` thoughts. A tier 0 model
reads one thought and proposes zero or more facts, each citing the thought id
and the exact substring the value came from. Deterministic gates then run.

| Gate       | Rule                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| Grounding  | The proposed value must appear in the thought text after normalization      |
| Vocabulary | The predicate must be an active catalog row, and the value must type check  |
| Dates      | `normalizeIsoDate` must accept a date value                                 |
| Subject    | The subject must resolve to exactly one named person, or the proposal is held and asks the owner for the name |

The owner sees one compact table: thought excerpt, subject, predicate, value,
as-of date. Actions are accept all, accept, edit, reject. Accepting writes
through `rememberFact` with `sourceType: "user_confirmed"` and a shared
`batchId`. The source thought is then marked superseded, with the new fact
ids as its change reason. Nothing is deleted.

One review session, one screen, no attention items, no alerts.

## 5. Capture going forward

The catalog reaches an assistant two ways, and neither needs a new list tool.
`get_person` returns the available predicates for that subject. An off catalog
predicate is refused by `remember_fact` and the refusal carries the catalog.

Replacement text for the capture paragraph of `SERVER_INSTRUCTIONS`:

> Capture precise facts: use remember_fact for any statement that is one
> subject, one attribute and one value. Name the subject. A relationship is
> not a subject: never write a person as someone's son, mother or partner. If
> you do not know the person's name, ask the user for it and store the fact
> after they answer. Use a predicate from the space's catalog, which get_person
> returns for a subject and which an unknown predicate's refusal returns in
> full. Use an entity value for a relationship or a provider. Never store a
> full government identifier or account number. Store only the masked last
> four, under the catalog predicate that ends in last_four.

Added to `remember_fact`'s description:

> Predicates come from the space's catalog. An unknown predicate is refused
> and the reply lists the catalog. The subject must be a named person,
> organization or thing, never a relationship phrase.

Added to `capture_thought`'s description:

> A statement with one subject, one attribute and one value belongs in
> remember_fact. Do not write a person as a relationship because you lack a
> name. Ask the user for the name.

Added to the admission classifier's ASK rules in `captureClassifier.ts`:

> ASK when the content names a person only by relationship, so the client can
> obtain the name and route the statement to remember_fact.

## 6. UI

People is a third segment on Browse, beside Facts and Thoughts, using the
existing `Segment` control. The list is a compact sortable table: name,
relationship to the owner, fields recorded, last updated. Row click opens the
right hand drawer.

The drawer is the profile. Sections follow the catalog groups: identity,
contact, relationships, education, employment, health, identifiers, documents
held, dates. Each row shows the label, the value, the as-of date and a source
pill. Hovering the value shows its history. The kebab holds Edit, Retire and
Add. Edit opens the existing `FactDrawer`, with its Changed and Was wrong
control unchanged.

A relationship value links to that person's profile. A restricted value
renders as a square pill of masked digits. A catalog field with no fact
renders greyed, with Add in its kebab. A final section lists documents whose
extraction named this entity. No explanatory prose anywhere.

## 7. Storage and aggregation

A profile is a view over facts. No projection table.

The projection pattern exists so `GROUP BY` works over thousands of rows that
all point at one placeholder entity. A profile is the opposite shape: one
named subject, about forty current facts, read by the existing
`facts_space_subject_predicate_status_idx`. It needs no semantic key, no
authoritative flag and no rebuild command. A projection here would be a second
copy of the truth for no aggregate anyone asked for.

One migration adds `kith.predicates` with its person seed,
`entities.merged_into` and `kith.entity_merges`. Non person subject kinds
arrive with their first catalog, not before.

## 8. MCP read shape

`get_person` takes a name or an entity id and returns one object:

| Field                 | Contents                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `entity`              | id, key, canonical name, aliases                                        |
| `fields`              | predicate, label, group, typed value, sensitivity, as-of, source, citation, whether history exists |
| `relationships`       | predicate, the related person's id and name, since                      |
| `availablePredicates` | the catalog rows for this subject kind, so a write has a vocabulary     |
| `documents`           | document id, kind, date, citation                                       |
| `notes`               | thought ids and summaries still held as narrative                       |

Restricted values are already masked in storage, so nothing is redacted at
read time. The level travels with the field so a client can decide not to
print it.

`recall_context` changes in one place. When the query resolves to exactly one
person through `resolveLiteralName`, one core slot carries a compact profile
line for that person instead of separate facts. The blend stays bounded and
the result does not grow.

## 9. Build slices

| Slice | Work                                                           | Hours | Testable after                                                      | Second model |
| ----- | -------------------------------------------------------------- | ----- | -------------------------------------------------------------------- | ------------ |
| 1     | `kith.predicates`, person seed, catalog check in `rememberFact`, last-four refusal | 3 to 4 | An off catalog predicate is refused and the refusal carries the catalog | Yes, sensitivity |
| 2     | Relationship label and alias resolution, ask-for-a-name refusal | 4 to 6 | Four spellings reach one entity in a fixture space, an ambiguous label refuses | Yes, identity |
| 3     | `merged_into`, `kith.entity_merges`, `mergeEntities`            | 3 to 5 | A merge preserves every fact and history link, and the losing id still resolves | Yes, identity |
| 4     | `get_person`, `recall_context` profile slot                     | 4 to 6 | The tool returns catalog fields and masks nothing twice              | Yes, MCP exposure |
| 5     | People segment, list, profile drawer, relationship links        | 5 to 6 | Profile renders, edit writes through the existing fact path          | No           |
| 6     | Migration command, four gates, review table, supersede on accept | 5 to 6 | A fixture thought yields a gated proposal, reject leaves it untouched | No           |
| 7     | Tool descriptions, server instructions, classifier ASK rule     | 3      | The prompt literal tests pin the new lines                           | Yes, MCP exposure |

Slices 1, 2 and 3 are prerequisites for 4 and 6. Slice 5 needs 4.

## 10. Open questions

| Question                                                            | Recommended default                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Does People live inside Browse or get its own nav item?              | A third segment on Browse. Promote it later if it earns the space  |
| Is `date_of_birth` normal or sensitive?                              | Sensitive. It is half of an identity theft pair                    |
| Do pets, vehicles and properties get entity kinds now?               | No. Add each kind with its first catalog, not before               |
| Does the migration read only `person_note`, or every thought type?   | `person_note` first. Widen only if that pass finds facts elsewhere |
| When a relationship label will not resolve, block or store a marker? | Block and ask. A marker is the prose problem with extra steps      |
