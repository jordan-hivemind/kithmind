import { recordTables } from "./models/records/tables";
import { cardTables } from "./models/records/cardTables";
import { recordQueryTables } from "./models/records/queryTables";
import { embeddingTables } from "./models/embeddings/tables";
import { coverageTables } from "./models/coverage/tables";
import { ingestionTables } from "./models/ingestion/tables";
import { inlineWorkTables } from "./models/ingestion/inlineWorkTables";
import { urlQueueTables } from "./models/ingestion/urlQueueTables";
import { provenanceTables } from "./models/provenance/tables";
import { familyTables } from "./models/family/tables";
import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { thoughtFields } from "./models/thoughts/validators";
import { apiKeyFields } from "./models/apiKeys/validators";
import { reportFields, insightFields } from "./models/reports/validators";
import { listFields, listItemFields } from "./models/lists/validators";
import { consumedOAuthCodeFields } from "./models/oauth/validators";
import { entityFields, factFields } from "./models/facts/validators";
import { sourceAccountTables } from "./models/sourceAccounts/tables";
import { workerTables } from "./models/workers/tables";
import { diagnosticsTables } from "./models/diagnostics/tables";
import { inventoryTables } from "./models/documents/inventoryTables";
import {
  spaceFields,
  spaceMemberFields,
  userSpaceSettingsFields,
} from "./models/spaces/validators";

export default defineSchema({
  ...authTables,
  ...sourceAccountTables,
  ...workerTables,
  ...diagnosticsTables,
  ...inventoryTables,
  ...embeddingTables,
  ...coverageTables,
  ...ingestionTables,
  ...inlineWorkTables,
  ...urlQueueTables,
  ...provenanceTables,
  ...familyTables,
  ...recordTables,
  ...cardTables,
  ...recordQueryTables,
  thoughts: defineTable(thoughtFields)
    .index("by_userId", ["userId"])
    .index("by_userId_and_isCore", ["userId", "isCore"])
    .index("by_userId_and_type", ["userId", "metadata.type"])
    .index("by_spaceId", ["spaceId"])
    .index("by_spaceId_and_isCore", ["spaceId", "isCore"])
    .index("by_spaceId_and_type", ["spaceId", "metadata.type"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["userId", "spaceId"],
    })
    .searchIndex("by_content", {
      searchField: "content",
      filterFields: ["userId", "spaceId", "metadata.type"],
    }),
  entities: defineTable(entityFields)
    .index("by_userId", ["userId"])
    .index("by_userId_and_key", ["userId", "key"])
    .index("by_spaceId", ["spaceId"])
    .index("by_spaceId_and_key", ["spaceId", "key"])
    .index("by_spaceId_kind_normalizedName", [
      "spaceId",
      "kind",
      "normalizedName",
    ])
    .index("by_userId_kind_normalizedName", [
      "userId",
      "kind",
      "normalizedName",
    ]),
  facts: defineTable(factFields)
    .index("by_userId", ["userId"])
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_userId_subject_predicate_status", [
      "userId",
      "subjectEntityId",
      "predicate",
      "status",
    ])
    .index("by_userId_and_isCore", ["userId", "isCore"])
    .index("by_userId_isCore_status", ["userId", "isCore", "status"])
    .index("by_spaceId", ["spaceId"])
    .index("by_spaceId_and_status", ["spaceId", "status"])
    .index("by_spaceId_subject_predicate_status", [
      "spaceId",
      "subjectEntityId",
      "predicate",
      "status",
    ])
    .index("by_spaceId_and_isCore", ["spaceId", "isCore"])
    .index("by_spaceId_isCore_status", ["spaceId", "isCore", "status"])
    .searchIndex("by_searchText", {
      searchField: "searchText",
      filterFields: ["userId", "spaceId", "status"],
    }),
  spaces: defineTable(spaceFields).index("by_createdBy_and_kind", [
    "createdBy",
    "kind",
  ]),
  spaceMembers: defineTable(spaceMemberFields)
    .index("by_spaceId_and_userId", ["spaceId", "userId"])
    .index("by_spaceId_personEntityId", ["spaceId", "personEntityId"])
    .index("by_spaceId", ["spaceId"])
    .index("by_userId", ["userId"]),
  userSpaceSettings: defineTable(userSpaceSettingsFields)
    .index("by_userId", ["userId"])
    .index("by_personalSpaceId", ["personalSpaceId"]),
  apiKeys: defineTable(apiKeyFields)
    .index("by_keyHash", ["keyHash"])
    .index("by_userId", ["userId"])
    .index("by_userId_and_oauthLifecycle", ["userId", "oauthLifecycle"])
    .index("by_userId_oauthLifecycle_grantExpiresAt", [
      "userId",
      "oauthLifecycle",
      "oauthGrantExpiresAt",
    ])
    .index("by_userId_and_oauthRequestHash", ["userId", "oauthRequestHash"])
    .index("by_oauthLifecycle_and_oauthGrantExpiresAt", [
      "oauthLifecycle",
      "oauthGrantExpiresAt",
    ]),
  consumedOAuthCodes: defineTable(consumedOAuthCodeFields)
    .index("by_codeHash", ["codeHash"])
    .index("by_userId_and_requestHash", ["userId", "requestHash"])
    .index("by_expiresAt", ["expiresAt"]),
  reports: defineTable(reportFields).index("by_userId", ["userId"]),
  insights: defineTable(insightFields)
    .index("by_reportId", ["reportId"])
    .index("by_userId_and_status", ["userId", "status"]),
  lists: defineTable(listFields)
    .index("by_userId", ["userId"])
    .index("by_userId_and_pinned", ["userId", "pinned"]),
  listItems: defineTable(listItemFields)
    .index("by_listId", ["listId"])
    .index("by_userId_and_status", ["userId", "status"]),
});
