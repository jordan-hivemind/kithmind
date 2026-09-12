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
import type * as lib_cardExtractionProvider from "../lib/cardExtractionProvider.js";
import type * as lib_embeddingProvider from "../lib/embeddingProvider.js";
import type * as lib_mcpAuth from "../lib/mcpAuth.js";
import type * as lib_sourceAuth from "../lib/sourceAuth.js";
import type * as lib_spaceReadErrors from "../lib/spaceReadErrors.js";
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
import type * as models_diagnostics_model from "../models/diagnostics/model.js";
import type * as models_diagnostics_private from "../models/diagnostics/private.js";
import type * as models_diagnostics_public from "../models/diagnostics/public.js";
import type * as models_diagnostics_tables from "../models/diagnostics/tables.js";
import type * as models_diagnostics_validators from "../models/diagnostics/validators.js";
import type * as models_documents_inventory from "../models/documents/inventory.js";
import type * as models_documents_inventoryTables from "../models/documents/inventoryTables.js";
import type * as models_documents_mcpActions from "../models/documents/mcpActions.js";
import type * as models_documents_mcpQueries from "../models/documents/mcpQueries.js";
import type * as models_documents_model from "../models/documents/model.js";
import type * as models_documents_private from "../models/documents/private.js";
import type * as models_documents_public from "../models/documents/public.js";
import type * as models_documents_validators from "../models/documents/validators.js";
import type * as models_embeddings_fill from "../models/embeddings/fill.js";
import type * as models_embeddings_migrations from "../models/embeddings/migrations.js";
import type * as models_embeddings_model from "../models/embeddings/model.js";
import type * as models_embeddings_operator from "../models/embeddings/operator.js";
import type * as models_embeddings_private from "../models/embeddings/private.js";
import type * as models_embeddings_tables from "../models/embeddings/tables.js";
import type * as models_embeddings_targets from "../models/embeddings/targets.js";
import type * as models_embeddings_validators from "../models/embeddings/validators.js";
import type * as models_facts_mcpActions from "../models/facts/mcpActions.js";
import type * as models_facts_mcpQueries from "../models/facts/mcpQueries.js";
import type * as models_facts_model from "../models/facts/model.js";
import type * as models_facts_private from "../models/facts/private.js";
import type * as models_facts_public from "../models/facts/public.js";
import type * as models_facts_validators from "../models/facts/validators.js";
import type * as models_family_errors from "../models/family/errors.js";
import type * as models_family_model from "../models/family/model.js";
import type * as models_family_private from "../models/family/private.js";
import type * as models_family_public from "../models/family/public.js";
import type * as models_family_tables from "../models/family/tables.js";
import type * as models_family_validators from "../models/family/validators.js";
import type * as models_ingestion_archived from "../models/ingestion/archived.js";
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
import type * as models_ingestion_payloadBudget from "../models/ingestion/payloadBudget.js";
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
import type * as models_oauth_cleanup from "../models/oauth/cleanup.js";
import type * as models_oauth_errors from "../models/oauth/errors.js";
import type * as models_oauth_mcpMutations from "../models/oauth/mcpMutations.js";
import type * as models_oauth_validators from "../models/oauth/validators.js";
import type * as models_oauth_web from "../models/oauth/web.js";
import type * as models_provenance_archiveBindings from "../models/provenance/archiveBindings.js";
import type * as models_provenance_archiveDeletion from "../models/provenance/archiveDeletion.js";
import type * as models_provenance_artifacts from "../models/provenance/artifacts.js";
import type * as models_provenance_binary from "../models/provenance/binary.js";
import type * as models_provenance_migrations from "../models/provenance/migrations.js";
import type * as models_provenance_model from "../models/provenance/model.js";
import type * as models_provenance_parsedStaging from "../models/provenance/parsedStaging.js";
import type * as models_provenance_providerOriginals from "../models/provenance/providerOriginals.js";
import type * as models_provenance_representations from "../models/provenance/representations.js";
import type * as models_provenance_tables from "../models/provenance/tables.js";
import type * as models_provenance_validators from "../models/provenance/validators.js";
import type * as models_recallBlend from "../models/recallBlend.js";
import type * as models_records_cardGate from "../models/records/cardGate.js";
import type * as models_records_cardLadder from "../models/records/cardLadder.js";
import type * as models_records_cardQueue from "../models/records/cardQueue.js";
import type * as models_records_cardQueueTables from "../models/records/cardQueueTables.js";
import type * as models_records_cardRunner from "../models/records/cardRunner.js";
import type * as models_records_cardSchemas from "../models/records/cardSchemas.js";
import type * as models_records_cardTables from "../models/records/cardTables.js";
import type * as models_records_cards from "../models/records/cards.js";
import type * as models_records_mcpQueries from "../models/records/mcpQueries.js";
import type * as models_records_model from "../models/records/model.js";
import type * as models_records_query from "../models/records/query.js";
import type * as models_records_queryMcp from "../models/records/queryMcp.js";
import type * as models_records_querySessions from "../models/records/querySessions.js";
import type * as models_records_queryTables from "../models/records/queryTables.js";
import type * as models_records_queryValidators from "../models/records/queryValidators.js";
import type * as models_records_reviewQueue from "../models/records/reviewQueue.js";
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
import type * as models_spaces_people from "../models/spaces/people.js";
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
import type * as models_workers_archiveForget from "../models/workers/archiveForget.js";
import type * as models_workers_archivedDiscovery from "../models/workers/archivedDiscovery.js";
import type * as models_workers_assessment from "../models/workers/assessment.js";
import type * as models_workers_auth from "../models/workers/auth.js";
import type * as models_workers_cleanup from "../models/workers/cleanup.js";
import type * as models_workers_discovery from "../models/workers/discovery.js";
import type * as models_workers_errors from "../models/workers/errors.js";
import type * as models_workers_jobs from "../models/workers/jobs.js";
import type * as models_workers_mcp from "../models/workers/mcp.js";
import type * as models_workers_migrations from "../models/workers/migrations.js";
import type * as models_workers_model from "../models/workers/model.js";
import type * as models_workers_parsedJobs from "../models/workers/parsedJobs.js";
import type * as models_workers_parsedProtocol from "../models/workers/parsedProtocol.js";
import type * as models_workers_private from "../models/workers/private.js";
import type * as models_workers_profile from "../models/workers/profile.js";
import type * as models_workers_protocol from "../models/workers/protocol.js";
import type * as models_workers_providerOriginalForget from "../models/workers/providerOriginalForget.js";
import type * as models_workers_rateLimit from "../models/workers/rateLimit.js";
import type * as models_workers_tables from "../models/workers/tables.js";
import type * as models_workers_validators from "../models/workers/validators.js";

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
  "lib/cardExtractionProvider": typeof lib_cardExtractionProvider;
  "lib/embeddingProvider": typeof lib_embeddingProvider;
  "lib/mcpAuth": typeof lib_mcpAuth;
  "lib/sourceAuth": typeof lib_sourceAuth;
  "lib/spaceReadErrors": typeof lib_spaceReadErrors;
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
  "models/diagnostics/model": typeof models_diagnostics_model;
  "models/diagnostics/private": typeof models_diagnostics_private;
  "models/diagnostics/public": typeof models_diagnostics_public;
  "models/diagnostics/tables": typeof models_diagnostics_tables;
  "models/diagnostics/validators": typeof models_diagnostics_validators;
  "models/documents/inventory": typeof models_documents_inventory;
  "models/documents/inventoryTables": typeof models_documents_inventoryTables;
  "models/documents/mcpActions": typeof models_documents_mcpActions;
  "models/documents/mcpQueries": typeof models_documents_mcpQueries;
  "models/documents/model": typeof models_documents_model;
  "models/documents/private": typeof models_documents_private;
  "models/documents/public": typeof models_documents_public;
  "models/documents/validators": typeof models_documents_validators;
  "models/embeddings/fill": typeof models_embeddings_fill;
  "models/embeddings/migrations": typeof models_embeddings_migrations;
  "models/embeddings/model": typeof models_embeddings_model;
  "models/embeddings/operator": typeof models_embeddings_operator;
  "models/embeddings/private": typeof models_embeddings_private;
  "models/embeddings/tables": typeof models_embeddings_tables;
  "models/embeddings/targets": typeof models_embeddings_targets;
  "models/embeddings/validators": typeof models_embeddings_validators;
  "models/facts/mcpActions": typeof models_facts_mcpActions;
  "models/facts/mcpQueries": typeof models_facts_mcpQueries;
  "models/facts/model": typeof models_facts_model;
  "models/facts/private": typeof models_facts_private;
  "models/facts/public": typeof models_facts_public;
  "models/facts/validators": typeof models_facts_validators;
  "models/family/errors": typeof models_family_errors;
  "models/family/model": typeof models_family_model;
  "models/family/private": typeof models_family_private;
  "models/family/public": typeof models_family_public;
  "models/family/tables": typeof models_family_tables;
  "models/family/validators": typeof models_family_validators;
  "models/ingestion/archived": typeof models_ingestion_archived;
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
  "models/ingestion/payloadBudget": typeof models_ingestion_payloadBudget;
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
  "models/oauth/cleanup": typeof models_oauth_cleanup;
  "models/oauth/errors": typeof models_oauth_errors;
  "models/oauth/mcpMutations": typeof models_oauth_mcpMutations;
  "models/oauth/validators": typeof models_oauth_validators;
  "models/oauth/web": typeof models_oauth_web;
  "models/provenance/archiveBindings": typeof models_provenance_archiveBindings;
  "models/provenance/archiveDeletion": typeof models_provenance_archiveDeletion;
  "models/provenance/artifacts": typeof models_provenance_artifacts;
  "models/provenance/binary": typeof models_provenance_binary;
  "models/provenance/migrations": typeof models_provenance_migrations;
  "models/provenance/model": typeof models_provenance_model;
  "models/provenance/parsedStaging": typeof models_provenance_parsedStaging;
  "models/provenance/providerOriginals": typeof models_provenance_providerOriginals;
  "models/provenance/representations": typeof models_provenance_representations;
  "models/provenance/tables": typeof models_provenance_tables;
  "models/provenance/validators": typeof models_provenance_validators;
  "models/recallBlend": typeof models_recallBlend;
  "models/records/cardGate": typeof models_records_cardGate;
  "models/records/cardLadder": typeof models_records_cardLadder;
  "models/records/cardQueue": typeof models_records_cardQueue;
  "models/records/cardQueueTables": typeof models_records_cardQueueTables;
  "models/records/cardRunner": typeof models_records_cardRunner;
  "models/records/cardSchemas": typeof models_records_cardSchemas;
  "models/records/cardTables": typeof models_records_cardTables;
  "models/records/cards": typeof models_records_cards;
  "models/records/mcpQueries": typeof models_records_mcpQueries;
  "models/records/model": typeof models_records_model;
  "models/records/query": typeof models_records_query;
  "models/records/queryMcp": typeof models_records_queryMcp;
  "models/records/querySessions": typeof models_records_querySessions;
  "models/records/queryTables": typeof models_records_queryTables;
  "models/records/queryValidators": typeof models_records_queryValidators;
  "models/records/reviewQueue": typeof models_records_reviewQueue;
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
  "models/spaces/people": typeof models_spaces_people;
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
  "models/workers/archiveForget": typeof models_workers_archiveForget;
  "models/workers/archivedDiscovery": typeof models_workers_archivedDiscovery;
  "models/workers/assessment": typeof models_workers_assessment;
  "models/workers/auth": typeof models_workers_auth;
  "models/workers/cleanup": typeof models_workers_cleanup;
  "models/workers/discovery": typeof models_workers_discovery;
  "models/workers/errors": typeof models_workers_errors;
  "models/workers/jobs": typeof models_workers_jobs;
  "models/workers/mcp": typeof models_workers_mcp;
  "models/workers/migrations": typeof models_workers_migrations;
  "models/workers/model": typeof models_workers_model;
  "models/workers/parsedJobs": typeof models_workers_parsedJobs;
  "models/workers/parsedProtocol": typeof models_workers_parsedProtocol;
  "models/workers/private": typeof models_workers_private;
  "models/workers/profile": typeof models_workers_profile;
  "models/workers/protocol": typeof models_workers_protocol;
  "models/workers/providerOriginalForget": typeof models_workers_providerOriginalForget;
  "models/workers/rateLimit": typeof models_workers_rateLimit;
  "models/workers/tables": typeof models_workers_tables;
  "models/workers/validators": typeof models_workers_validators;
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
