
CREATE TABLE kith."users" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "name" text,
  "email" text,
  "image" text,
  "email_verification_time" timestamptz,
  "phone" text,
  "phone_verification_time" timestamptz,
  "is_anonymous" boolean
);

CREATE TABLE kith."auth_accounts" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "type" text,
  "provider" text,
  "provider_account_id" text,
  "secret" text,
  "email_verified" text,
  "phone_verified" text
);

CREATE TABLE kith."consumed_oauth_codes" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "api_key_id" kith.kith_id,
  "request_hash" text,
  "code_hash" text,
  "binding_hash" text,
  "key_hash" text,
  "expires_at" timestamptz
);

CREATE TABLE kith."brain_spaces" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "kind" text,
  "name" text,
  "created_by" kith.kith_id
);

CREATE TABLE kith."space_members" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "role" text,
  "person_entity_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."user_space_settings" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "personal_space_id" kith.kith_id,
  "default_write_space_id" kith.kith_id
);

CREATE TABLE kith."brain_api_keys" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "key_hash" text,
  "key_prefix" text,
  "name" text,
  "last_used_at" timestamptz,
  "capabilities" jsonb,
  "oauth_lifecycle" text,
  "oauth_request_hash" text,
  "oauth_code_hash" text,
  "oauth_binding_hash" text,
  "oauth_binding_seed_hash" text,
  "oauth_encrypted_code" text,
  "oauth_grant_expires_at" timestamptz,
  "oauth_preparation_expires_at" timestamptz,
  "oauth_preparation_nonce" text
);

CREATE TABLE kith."api_key_spaces" (
  "id" kith.kith_id PRIMARY KEY,
  "api_key_id" kith.kith_id NOT NULL,
  "space_id" kith.kith_id NOT NULL,
  UNIQUE ("api_key_id", "space_id")
);

CREATE TABLE kith."api_key_source_accounts" (
  "id" kith.kith_id PRIMARY KEY,
  "api_key_id" kith.kith_id NOT NULL,
  "source_account_id" kith.kith_id NOT NULL,
  UNIQUE ("api_key_id", "source_account_id")
);

CREATE TABLE kith."family_invitations" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "email_normalized" text,
  "token_hash" text,
  "role" text,
  "status" text,
  "created_by" kith.kith_id,
  "created_at_field" timestamptz,
  "expires_at" timestamptz,
  "accepted_by" kith.kith_id,
  "accepted_at" timestamptz,
  "approved_by" kith.kith_id,
  "approved_at" timestamptz,
  "membership_id" kith.kith_id,
  "revoked_by" kith.kith_id,
  "revoked_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_accounts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "connector" text,
  "account_id" text,
  "name" text,
  "enabled" boolean,
  "cursor" text,
  "cursor_version" numeric,
  "freshness_ms" numeric,
  "coverage_invalidated_at" timestamptz,
  "last_enumerated_at" timestamptz,
  "last_processed_at" timestamptz,
  "inventory_epoch" numeric,
  "completed_inventory_epoch" numeric,
  "manifest_version" numeric,
  "active_worker_scan_id" kith.kith_id,
  "worker_assessment_epoch" numeric,
  "active_worker_assessment_id" kith.kith_id,
  "latest_worker_assessment_id" kith.kith_id,
  "binary_profile_id" text,
  "binary_profile_ids" jsonb,
  "binary_profile_audit_digest" text,
  "binary_profile_enabled_at" timestamptz,
  "subject_entity_id" kith.kith_id,
  "embed_full_chunks" boolean,
  "created_by" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_items" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "external_id_hash" text,
  "external_id" text,
  "title" text,
  "doc_type" text,
  "uri" text,
  "lifecycle" text,
  "original_link_available" boolean,
  "desired_revision_id" kith.kith_id,
  "desired_processing_epoch" numeric,
  "active_revision_id" kith.kith_id,
  "active_generation_id" kith.kith_id,
  "active_card_generation_id" kith.kith_id,
  "embed_full_chunks" boolean,
  "last_failure" jsonb,
  "forgotten_at" timestamptz,
  "forgotten_by" kith.kith_id,
  "archive_deletion_forget_epoch" numeric,
  "archive_deletion_receipt_count" numeric,
  "archive_deletion_completed_at" timestamptz,
  "worker_observation_epoch" numeric,
  "worker_processing_epoch" numeric,
  "worker_inventory_metadata_digest" text,
  "worker_processing_identity_digest" text,
  "worker_content_hash" text,
  "worker_source_modified_at" timestamptz,
  "worker_profile_id" text,
  "worker_last_seen_inventory_epoch" numeric,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."brain_source_revisions" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_item_id" kith.kith_id,
  "content_hash" text,
  "byte_length" numeric,
  "media_type" text,
  "representation" text,
  "content_hash_authority" text,
  "inline_text" text,
  "captured_at" timestamptz,
  "user_id" kith.kith_id,
  "archive_ref" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_parser_artifacts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "client_artifact_id" text,
  "parser_fingerprint" text,
  "output_hash" text,
  "output_byte_length" numeric,
  "output_media_type" text,
  "hash_authority" text,
  "user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_artifact_archive_receipts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "subject_kind" text,
  "copy_role" text,
  "client_receipt_id" text,
  "request_digest" text,
  "receipt_version" text,
  "archive_representation" text,
  "archive_profile_fingerprint" text,
  "archive_identity_fingerprint" text,
  "recipient_fingerprint" text,
  "repository_key_domain_fingerprint" text,
  "storage_failure_domain_fingerprint" text,
  "archive_object_id" text,
  "plaintext_hash" text,
  "plaintext_byte_length" numeric,
  "plaintext_media_type" text,
  "hash_authority" text,
  "ciphertext_hash" text,
  "ciphertext_byte_length" numeric,
  "verification_kind" text,
  "readback_verified_at" timestamptz,
  "user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_artifact_archive_bindings" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "subject_kind" text,
  "subject_key" text,
  "copy_role" text,
  "receipt_id" kith.kith_id,
  "archive_identity_fingerprint" text,
  "binding_epoch" numeric,
  "updated_at" timestamptz,
  "user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_artifact_deletion_acks" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "receipt_id" kith.kith_id,
  "forget_epoch" numeric,
  "deletion_id" text,
  "request_id" text,
  "request_digest" text,
  "ack_version" text,
  "absence_authority" text,
  "retention_disclosure" text,
  "client_receipt_id" text,
  "receipt_request_digest" text,
  "source_revision_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "subject_kind" text,
  "copy_role" text,
  "receipt_version" text,
  "archive_representation" text,
  "archive_profile_fingerprint" text,
  "archive_identity_fingerprint" text,
  "recipient_fingerprint" text,
  "repository_key_domain_fingerprint" text,
  "storage_failure_domain_fingerprint" text,
  "archive_object_id" text,
  "plaintext_hash" text,
  "plaintext_byte_length" numeric,
  "plaintext_media_type" text,
  "hash_authority" text,
  "ciphertext_hash" text,
  "ciphertext_byte_length" numeric,
  "verification_kind" text,
  "readback_verified_at" timestamptz,
  "receipt_user_id" kith.kith_id,
  "receipt_actor_credential_id" kith.kith_id,
  "receipt_created_at" timestamptz,
  "object_outcome" text,
  "backup_outcome" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "completed_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_provider_original_references" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "client_reference_id" text,
  "request_digest" text,
  "reference_version" text,
  "provider_kind" text,
  "reference_fingerprint" text,
  "source_content_hash" text,
  "source_byte_length" numeric,
  "provider_account_id_hash" text,
  "provider_root_directory_id_hash" text,
  "provider_file_id_hash" text,
  "provider_revision" text,
  "provider_content_hash" text,
  "verified_at" timestamptz,
  "locator_binding_id" text,
  "locator_manifest_fingerprint" text,
  "locator_recipient_fingerprint" text,
  "locator_repository_key_domain_fingerprint" text,
  "locator_repository_id" text,
  "locator_snapshot_id" text,
  "locator_object_name" text,
  "locator_ciphertext_hash" text,
  "locator_ciphertext_byte_length" numeric,
  "locator_readback_verified_at" timestamptz,
  "verification_authority" text,
  "user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_provider_original_bindings" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "reference_id" kith.kith_id,
  "binding_epoch" numeric,
  "verified_at" timestamptz,
  "user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_provider_original_detach_acks" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "ack_version" text,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "reference_id" kith.kith_id,
  "forget_epoch" numeric,
  "detach_id" text,
  "request_id" text,
  "request_digest" text,
  "reference_fingerprint" text,
  "locator_binding_id" text,
  "locator_repository_id" text,
  "locator_snapshot_id" text,
  "locator_object_name" text,
  "reference_outcome" text,
  "locator_bundle_outcome" text,
  "locator_absence_authority" text,
  "retention_disclosure" text,
  "provider_source_outcome" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "completed_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_text_versions" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_revision_id" kith.kith_id,
  "extraction_fingerprint" text,
  "representation" text,
  "text" text,
  "text_hash" text,
  "text_hash_authority" text,
  "byte_length" numeric,
  "utf16_length" numeric,
  "page_count" numeric,
  "mapping_manifest_hash" text,
  "parser_artifact_id" kith.kith_id,
  "evidence_sealed" boolean,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_pages" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_text_version_id" kith.kith_id,
  "ordinal" numeric,
  "start" numeric,
  "end" numeric,
  "text" text,
  "text_hash" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."evidence_spans" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "source_page_id" kith.kith_id,
  "ordinal" numeric,
  "start" numeric,
  "end" numeric,
  "quote_hash" text,
  "locator" jsonb,
  "card_extraction_fingerprints" jsonb,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."brain_documents" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "processing_generation_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "document_key" text,
  "title" text,
  "doc_type" text,
  "captured_at" timestamptz,
  "evidence_span_ids" jsonb,
  "publication_state" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."brain_chunks" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "processing_generation_id" kith.kith_id,
  "document_id" kith.kith_id,
  "ordinal" numeric,
  "source_text_version_id" kith.kith_id,
  "start" numeric,
  "end" numeric,
  "text" text,
  "evidence_span_ids" jsonb,
  "publication_state" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."processing_generations" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "processing_fingerprint" text,
  "extraction_fingerprint" text,
  "extractor_fingerprint" text,
  "record_schema_fingerprint" text,
  "normalization_fingerprint" text,
  "chunker_fingerprint" text,
  "correction_revision" text,
  "parser_artifact_id" kith.kith_id,
  "archive_set_digest" text,
  "normalized_bundle_digest" text,
  "original_primary_receipt_id" kith.kith_id,
  "original_backup_receipt_id" kith.kith_id,
  "original_provider_reference_id" kith.kith_id,
  "original_provider_binding_epoch" numeric,
  "parser_primary_receipt_id" kith.kith_id,
  "parser_backup_receipt_id" kith.kith_id,
  "desired_processing_epoch" numeric,
  "card_generation" boolean,
  "state" text,
  "expected_page_count" numeric,
  "expected_evidence_span_count" numeric,
  "expected_document_count" numeric,
  "expected_chunk_count" numeric,
  "expected_event_count" numeric,
  "expected_observation_count" numeric,
  "actual_page_count" numeric,
  "actual_evidence_span_count" numeric,
  "actual_document_count" numeric,
  "actual_chunk_count" numeric,
  "actual_event_count" numeric,
  "actual_observation_count" numeric,
  "payload_manifest_id" kith.kith_id,
  "embedding_status" text,
  "activated_at" timestamptz,
  "deactivated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."processing_generation_payload_manifests" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "archive_set_digest" text,
  "normalized_bundle_digest" text,
  "mapping_manifest_hash" text,
  "page_ids" jsonb,
  "evidence_span_ids" jsonb,
  "document_ids" jsonb,
  "chunk_ids" jsonb,
  "page_count" numeric,
  "evidence_span_count" numeric,
  "document_count" numeric,
  "chunk_count" numeric,
  "page_bytes" numeric,
  "evidence_bytes" numeric,
  "document_bytes" numeric,
  "chunk_bytes" numeric,
  "page_digest" text,
  "evidence_digest" text,
  "document_digest" text,
  "chunk_digest" text,
  "retained_text_hash" text,
  "retained_text_utf8_length" numeric,
  "retained_text_utf16_length" numeric,
  "manifest_version" text,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."ingest_requests" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "request_id" text,
  "request_digest" text,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."ingest_jobs" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "admitted_by_user_id" kith.kith_id,
  "admitted_by_credential_id" kith.kith_id,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "actor_replaced_at" timestamptz,
  "actor_replaced_by" kith.kith_id,
  "desired_processing_epoch" numeric,
  "state" text,
  "attempts" numeric,
  "lease_epoch" numeric,
  "lease_token" text,
  "lease_expires_at" timestamptz,
  "worker_managed" boolean,
  "worker_lease_owner_credential_id" kith.kith_id,
  "next_attempt_at" timestamptz,
  "error" jsonb,
  "worker_discovery_work_id" kith.kith_id,
  "worker_observation_epoch" numeric,
  "worker_processing_mode" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."inline_work" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "state" text,
  "attempts" numeric,
  "next_attempt_at" timestamptz,
  "last_error_code" text,
  "created_at_field" timestamptz,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."ingest_rate_limits" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "credential_id" kith.kith_id,
  "window_started_at" timestamptz,
  "count" numeric
);

CREATE TABLE kith."source_fetch_requests" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "request_id" text,
  "request_digest" text,
  "url" text,
  "title" text,
  "state" text,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."space_processing_state" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "activation_epoch" numeric,
  "activated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."events" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "event_key" text,
  "created_by" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."event_versions" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "event_id" kith.kith_id,
  "entity_id" kith.kith_id,
  "event_type" text,
  "schema_version" numeric,
  "occurrence" jsonb,
  "occurrence_date" text,
  "occurrence_instant" timestamptz,
  "occurrence_sort_key" text,
  "field_evidence" jsonb,
  "doc_type_patch" jsonb,
  "user_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."observations" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "event_id" kith.kith_id,
  "event_version_id" kith.kith_id,
  "entity_id" kith.kith_id,
  "event_type" text,
  "occurrence" jsonb,
  "occurrence_date" text,
  "occurrence_instant" timestamptz,
  "occurrence_sort_key" text,
  "observation_key" text,
  "observation_type" text,
  "schema_version" numeric,
  "value" jsonb,
  "value_evidence" jsonb,
  "bound_entity_id" kith.kith_id,
  "user_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."card_entity_bindings" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "event_id" kith.kith_id,
  "observation_id" kith.kith_id,
  "record_kind" text,
  "field_key" text,
  "observation_type" text,
  "literal_name" text,
  "normalized_name" text,
  "candidate_count" numeric,
  "status" text,
  "created_at_field" timestamptz,
  "resolution" jsonb,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."card_field_drops" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "record_kind" text,
  "kind" text,
  "field_key" text,
  "code" text,
  "reason" text,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."card_extraction_attempts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "record_kind" text,
  "step" text,
  "gate_version" text,
  "prompt_version" text,
  "playbook_version" text,
  "card_schema_version" numeric,
  "outcome" text,
  "passed_field_count" numeric,
  "dropped_field_count" numeric,
  "failed_field_count" numeric,
  "failure_codes" jsonb,
  "model_id" text,
  "price_table_version" text,
  "input_tokens" numeric,
  "output_tokens" numeric,
  "cost_micro_usd" numeric,
  "wall_time_ms" numeric,
  "created_at_field" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."card_extraction_queue_states" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "kind" text,
  "phase" text,
  "cursor" numeric,
  "daily_document_budget" numeric,
  "weekly_document_budget" numeric,
  "weekly_cost_budget_micro_usd" numeric,
  "day_window_start" timestamptz,
  "week_window_start" timestamptz,
  "documents_processed_today" numeric,
  "documents_processed_this_week" numeric,
  "cost_micro_usd_this_week" numeric,
  "extracted_count" numeric,
  "gate_failed_count" numeric,
  "skipped_count" numeric,
  "provider_failed_count" numeric,
  "consecutive_failures" numeric,
  "last_error_code" text,
  "pause_reason" text,
  "resume_at" timestamptz,
  "started_at" timestamptz,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."record_query_sessions" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "credential_id" kith.kith_id,
  "membership_id" kith.kith_id,
  "authorization_signature" text,
  "operation" text,
  "consistency" text,
  "normalized_filter" text,
  "source_account_ids" jsonb,
  "snapshot_at" timestamptz,
  "activation_epoch" numeric,
  "visibility_epoch" numeric,
  "last_occurrence_date" text,
  "last_occurrence_precision" text,
  "last_occurrence_instant" timestamptz,
  "last_sort_key" text,
  "last_stable_id" text,
  "totals" jsonb,
  "invalid_rows" numeric,
  "ambiguous_time_rows" numeric,
  "unsupported_value_rows" numeric,
  "read_overflow" boolean,
  "processed_rows" numeric,
  "created_at_field" timestamptz,
  "updated_at" timestamptz,
  "expires_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."record_query_space_state" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "visibility_epoch" numeric,
  "snapshot_clock" numeric,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."coverage_windows" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "record_type" text,
  "entity_id" kith.kith_id,
  "from" timestamptz,
  "to" timestamptz,
  "state" text,
  "last_enumerated_at" timestamptz,
  "last_processed_at" timestamptz,
  "discovered_count" numeric,
  "indexed_count" numeric,
  "skipped_count" numeric,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."coverage_gaps" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "record_type" text,
  "entity_id" kith.kith_id,
  "from" timestamptz,
  "to" timestamptz,
  "reason" text,
  "detected_at" timestamptz,
  "status" text,
  "resolved_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_inventory" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "identity_key_hash" text,
  "relative_path" text,
  "folder_path" text,
  "file_name" text,
  "byte_length" numeric,
  "content_hash" text,
  "media_type" text,
  "modified_at" timestamptz,
  "duplicate_group_id" text,
  "content_indexed" boolean,
  "exclusion_reason" text,
  "exclusion_detail" text,
  "permissions_restricted" boolean,
  "permissions_detail" text,
  "first_seen_scan_id" kith.kith_id,
  "last_seen_scan_id" kith.kith_id,
  "missing_since_scan_id" kith.kith_id,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."embedding_profiles" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "fingerprint" text,
  "protocol" text,
  "provider_id" text,
  "model" text,
  "model_revision" text,
  "dimensions" numeric,
  "normalization" text,
  "preprocessing" text,
  "created_at_field" timestamptz
);

CREATE TABLE kith."space_embedding_states" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "eligibility_epoch" numeric,
  "active_embedding_generation_id" kith.kith_id,
  "active_fingerprint" text,
  "activated_at" timestamptz,
  "eligible_counts" jsonb,
  "covered_counts" jsonb,
  "target_policy" text,
  "counter_drift" boolean,
  "counter_drift_reason" text,
  "historical_thought_counts" jsonb,
  "last_audit_at" timestamptz,
  "last_eligibility_change_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."embedding_generations" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "embedding_profile_id" kith.kith_id,
  "fingerprint" text,
  "state" text,
  "eligibility_epoch" numeric,
  "manifest_hash" text,
  "expected_thought_count" numeric,
  "expected_chunk_count" numeric,
  "completed_thought_count" numeric,
  "completed_chunk_count" numeric,
  "coverage_invalid" boolean,
  "thought_coverage_invalid" boolean,
  "chunk_coverage_invalid" boolean,
  "created_at_field" timestamptz,
  "staged_at" timestamptz,
  "activated_at" timestamptz,
  "deactivated_at" timestamptz,
  "failure_code" text,
  "failure_message" text,
  "failed_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."embedding_targets" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "target_kind" text,
  "target_id" text,
  "input_hash" text,
  "processing_generation_id" kith.kith_id,
  "state" text,
  "covered_fingerprint" text,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."embedding_build_jobs" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "fingerprint" text,
  "embedding_generation_id" kith.kith_id,
  "phase" text,
  "cursor" text,
  "page_index" numeric,
  "scanned_count" numeric,
  "filled_count" numeric,
  "retired_count" numeric,
  "audit_eligible_counts" jsonb,
  "audit_covered_counts" jsonb,
  "audit_duplicate_targets" numeric,
  "started_at" timestamptz,
  "updated_at" timestamptz,
  "failure_code" text,
  "failure_message" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."embedding_vectors" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "embedding_generation_id" kith.kith_id,
  "embedding_fingerprint" text,
  "target_kind" text,
  "search_scope" text,
  "thought_id" kith.kith_id,
  "chunk_id" kith.kith_id,
  "event_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "input_hash" text,
  "embedding" jsonb,
  "scope_v2" text,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."thoughts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "content" text,
  "metadata" jsonb,
  "user_id" kith.kith_id,
  "updated_at" timestamptz,
  "is_core" boolean,
  "valid_from" timestamptz,
  "valid_to" timestamptz,
  "memory_status" text,
  "superseded_at" timestamptz,
  "superseded_by" kith.kith_id,
  "supersedes" jsonb,
  "change_reason" text,
  "source_type" text,
  "source_ref" text,
  "observed_at" timestamptz,
  "batch_id" text,
  "confidence" numeric,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."facts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "subject_entity_id" kith.kith_id,
  "predicate" text,
  "value" jsonb,
  "statement" text,
  "search_text" text,
  "source_type" text,
  "source_ref" text,
  "observed_at" timestamptz,
  "batch_id" text,
  "confidence" numeric,
  "is_core" boolean,
  "valid_from" timestamptz,
  "valid_to" timestamptz,
  "status" text,
  "superseded_at" timestamptz,
  "superseded_by" kith.kith_id,
  "supersedes" jsonb,
  "change_reason" text,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."entities" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "user_id" kith.kith_id,
  "key" text,
  "kind" text,
  "canonical_name" text,
  "normalized_name" text,
  "aliases" jsonb,
  "normalized_aliases" jsonb,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_cleanup_state" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "key" text,
  "next_phase" numeric,
  "checkpoints" jsonb
);

CREATE TABLE kith."worker_source_scans" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "request_id" text,
  "request_digest" text,
  "watcher_id" text,
  "connector_version" text,
  "host_affinity" text,
  "mode" text,
  "inventory_epoch" numeric,
  "manifest_version_at_begin" numeric,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "state" text,
  "next_page_ordinal" numeric,
  "inventory_cursor" text,
  "inventory_done" boolean,
  "last_inventory_request_id" text,
  "last_inventory_request_digest" text,
  "last_inventory_input_cursor" text,
  "last_inventory_output_cursor" text,
  "last_inventory_done" boolean,
  "page_count" numeric,
  "entry_count" numeric,
  "changed_count" numeric,
  "gap_count" numeric,
  "review_count" numeric,
  "seal_request_id" text,
  "seal_request_digest" text,
  "manifest_version_at_seal" numeric,
  "reconcile_manifest_version" numeric,
  "reconcile_cursor" text,
  "next_reconcile_ordinal" numeric,
  "reconcile_needs_review" boolean,
  "last_reconcile_request_id" text,
  "last_reconcile_request_digest" text,
  "last_reconcile_result" jsonb,
  "started_at" timestamptz,
  "sealed_at" timestamptz,
  "completed_at" timestamptz,
  "failure_code" text,
  "expires_at" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_scan_pages" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "scan_id" kith.kith_id,
  "ordinal" numeric,
  "request_id" text,
  "request_digest" text,
  "redacted_at" timestamptz,
  "entry_count" numeric,
  "created_at_field" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_scan_entries" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "scan_id" kith.kith_id,
  "scan_page_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "discovery_work_id" kith.kith_id,
  "identity_key_hash" text,
  "external_id_hash" text,
  "uri_digest" text,
  "inventory_metadata_digest" text,
  "processing_identity_digest" text,
  "content_hash" text,
  "byte_length" numeric,
  "content_representation" text,
  "binary_parser_profile_id" text,
  "binary_media_type" text,
  "parser_fingerprint" text,
  "extraction_configuration_fingerprint" text,
  "extractor_fingerprint" text,
  "record_schema_fingerprint" text,
  "normalization_fingerprint" text,
  "chunker_fingerprint" text,
  "correction_revision" text,
  "source_modified_at" timestamptz,
  "observation_epoch" numeric,
  "processing_epoch" numeric,
  "state" text,
  "issue_code" text,
  "proposed_external_id" text,
  "proposed_uri" text,
  "proposed_title" text,
  "proposed_doc_type" text,
  "observed_at" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_discovery_work" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "scan_id" kith.kith_id,
  "scan_entry_id" kith.kith_id,
  "observation_epoch" numeric,
  "processing_epoch" numeric,
  "expected_desired_processing_epoch" numeric,
  "state" text,
  "content_hash" text,
  "byte_length" numeric,
  "captured_at" timestamptz,
  "source_modified_at" timestamptz,
  "media_type" text,
  "profile_id" text,
  "content_representation" text,
  "parser_fingerprint" text,
  "extraction_configuration_fingerprint" text,
  "correction_revision" text,
  "extraction_fingerprint" text,
  "extractor_fingerprint" text,
  "record_schema_fingerprint" text,
  "normalization_fingerprint" text,
  "chunker_fingerprint" text,
  "title" text,
  "doc_type" text,
  "uri" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "attempts" numeric,
  "lease_epoch" numeric,
  "lease_token" text,
  "lease_owner_credential_id" kith.kith_id,
  "lease_expires_at" timestamptz,
  "next_attempt_at" timestamptz,
  "failure_code" text,
  "retryable" boolean,
  "ingest_request_id" text,
  "ingest_job_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "created_at_field" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."source_alias_digests" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "kind" text,
  "digest" text,
  "first_seen_at" timestamptz,
  "last_seen_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_protocol_rate_limits" (
  "id" kith.kith_id PRIMARY KEY,
  "created_at" timestamptz NOT NULL,
  "credential_id" kith.kith_id,
  "source_account_id" kith.kith_id,
  "window_started_at" timestamptz,
  "count" numeric
);

CREATE TABLE kith."worker_reservation_receipts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "kind" text,
  "request_id" text,
  "request_digest" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "target_count" numeric,
  "created_at_field" timestamptz,
  "expires_at" timestamptz,
  "invalidated_at" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_reservation_targets" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "receipt_id" kith.kith_id,
  "ordinal" numeric,
  "discovery_work_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "lease_epoch" numeric,
  "lease_token" text,
  "lease_expires_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_operation_receipts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "discovery_work_id" kith.kith_id,
  "operation" text,
  "phase" text,
  "request_id" text,
  "request_digest" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "lease_epoch" numeric,
  "lease_token_hash" text,
  "source_revision_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "desired_processing_epoch" numeric,
  "result_state" text,
  "result_lease_expires_at" timestamptz,
  "result_activated_at" timestamptz,
  "result_previous_generation_id" kith.kith_id,
  "result_actual_page_count" numeric,
  "result_actual_evidence_span_count" numeric,
  "result_actual_document_count" numeric,
  "result_actual_chunk_count" numeric,
  "result_retryable" boolean,
  "result_next_attempt_at" timestamptz,
  "result_failure_code" text,
  "result_failure_at" timestamptz,
  "created_at_field" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_binary_operation_receipts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "discovery_work_id" kith.kith_id,
  "operation" text,
  "phase" text,
  "request_id" text,
  "request_digest" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "lease_epoch" numeric,
  "lease_token_hash" text,
  "lease_expires_at_at_request" timestamptz,
  "source_revision_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "desired_processing_epoch" numeric,
  "archive_set_digest" text,
  "original_provider_reference_id" kith.kith_id,
  "original_provider_binding_epoch" numeric,
  "stage_id" kith.kith_id,
  "stage_phase" text,
  "stage_ordinal" numeric,
  "stage_accepted_count" numeric,
  "result_state" text,
  "result_lease_expires_at" timestamptz,
  "result_next_attempt_at" timestamptz,
  "result_retryable" boolean,
  "result_failure_code" text,
  "result_failure_at" timestamptz,
  "result_stage_phase" text,
  "result_activated_at" timestamptz,
  "result_previous_generation_id" kith.kith_id,
  "payload_manifest_id" kith.kith_id,
  "created_at_field" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_processing_assessments" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "scan_id" kith.kith_id,
  "request_id" text,
  "request_digest" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "inventory_epoch" numeric,
  "completed_inventory_epoch" numeric,
  "manifest_version" numeric,
  "assessment_epoch" numeric,
  "coverage_invalidated_at" timestamptz,
  "last_enumerated_at" timestamptz,
  "last_processed_at_at_start" timestamptz,
  "scan_completed_at" timestamptz,
  "scan_state_at_start" text,
  "scan_entry_count" numeric,
  "scan_changed_count" numeric,
  "scan_gap_count" numeric,
  "scan_review_count" numeric,
  "state" text,
  "stale_reason" text,
  "phase" text,
  "cursor" text,
  "next_ordinal" numeric,
  "counts" jsonb,
  "accounted_scan_entries" numeric,
  "queued_scan_entries" numeric,
  "gap_scan_entries" numeric,
  "review_scan_entries" numeric,
  "ignored_scan_entries" numeric,
  "unchanged_scan_entries" numeric,
  "last_page_request_id" text,
  "last_page_request_digest" text,
  "last_page_input_phase" text,
  "last_page_ordinal" numeric,
  "last_page_result" jsonb,
  "started_at" timestamptz,
  "updated_at" timestamptz,
  "expires_at" timestamptz,
  "completed_at" timestamptz,
  "last_processed_at_at_completion" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_watcher_states" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "watcher_id" text,
  "state" text,
  "connector_version" text,
  "actor_user_id" kith.kith_id,
  "actor_credential_id" kith.kith_id,
  "last_seen_at" timestamptz,
  "next_expected_at" timestamptz,
  "sweep_after" timestamptz,
  "created_at_field" timestamptz,
  "updated_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_operational_incidents" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "watcher_id" text,
  "kind" text,
  "state" text,
  "opened_at" timestamptz,
  "observed_at" timestamptz,
  "resolved_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_watcher_reset_receipts" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "request_id" text,
  "request_digest" text,
  "expected_watcher_id" text,
  "next_watcher_id" text,
  "actor_user_id" kith.kith_id,
  "changed_at" timestamptz,
  UNIQUE ("id", "space_id")
);

CREATE TABLE kith."worker_parsed_stages" (
  "id" kith.kith_id PRIMARY KEY,
  "space_id" kith.kith_id NOT NULL,
  "created_at" timestamptz NOT NULL,
  "source_account_id" kith.kith_id,
  "source_item_id" kith.kith_id,
  "discovery_work_id" kith.kith_id,
  "ingest_job_id" kith.kith_id,
  "processing_generation_id" kith.kith_id,
  "source_revision_id" kith.kith_id,
  "source_text_version_id" kith.kith_id,
  "parser_artifact_id" kith.kith_id,
  "archive_set_digest" text,
  "normalized_bundle_digest" text,
  "mapping_manifest_hash" text,
  "phase" text,
  "next_ordinal" numeric,
  "expected_page_count" numeric,
  "expected_evidence_span_count" numeric,
  "expected_document_count" numeric,
  "expected_chunk_count" numeric,
  "accepted_page_count" numeric,
  "accepted_evidence_span_count" numeric,
  "accepted_document_count" numeric,
  "accepted_chunk_count" numeric,
  "page_ids" jsonb,
  "evidence_span_ids" jsonb,
  "document_ids" jsonb,
  "chunk_ids" jsonb,
  "page_bytes" numeric,
  "evidence_bytes" numeric,
  "document_bytes" numeric,
  "chunk_bytes" numeric,
  "payload_manifest_id" kith.kith_id,
  "created_at_field" timestamptz,
  "updated_at" timestamptz,
  "retire_at" timestamptz,
  UNIQUE ("id", "space_id")
);

ALTER TABLE kith."auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."consumed_oauth_codes" ADD CONSTRAINT "consumed_oauth_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."consumed_oauth_codes" ADD CONSTRAINT "consumed_oauth_codes_api_key_id_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_spaces" ADD CONSTRAINT "brain_spaces_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."space_members" ADD CONSTRAINT "space_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."space_members" ADD CONSTRAINT "space_members_person_entity_id_fkey"
  FOREIGN KEY ("person_entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."user_space_settings" ADD CONSTRAINT "user_space_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."user_space_settings" ADD CONSTRAINT "user_space_settings_personal_space_id_fkey"
  FOREIGN KEY ("personal_space_id") REFERENCES kith."brain_spaces" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."user_space_settings" ADD CONSTRAINT "user_space_settings_default_write_space_id_fkey"
  FOREIGN KEY ("default_write_space_id") REFERENCES kith."brain_spaces" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_api_keys" ADD CONSTRAINT "brain_api_keys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."api_key_spaces" ADD CONSTRAINT "api_key_spaces_parent_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."api_key_spaces" ADD CONSTRAINT "api_key_spaces_value_fkey"
  FOREIGN KEY ("space_id") REFERENCES kith."brain_spaces" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."api_key_source_accounts" ADD CONSTRAINT "api_key_source_accounts_parent_fkey"
  FOREIGN KEY ("api_key_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."api_key_source_accounts" ADD CONSTRAINT "api_key_source_accounts_value_fkey"
  FOREIGN KEY ("source_account_id") REFERENCES kith."source_accounts" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."family_invitations" ADD CONSTRAINT "family_invitations_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."family_invitations" ADD CONSTRAINT "family_invitations_accepted_by_fkey"
  FOREIGN KEY ("accepted_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."family_invitations" ADD CONSTRAINT "family_invitations_approved_by_fkey"
  FOREIGN KEY ("approved_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."family_invitations" ADD CONSTRAINT "family_invitations_membership_id_fkey"
  FOREIGN KEY ("membership_id", "space_id") REFERENCES kith."space_members" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."family_invitations" ADD CONSTRAINT "family_invitations_revoked_by_fkey"
  FOREIGN KEY ("revoked_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_accounts" ADD CONSTRAINT "source_accounts_active_worker_scan_id_fkey"
  FOREIGN KEY ("active_worker_scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_accounts" ADD CONSTRAINT "source_accounts_active_worker_assessment_id_fkey"
  FOREIGN KEY ("active_worker_assessment_id", "space_id") REFERENCES kith."worker_processing_assessments" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_accounts" ADD CONSTRAINT "source_accounts_latest_worker_assessment_id_fkey"
  FOREIGN KEY ("latest_worker_assessment_id", "space_id") REFERENCES kith."worker_processing_assessments" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_accounts" ADD CONSTRAINT "source_accounts_subject_entity_id_fkey"
  FOREIGN KEY ("subject_entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_accounts" ADD CONSTRAINT "source_accounts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_desired_revision_id_fkey"
  FOREIGN KEY ("desired_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_active_revision_id_fkey"
  FOREIGN KEY ("active_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_active_generation_id_fkey"
  FOREIGN KEY ("active_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_active_card_generation_id_fkey"
  FOREIGN KEY ("active_card_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_items" ADD CONSTRAINT "source_items_forgotten_by_fkey"
  FOREIGN KEY ("forgotten_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_source_revisions" ADD CONSTRAINT "brain_source_revisions_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_source_revisions" ADD CONSTRAINT "brain_source_revisions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_parser_artifacts" ADD CONSTRAINT "source_parser_artifacts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_parser_artifacts" ADD CONSTRAINT "source_parser_artifacts_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_parser_artifacts" ADD CONSTRAINT "source_parser_artifacts_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_parser_artifacts" ADD CONSTRAINT "source_parser_artifacts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_parser_artifacts" ADD CONSTRAINT "source_parser_artifacts_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_receipts" ADD CONSTRAINT "source_artifact_archive_receipts_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_receipt_id_fkey"
  FOREIGN KEY ("receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_archive_bindings" ADD CONSTRAINT "source_artifact_archive_bindings_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_receipt_id_fkey"
  FOREIGN KEY ("receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_receipt_user_id_fkey"
  FOREIGN KEY ("receipt_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_receipt_actor_credential_id_fkey"
  FOREIGN KEY ("receipt_actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_artifact_deletion_acks" ADD CONSTRAINT "source_artifact_deletion_acks_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_references" ADD CONSTRAINT "source_provider_original_references_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_references" ADD CONSTRAINT "source_provider_original_references_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_references" ADD CONSTRAINT "source_provider_original_references_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_references" ADD CONSTRAINT "source_provider_original_references_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_references" ADD CONSTRAINT "source_provider_original_references_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_reference_id_fkey"
  FOREIGN KEY ("reference_id", "space_id") REFERENCES kith."source_provider_original_references" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_bindings" ADD CONSTRAINT "source_provider_original_bindings_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_reference_id_fkey"
  FOREIGN KEY ("reference_id", "space_id") REFERENCES kith."source_provider_original_references" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_provider_original_detach_acks" ADD CONSTRAINT "source_provider_original_detach_acks_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_text_versions" ADD CONSTRAINT "source_text_versions_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_text_versions" ADD CONSTRAINT "source_text_versions_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_pages" ADD CONSTRAINT "source_pages_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."evidence_spans" ADD CONSTRAINT "evidence_spans_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."evidence_spans" ADD CONSTRAINT "evidence_spans_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."evidence_spans" ADD CONSTRAINT "evidence_spans_source_page_id_fkey"
  FOREIGN KEY ("source_page_id", "space_id") REFERENCES kith."source_pages" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_documents" ADD CONSTRAINT "brain_documents_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_documents" ADD CONSTRAINT "brain_documents_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_documents" ADD CONSTRAINT "brain_documents_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_documents" ADD CONSTRAINT "brain_documents_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_chunks" ADD CONSTRAINT "brain_chunks_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_chunks" ADD CONSTRAINT "brain_chunks_document_id_fkey"
  FOREIGN KEY ("document_id", "space_id") REFERENCES kith."brain_documents" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."brain_chunks" ADD CONSTRAINT "brain_chunks_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_original_primary_receipt_id_fkey"
  FOREIGN KEY ("original_primary_receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_original_backup_receipt_id_fkey"
  FOREIGN KEY ("original_backup_receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_original_provider_reference_id_fkey"
  FOREIGN KEY ("original_provider_reference_id", "space_id") REFERENCES kith."source_provider_original_references" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_parser_primary_receipt_id_fkey"
  FOREIGN KEY ("parser_primary_receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_parser_backup_receipt_id_fkey"
  FOREIGN KEY ("parser_backup_receipt_id", "space_id") REFERENCES kith."source_artifact_archive_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generations" ADD CONSTRAINT "processing_generations_payload_manifest_id_fkey"
  FOREIGN KEY ("payload_manifest_id", "space_id") REFERENCES kith."processing_generation_payload_manifests" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_source_text_ve_3f5677f7"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."processing_generation_payload_manifests" ADD CONSTRAINT "processing_generation_payload_manifests_processing_gen_006dd3fc"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_requests" ADD CONSTRAINT "ingest_requests_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_admitted_by_user_id_fkey"
  FOREIGN KEY ("admitted_by_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_admitted_by_credential_id_fkey"
  FOREIGN KEY ("admitted_by_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_actor_replaced_by_fkey"
  FOREIGN KEY ("actor_replaced_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_worker_lease_owner_credential_id_fkey"
  FOREIGN KEY ("worker_lease_owner_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_jobs" ADD CONSTRAINT "ingest_jobs_worker_discovery_work_id_fkey"
  FOREIGN KEY ("worker_discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."inline_work" ADD CONSTRAINT "inline_work_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."ingest_rate_limits" ADD CONSTRAINT "ingest_rate_limits_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_fetch_requests" ADD CONSTRAINT "source_fetch_requests_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_fetch_requests" ADD CONSTRAINT "source_fetch_requests_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_fetch_requests" ADD CONSTRAINT "source_fetch_requests_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_fetch_requests" ADD CONSTRAINT "source_fetch_requests_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."events" ADD CONSTRAINT "events_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."events" ADD CONSTRAINT "events_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."events" ADD CONSTRAINT "events_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_event_id_fkey"
  FOREIGN KEY ("event_id", "space_id") REFERENCES kith."events" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_entity_id_fkey"
  FOREIGN KEY ("entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."event_versions" ADD CONSTRAINT "event_versions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_event_id_fkey"
  FOREIGN KEY ("event_id", "space_id") REFERENCES kith."events" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_event_version_id_fkey"
  FOREIGN KEY ("event_version_id", "space_id") REFERENCES kith."event_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_entity_id_fkey"
  FOREIGN KEY ("entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_bound_entity_id_fkey"
  FOREIGN KEY ("bound_entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."observations" ADD CONSTRAINT "observations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_entity_bindings" ADD CONSTRAINT "card_entity_bindings_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_entity_bindings" ADD CONSTRAINT "card_entity_bindings_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_entity_bindings" ADD CONSTRAINT "card_entity_bindings_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_entity_bindings" ADD CONSTRAINT "card_entity_bindings_event_id_fkey"
  FOREIGN KEY ("event_id", "space_id") REFERENCES kith."events" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_entity_bindings" ADD CONSTRAINT "card_entity_bindings_observation_id_fkey"
  FOREIGN KEY ("observation_id", "space_id") REFERENCES kith."observations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_field_drops" ADD CONSTRAINT "card_field_drops_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_field_drops" ADD CONSTRAINT "card_field_drops_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_field_drops" ADD CONSTRAINT "card_field_drops_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_extraction_attempts" ADD CONSTRAINT "card_extraction_attempts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."card_extraction_attempts" ADD CONSTRAINT "card_extraction_attempts_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."record_query_sessions" ADD CONSTRAINT "record_query_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."record_query_sessions" ADD CONSTRAINT "record_query_sessions_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."record_query_sessions" ADD CONSTRAINT "record_query_sessions_membership_id_fkey"
  FOREIGN KEY ("membership_id", "space_id") REFERENCES kith."space_members" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."coverage_windows" ADD CONSTRAINT "coverage_windows_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."coverage_windows" ADD CONSTRAINT "coverage_windows_entity_id_fkey"
  FOREIGN KEY ("entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."coverage_gaps" ADD CONSTRAINT "coverage_gaps_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."coverage_gaps" ADD CONSTRAINT "coverage_gaps_entity_id_fkey"
  FOREIGN KEY ("entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_inventory" ADD CONSTRAINT "source_inventory_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_inventory" ADD CONSTRAINT "source_inventory_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_inventory" ADD CONSTRAINT "source_inventory_first_seen_scan_id_fkey"
  FOREIGN KEY ("first_seen_scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_inventory" ADD CONSTRAINT "source_inventory_last_seen_scan_id_fkey"
  FOREIGN KEY ("last_seen_scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_inventory" ADD CONSTRAINT "source_inventory_missing_since_scan_id_fkey"
  FOREIGN KEY ("missing_since_scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."space_embedding_states" ADD CONSTRAINT "space_embedding_states_active_embedding_generation_id_fkey"
  FOREIGN KEY ("active_embedding_generation_id", "space_id") REFERENCES kith."embedding_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_generations" ADD CONSTRAINT "embedding_generations_embedding_profile_id_fkey"
  FOREIGN KEY ("embedding_profile_id") REFERENCES kith."embedding_profiles" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_targets" ADD CONSTRAINT "embedding_targets_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_build_jobs" ADD CONSTRAINT "embedding_build_jobs_embedding_generation_id_fkey"
  FOREIGN KEY ("embedding_generation_id", "space_id") REFERENCES kith."embedding_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_vectors" ADD CONSTRAINT "embedding_vectors_embedding_generation_id_fkey"
  FOREIGN KEY ("embedding_generation_id", "space_id") REFERENCES kith."embedding_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_vectors" ADD CONSTRAINT "embedding_vectors_thought_id_fkey"
  FOREIGN KEY ("thought_id", "space_id") REFERENCES kith."thoughts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_vectors" ADD CONSTRAINT "embedding_vectors_chunk_id_fkey"
  FOREIGN KEY ("chunk_id", "space_id") REFERENCES kith."brain_chunks" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_vectors" ADD CONSTRAINT "embedding_vectors_event_id_fkey"
  FOREIGN KEY ("event_id", "space_id") REFERENCES kith."events" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."embedding_vectors" ADD CONSTRAINT "embedding_vectors_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."thoughts" ADD CONSTRAINT "thoughts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."thoughts" ADD CONSTRAINT "thoughts_superseded_by_fkey"
  FOREIGN KEY ("superseded_by", "space_id") REFERENCES kith."thoughts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."facts" ADD CONSTRAINT "facts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."facts" ADD CONSTRAINT "facts_subject_entity_id_fkey"
  FOREIGN KEY ("subject_entity_id", "space_id") REFERENCES kith."entities" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."facts" ADD CONSTRAINT "facts_superseded_by_fkey"
  FOREIGN KEY ("superseded_by", "space_id") REFERENCES kith."facts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."entities" ADD CONSTRAINT "entities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_source_scans" ADD CONSTRAINT "worker_source_scans_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_source_scans" ADD CONSTRAINT "worker_source_scans_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_source_scans" ADD CONSTRAINT "worker_source_scans_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_pages" ADD CONSTRAINT "worker_scan_pages_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_pages" ADD CONSTRAINT "worker_scan_pages_scan_id_fkey"
  FOREIGN KEY ("scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_entries" ADD CONSTRAINT "worker_scan_entries_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_entries" ADD CONSTRAINT "worker_scan_entries_scan_id_fkey"
  FOREIGN KEY ("scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_entries" ADD CONSTRAINT "worker_scan_entries_scan_page_id_fkey"
  FOREIGN KEY ("scan_page_id", "space_id") REFERENCES kith."worker_scan_pages" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_entries" ADD CONSTRAINT "worker_scan_entries_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_scan_entries" ADD CONSTRAINT "worker_scan_entries_discovery_work_id_fkey"
  FOREIGN KEY ("discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_scan_id_fkey"
  FOREIGN KEY ("scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_scan_entry_id_fkey"
  FOREIGN KEY ("scan_entry_id", "space_id") REFERENCES kith."worker_scan_entries" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_lease_owner_credential_id_fkey"
  FOREIGN KEY ("lease_owner_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_discovery_work" ADD CONSTRAINT "worker_discovery_work_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_alias_digests" ADD CONSTRAINT "source_alias_digests_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."source_alias_digests" ADD CONSTRAINT "source_alias_digests_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_protocol_rate_limits" ADD CONSTRAINT "worker_protocol_rate_limits_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_protocol_rate_limits" ADD CONSTRAINT "worker_protocol_rate_limits_source_account_id_fkey"
  FOREIGN KEY ("source_account_id") REFERENCES kith."source_accounts" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_receipts" ADD CONSTRAINT "worker_reservation_receipts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_receipts" ADD CONSTRAINT "worker_reservation_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_receipts" ADD CONSTRAINT "worker_reservation_receipts_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_targets" ADD CONSTRAINT "worker_reservation_targets_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_targets" ADD CONSTRAINT "worker_reservation_targets_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_targets" ADD CONSTRAINT "worker_reservation_targets_receipt_id_fkey"
  FOREIGN KEY ("receipt_id", "space_id") REFERENCES kith."worker_reservation_receipts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_targets" ADD CONSTRAINT "worker_reservation_targets_discovery_work_id_fkey"
  FOREIGN KEY ("discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_reservation_targets" ADD CONSTRAINT "worker_reservation_targets_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_discovery_work_id_fkey"
  FOREIGN KEY ("discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_result_previous_generation_id_fkey"
  FOREIGN KEY ("result_previous_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_discovery_work_id_fkey"
  FOREIGN KEY ("discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_original_provider_ref_d32b5d84"
  FOREIGN KEY ("original_provider_reference_id", "space_id") REFERENCES kith."source_provider_original_references" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_stage_id_fkey"
  FOREIGN KEY ("stage_id", "space_id") REFERENCES kith."worker_parsed_stages" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_result_previous_gener_165357dc"
  FOREIGN KEY ("result_previous_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_binary_operation_receipts" ADD CONSTRAINT "worker_binary_operation_receipts_payload_manifest_id_fkey"
  FOREIGN KEY ("payload_manifest_id", "space_id") REFERENCES kith."processing_generation_payload_manifests" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_processing_assessments" ADD CONSTRAINT "worker_processing_assessments_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_processing_assessments" ADD CONSTRAINT "worker_processing_assessments_scan_id_fkey"
  FOREIGN KEY ("scan_id", "space_id") REFERENCES kith."worker_source_scans" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_processing_assessments" ADD CONSTRAINT "worker_processing_assessments_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_processing_assessments" ADD CONSTRAINT "worker_processing_assessments_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_watcher_states" ADD CONSTRAINT "worker_watcher_states_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_watcher_states" ADD CONSTRAINT "worker_watcher_states_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_watcher_states" ADD CONSTRAINT "worker_watcher_states_actor_credential_id_fkey"
  FOREIGN KEY ("actor_credential_id") REFERENCES kith."brain_api_keys" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_operational_incidents" ADD CONSTRAINT "worker_operational_incidents_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_watcher_reset_receipts" ADD CONSTRAINT "worker_watcher_reset_receipts_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_watcher_reset_receipts" ADD CONSTRAINT "worker_watcher_reset_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES kith."users" ("id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_source_account_id_fkey"
  FOREIGN KEY ("source_account_id", "space_id") REFERENCES kith."source_accounts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_source_item_id_fkey"
  FOREIGN KEY ("source_item_id", "space_id") REFERENCES kith."source_items" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_discovery_work_id_fkey"
  FOREIGN KEY ("discovery_work_id", "space_id") REFERENCES kith."worker_discovery_work" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_ingest_job_id_fkey"
  FOREIGN KEY ("ingest_job_id", "space_id") REFERENCES kith."ingest_jobs" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_processing_generation_id_fkey"
  FOREIGN KEY ("processing_generation_id", "space_id") REFERENCES kith."processing_generations" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id", "space_id") REFERENCES kith."brain_source_revisions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_source_text_version_id_fkey"
  FOREIGN KEY ("source_text_version_id", "space_id") REFERENCES kith."source_text_versions" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_parser_artifact_id_fkey"
  FOREIGN KEY ("parser_artifact_id", "space_id") REFERENCES kith."source_parser_artifacts" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith."worker_parsed_stages" ADD CONSTRAINT "worker_parsed_stages_payload_manifest_id_fkey"
  FOREIGN KEY ("payload_manifest_id", "space_id") REFERENCES kith."processing_generation_payload_manifests" ("id", "space_id")
  DEFERRABLE INITIALLY DEFERRED;
