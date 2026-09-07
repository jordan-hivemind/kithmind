/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as legacySchema from "../legacySchema.js";
import type * as lib_embeddingProvider from "../lib/embeddingProvider.js";
import type * as lib_mcpAuth from "../lib/mcpAuth.js";
import type * as lib_sourceAuth from "../lib/sourceAuth.js";
import type * as lib_spaces from "../lib/spaces.js";
import type * as lib_webAuth from "../lib/webAuth.js";
import type * as models_apiKeys_mcpAuth from "../models/apiKeys/mcpAuth.js";
import type * as models_apiKeys_migrations from "../models/apiKeys/migrations.js";
import type * as models_apiKeys_model from "../models/apiKeys/model.js";
import type * as models_apiKeys_private from "../models/apiKeys/private.js";
import type * as models_apiKeys_public from "../models/apiKeys/public.js";
import type * as models_apiKeys_validators from "../models/apiKeys/validators.js";
import type * as models_coverage_model from "../models/coverage/model.js";
import type * as models_coverage_tables from "../models/coverage/tables.js";
import type * as models_coverage_validators from "../models/coverage/validators.js";
import type * as models_documents_mcpActions from "../models/documents/mcpActions.js";
import type * as models_documents_mcpQueries from "../models/documents/mcpQueries.js";
import type * as models_documents_model from "../models/documents/model.js";
import type * as models_documents_private from "../models/documents/private.js";
import type * as models_documents_public from "../models/documents/public.js";
import type * as models_documents_validators from "../models/documents/validators.js";
import type * as models_embeddings_migrations from "../models/embeddings/migrations.js";
import type * as models_embeddings_model from "../models/embeddings/model.js";
import type * as models_embeddings_operator from "../models/embeddings/operator.js";
import type * as models_embeddings_private from "../models/embeddings/private.js";
import type * as models_embeddings_tables from "../models/embeddings/tables.js";
import type * as models_embeddings_validators from "../models/embeddings/validators.js";
import type * as models_facts_mcpActions from "../models/facts/mcpActions.js";
import type * as models_facts_mcpQueries from "../models/facts/mcpQueries.js";
import type * as models_facts_model from "../models/facts/model.js";
import type * as models_facts_private from "../models/facts/private.js";
import type * as models_facts_public from "../models/facts/public.js";
import type * as models_facts_validators from "../models/facts/validators.js";
import type * as models_ingestion_hash from "../models/ingestion/hash.js";
import type * as models_ingestion_inlineErrors from "../models/ingestion/inlineErrors.js";
import type * as models_ingestion_inlineInput from "../models/ingestion/inlineInput.js";
import type * as models_ingestion_inlineMcp from "../models/ingestion/inlineMcp.js";
import type * as models_ingestion_inlineText from "../models/ingestion/inlineText.js";
import type * as models_ingestion_inlineWork from "../models/ingestion/inlineWork.js";
import type * as models_ingestion_inlineWorkTables from "../models/ingestion/inlineWorkTables.js";
import type * as models_ingestion_inlineWorker from "../models/ingestion/inlineWorker.js";
import type * as models_ingestion_limits from "../models/ingestion/limits.js";
import type * as models_ingestion_model from "../models/ingestion/model.js";
import type * as models_ingestion_private from "../models/ingestion/private.js";
import type * as models_ingestion_tables from "../models/ingestion/tables.js";
import type * as models_ingestion_urlQueue from "../models/ingestion/urlQueue.js";
import type * as models_ingestion_urlQueueTables from "../models/ingestion/urlQueueTables.js";
import type * as models_ingestion_validators from "../models/ingestion/validators.js";
import type * as models_lists_mcpActions from "../models/lists/mcpActions.js";
import type * as models_lists_mcpQueries from "../models/lists/mcpQueries.js";
import type * as models_lists_model from "../models/lists/model.js";
import type * as models_lists_private from "../models/lists/private.js";
import type * as models_lists_public from "../models/lists/public.js";
import type * as models_lists_validators from "../models/lists/validators.js";
import type * as models_oauth_mcpMutations from "../models/oauth/mcpMutations.js";
import type * as models_oauth_validators from "../models/oauth/validators.js";
import type * as models_provenance_model from "../models/provenance/model.js";
import type * as models_provenance_tables from "../models/provenance/tables.js";
import type * as models_provenance_validators from "../models/provenance/validators.js";
import type * as models_recallBlend from "../models/recallBlend.js";
import type * as models_records_model from "../models/records/model.js";
import type * as models_records_query from "../models/records/query.js";
import type * as models_records_queryMcp from "../models/records/queryMcp.js";
import type * as models_records_querySessions from "../models/records/querySessions.js";
import type * as models_records_queryTables from "../models/records/queryTables.js";
import type * as models_records_queryValidators from "../models/records/queryValidators.js";
import type * as models_records_tables from "../models/records/tables.js";
import type * as models_records_validators from "../models/records/validators.js";
import type * as models_records_valueValidators from "../models/records/valueValidators.js";
import type * as models_records_values from "../models/records/values.js";
import type * as models_reports_mcpActions from "../models/reports/mcpActions.js";
import type * as models_reports_mcpMutations from "../models/reports/mcpMutations.js";
import type * as models_reports_mcpQueries from "../models/reports/mcpQueries.js";
import type * as models_reports_model from "../models/reports/model.js";
import type * as models_reports_private from "../models/reports/private.js";
import type * as models_reports_public from "../models/reports/public.js";
import type * as models_reports_validators from "../models/reports/validators.js";
import type * as models_sourceAccounts_public from "../models/sourceAccounts/public.js";
import type * as models_sourceAccounts_tables from "../models/sourceAccounts/tables.js";
import type * as models_spaces_mcpQueries from "../models/spaces/mcpQueries.js";
import type * as models_spaces_migrations from "../models/spaces/migrations.js";
import type * as models_spaces_model from "../models/spaces/model.js";
import type * as models_spaces_private from "../models/spaces/private.js";
import type * as models_spaces_public from "../models/spaces/public.js";
import type * as models_spaces_scopeAudit from "../models/spaces/scopeAudit.js";
import type * as models_spaces_validators from "../models/spaces/validators.js";
import type * as models_thoughts_actions from "../models/thoughts/actions.js";
import type * as models_thoughts_classify from "../models/thoughts/classify.js";
import type * as models_thoughts_evalRecall from "../models/thoughts/evalRecall.js";
import type * as models_thoughts_helpers from "../models/thoughts/helpers.js";
import type * as models_thoughts_mcpActions from "../models/thoughts/mcpActions.js";
import type * as models_thoughts_mcpQueries from "../models/thoughts/mcpQueries.js";
import type * as models_thoughts_memoryAnalysis from "../models/thoughts/memoryAnalysis.js";
import type * as models_thoughts_memoryEval from "../models/thoughts/memoryEval.js";
import type * as models_thoughts_memoryLifecycle from "../models/thoughts/memoryLifecycle.js";
import type * as models_thoughts_migrations from "../models/thoughts/migrations.js";
import type * as models_thoughts_model from "../models/thoughts/model.js";
import type * as models_thoughts_private from "../models/thoughts/private.js";
import type * as models_thoughts_public from "../models/thoughts/public.js";
import type * as models_thoughts_publicActions from "../models/thoughts/publicActions.js";
import type * as models_thoughts_validators from "../models/thoughts/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crons: typeof crons;
  http: typeof http;
  legacySchema: typeof legacySchema;
  "lib/embeddingProvider": typeof lib_embeddingProvider;
  "lib/mcpAuth": typeof lib_mcpAuth;
  "lib/sourceAuth": typeof lib_sourceAuth;
  "lib/spaces": typeof lib_spaces;
  "lib/webAuth": typeof lib_webAuth;
  "models/apiKeys/mcpAuth": typeof models_apiKeys_mcpAuth;
  "models/apiKeys/migrations": typeof models_apiKeys_migrations;
  "models/apiKeys/model": typeof models_apiKeys_model;
  "models/apiKeys/private": typeof models_apiKeys_private;
  "models/apiKeys/public": typeof models_apiKeys_public;
  "models/apiKeys/validators": typeof models_apiKeys_validators;
  "models/coverage/model": typeof models_coverage_model;
  "models/coverage/tables": typeof models_coverage_tables;
  "models/coverage/validators": typeof models_coverage_validators;
  "models/documents/mcpActions": typeof models_documents_mcpActions;
  "models/documents/mcpQueries": typeof models_documents_mcpQueries;
  "models/documents/model": typeof models_documents_model;
  "models/documents/private": typeof models_documents_private;
  "models/documents/public": typeof models_documents_public;
  "models/documents/validators": typeof models_documents_validators;
  "models/embeddings/migrations": typeof models_embeddings_migrations;
  "models/embeddings/model": typeof models_embeddings_model;
  "models/embeddings/operator": typeof models_embeddings_operator;
  "models/embeddings/private": typeof models_embeddings_private;
  "models/embeddings/tables": typeof models_embeddings_tables;
  "models/embeddings/validators": typeof models_embeddings_validators;
  "models/facts/mcpActions": typeof models_facts_mcpActions;
  "models/facts/mcpQueries": typeof models_facts_mcpQueries;
  "models/facts/model": typeof models_facts_model;
  "models/facts/private": typeof models_facts_private;
  "models/facts/public": typeof models_facts_public;
  "models/facts/validators": typeof models_facts_validators;
  "models/ingestion/hash": typeof models_ingestion_hash;
  "models/ingestion/inlineErrors": typeof models_ingestion_inlineErrors;
  "models/ingestion/inlineInput": typeof models_ingestion_inlineInput;
  "models/ingestion/inlineMcp": typeof models_ingestion_inlineMcp;
  "models/ingestion/inlineText": typeof models_ingestion_inlineText;
  "models/ingestion/inlineWork": typeof models_ingestion_inlineWork;
  "models/ingestion/inlineWorkTables": typeof models_ingestion_inlineWorkTables;
  "models/ingestion/inlineWorker": typeof models_ingestion_inlineWorker;
  "models/ingestion/limits": typeof models_ingestion_limits;
  "models/ingestion/model": typeof models_ingestion_model;
  "models/ingestion/private": typeof models_ingestion_private;
  "models/ingestion/tables": typeof models_ingestion_tables;
  "models/ingestion/urlQueue": typeof models_ingestion_urlQueue;
  "models/ingestion/urlQueueTables": typeof models_ingestion_urlQueueTables;
  "models/ingestion/validators": typeof models_ingestion_validators;
  "models/lists/mcpActions": typeof models_lists_mcpActions;
  "models/lists/mcpQueries": typeof models_lists_mcpQueries;
  "models/lists/model": typeof models_lists_model;
  "models/lists/private": typeof models_lists_private;
  "models/lists/public": typeof models_lists_public;
  "models/lists/validators": typeof models_lists_validators;
  "models/oauth/mcpMutations": typeof models_oauth_mcpMutations;
  "models/oauth/validators": typeof models_oauth_validators;
  "models/provenance/model": typeof models_provenance_model;
  "models/provenance/tables": typeof models_provenance_tables;
  "models/provenance/validators": typeof models_provenance_validators;
  "models/recallBlend": typeof models_recallBlend;
  "models/records/model": typeof models_records_model;
  "models/records/query": typeof models_records_query;
  "models/records/queryMcp": typeof models_records_queryMcp;
  "models/records/querySessions": typeof models_records_querySessions;
  "models/records/queryTables": typeof models_records_queryTables;
  "models/records/queryValidators": typeof models_records_queryValidators;
  "models/records/tables": typeof models_records_tables;
  "models/records/validators": typeof models_records_validators;
  "models/records/valueValidators": typeof models_records_valueValidators;
  "models/records/values": typeof models_records_values;
  "models/reports/mcpActions": typeof models_reports_mcpActions;
  "models/reports/mcpMutations": typeof models_reports_mcpMutations;
  "models/reports/mcpQueries": typeof models_reports_mcpQueries;
  "models/reports/model": typeof models_reports_model;
  "models/reports/private": typeof models_reports_private;
  "models/reports/public": typeof models_reports_public;
  "models/reports/validators": typeof models_reports_validators;
  "models/sourceAccounts/public": typeof models_sourceAccounts_public;
  "models/sourceAccounts/tables": typeof models_sourceAccounts_tables;
  "models/spaces/mcpQueries": typeof models_spaces_mcpQueries;
  "models/spaces/migrations": typeof models_spaces_migrations;
  "models/spaces/model": typeof models_spaces_model;
  "models/spaces/private": typeof models_spaces_private;
  "models/spaces/public": typeof models_spaces_public;
  "models/spaces/scopeAudit": typeof models_spaces_scopeAudit;
  "models/spaces/validators": typeof models_spaces_validators;
  "models/thoughts/actions": typeof models_thoughts_actions;
  "models/thoughts/classify": typeof models_thoughts_classify;
  "models/thoughts/evalRecall": typeof models_thoughts_evalRecall;
  "models/thoughts/helpers": typeof models_thoughts_helpers;
  "models/thoughts/mcpActions": typeof models_thoughts_mcpActions;
  "models/thoughts/mcpQueries": typeof models_thoughts_mcpQueries;
  "models/thoughts/memoryAnalysis": typeof models_thoughts_memoryAnalysis;
  "models/thoughts/memoryEval": typeof models_thoughts_memoryEval;
  "models/thoughts/memoryLifecycle": typeof models_thoughts_memoryLifecycle;
  "models/thoughts/migrations": typeof models_thoughts_migrations;
  "models/thoughts/model": typeof models_thoughts_model;
  "models/thoughts/private": typeof models_thoughts_private;
  "models/thoughts/public": typeof models_thoughts_public;
  "models/thoughts/publicActions": typeof models_thoughts_publicActions;
  "models/thoughts/validators": typeof models_thoughts_validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
