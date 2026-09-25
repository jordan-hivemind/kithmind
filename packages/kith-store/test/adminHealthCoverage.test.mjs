// The health and coverage reads, and the triggers migration 024 adds (ADM-2).
//
// Against a real database, because every claim here is a claim about the
// schema: that the counters count the rows the checks are named after, that
// an area's totals come from the roots that name it, that a second space's
// rows never reach either read, that a `reader` member gets the starter list
// with nothing in it rather than someone else's inventory, and that a write to
// a table migration 024 names writes a change row.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  LIFE_AREAS,
  healthContribution,
  listAreaCoverage,
  latestChangeId,
  listChangesSince,
  mergeHealthIntoAreas,
  readHealthFacts,
  upsertSourceRoot,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeApiKey,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const HOUR = 3_600_000;

/** The 64 lowercase hex characters the embedding columns are checked against. */
const hex64 = (seed) =>
  createHash("sha256").update(String(seed)).digest("hex");

async function makeSourceAccount(ctx, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled,
        cursor_version, freshness_ms, created_by)
     VALUES ($1,$2,to_timestamp($3/1000.0),'fs',$4,$5,true,0,60000,$6)`,
    [id, fields.spaceId, NOW, `acct-${id}`, fields.name ?? "Folder", fields.createdBy],
  );
  return id;
}

async function makeSourceItem(ctx, spaceId, sourceAccountId) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.source_items
       (id, space_id, created_at, source_account_id, external_id)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5)`,
    [id, spaceId, NOW, sourceAccountId, `ext-${id}`],
  );
  return id;
}

async function makeObservation(ctx, spaceId, sourceAccountId) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.observations
       (id, space_id, created_at, source_account_id, event_type)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'statement')`,
    [id, spaceId, NOW, sourceAccountId],
  );
  return id;
}

async function makeDeferredWork(ctx, spaceId, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.deferred_work
       (id, space_id, kind, dedupe_key, run_after, state, updated_at)
     VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,to_timestamp($7/1000.0))`,
    [
      id,
      spaceId,
      fields.kind ?? "embedding_fill",
      fields.dedupeKey ?? null,
      fields.runAfter ?? NOW,
      fields.state,
      fields.updatedAt ?? NOW,
    ],
  );
  return id;
}

async function makeEmbeddingTarget(ctx, spaceId, fields) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.embedding_targets
       (id, space_id, created_at, target_kind, target_id, input_hash, state,
        covered_fingerprint, updated_at)
     VALUES ($1,$2,to_timestamp($3/1000.0),'chunk',$4,$7,$5,$6,
             to_timestamp($3/1000.0))`,
    [
      id,
      spaceId,
      NOW,
      `target-${id}`,
      fields.state,
      fields.covered === undefined ? null : hex64(fields.covered),
      hex64(id),
    ],
  );
  return id;
}

/**
 * One sealed scan and the assessment over it.
 *
 * Written as raw rows rather than driven through the worker protocol because
 * what this suite checks is the read, and the protocol's own suites already
 * check that a real pass produces these columns.
 */
async function makeAssessment(ctx, f, fields) {
  const scanId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, created_at, source_account_id, request_id,
        request_digest, watcher_id, connector_version, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, inventory_done, page_count, entry_count,
        changed_count, gap_count, review_count, next_reconcile_ordinal,
        started_at, expires_at, retire_at)
     SELECT $1, $2, at, $3, 'request-scan', $4, 'synthetic-host', '1.0',
            'normal', 1, 1, $5, $6, 'enumerated', 0, true, 1, 0, 0, 0, 0, 0,
            at, at, at
       FROM (SELECT to_timestamp($7/1000.0) AS at) t`,
    [
      scanId,
      f.spaceId,
      f.sourceAccountId,
      hex64("request-scan"),
      f.userId,
      f.credentialId,
      NOW - 120_000,
    ],
  );
  await ctx.client.query(
    `INSERT INTO kith.worker_processing_assessments
       (id, space_id, created_at, source_account_id, scan_id, request_id,
        request_digest, actor_user_id, actor_credential_id, inventory_epoch,
        completed_inventory_epoch, manifest_version, assessment_epoch,
        coverage_invalidated_at, last_enumerated_at, last_processed_at_at_start,
        scan_completed_at, scan_state_at_start, scan_entry_count,
        scan_changed_count, scan_gap_count, scan_review_count, state, phase,
        next_ordinal, counts, accounted_scan_entries, queued_scan_entries,
        gap_scan_entries, review_scan_entries, ignored_scan_entries,
        unchanged_scan_entries, started_at, updated_at, expires_at, retire_at)
     SELECT $1, $2, at, $3, $8, 'request-1', $4, $5, $6, 1, 1, 1, 1,
            at, at, at, at, 'enumerated', 0, 0, 0, 0, $9, 'done',
            0, $10::jsonb, 0, 0, 0, 0, 0, 0, at, at, at, at
       FROM (SELECT to_timestamp($7/1000.0) AS at) t`,
    [
      newKithId(),
      f.spaceId,
      f.sourceAccountId,
      hex64("request-1"),
      f.userId,
      f.credentialId,
      NOW - 120_000,
      scanId,
      fields.state,
      JSON.stringify(
        fields.notReadyReasons === undefined
          ? {}
          : { notReadyReasons: fields.notReadyReasons },
      ),
    ],
  );
}

async function makeEntity(ctx, spaceId, userId) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.entities
       (id, space_id, created_at, user_id, key, kind, canonical_name,
        normalized_name, aliases, normalized_aliases)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,'person','Alex','alex',
             '[]'::jsonb,'[]'::jsonb)`,
    [id, spaceId, NOW, userId, `person:alex:${id}`],
  );
  return id;
}

/** migration 053: one Epic MyChart authorization for `personId`. */
async function makeHealthSource(ctx, personId, spaceId) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_sources
       (id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
        keychain_service, scopes)
     VALUES ($1,$2,$3,'Synthetic Health','https://epic.example.test/fhir',
             'patient-synthetic','com.kithmind.epic.token.synthetic',
             'patient/*.read')`,
    [id, personId, spaceId],
  );
  return id;
}

/** One structured record the Epic feed's `pull` wrote from that source. */
async function makeHealthRecord(ctx, sourceId, personId, fields = {}) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_records
       (id, source_id, person_id, resource_type, fhir_id, effective_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
    [
      id,
      sourceId,
      personId,
      fields.resourceType ?? "Observation",
      fields.fhirId ?? `fhir-${id}`,
      fields.effectiveAt ?? null,
    ],
  );
  return id;
}

/** One `DocumentReference` attachment fetched for that record. */
async function makeHealthDocument(ctx, recordId, personId) {
  const id = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.health_documents
       (id, record_id, person_id, content_type, byte_length)
     VALUES ($1,$2,$3,'application/pdf',1024)`,
    [id, recordId, personId],
  );
  return id;
}

/** One owner, one space, one enabled source account, plus a second space. */
async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const sourceAccountId = await makeSourceAccount(ctx, {
    spaceId,
    createdBy: userId,
    name: "Provider folder",
  });
  const entityId = await makeEntity(ctx, spaceId, userId);
  // The worker credential a scan records as its actor.
  const credential = await makeApiKey(ctx, {
    userId,
    capabilities: ["read", "write", "ingest"],
    spaceIds: [spaceId],
  });
  const strangerId = await makeUser(ctx, { name: "Stranger" });
  const otherSpaceId = await makeSpace(ctx, {
    createdBy: strangerId,
    memberId: strangerId,
    role: "owner",
  });
  const otherSourceAccountId = await makeSourceAccount(ctx, {
    spaceId: otherSpaceId,
    createdBy: strangerId,
    name: "Somebody else's folder",
  });
  return {
    ...database,
    userId,
    spaceId,
    sourceAccountId,
    entityId,
    credentialId: credential.id,
    strangerId,
    otherSpaceId,
    otherSourceAccountId,
    principal: { userId, credentialId: null },
    stranger: { userId: strangerId, credentialId: null },
  };
}

test("the health facts count what the checks are named after", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);

  await ctx.client.query(
    `INSERT INTO kith.worker_watcher_states
       (id, space_id, source_account_id, watcher_id, state, last_seen_at,
        next_expected_at, created_at, created_at_field, updated_at)
     VALUES ($1,$2,$3,'synthetic-host','active',
             to_timestamp($4/1000.0), to_timestamp($5/1000.0),
             to_timestamp($4/1000.0), to_timestamp($4/1000.0),
             to_timestamp($4/1000.0))`,
    [newKithId(), f.spaceId, f.sourceAccountId, NOW - 60_000, NOW + 60_000],
  );
  // The latest assessment's state and its `notReadyReasons` tally, which rides
  // in the `counts` jsonb (see workers/notReady.ts).
  await makeAssessment(ctx, f, {
    state: "complete",
    notReadyReasons: { item_state: 2, job_count: 1 },
  });

  await makeEmbeddingTarget(ctx, f.spaceId, { state: "eligible" });
  await makeEmbeddingTarget(ctx, f.spaceId, {
    state: "eligible",
    covered: "fingerprint-1",
  });
  // Another space's target must not reach the counters.
  await makeEmbeddingTarget(ctx, f.otherSpaceId, { state: "eligible" });

  await makeDeferredWork(ctx, f.spaceId, {
    state: "queued",
    runAfter: NOW - HOUR,
  });
  await makeDeferredWork(ctx, f.spaceId, {
    state: "queued",
    runAfter: NOW + HOUR,
  });
  // A failure with no later `done` job sharing its key: still a failure.
  await makeDeferredWork(ctx, f.spaceId, {
    state: "failed",
    kind: "card_queue_tick",
    updatedAt: NOW - HOUR,
  });
  // A failure the retry fixed: superseded, and not counted.
  await makeDeferredWork(ctx, f.spaceId, {
    state: "failed",
    dedupeKey: "retried",
    updatedAt: NOW - 2 * HOUR,
  });
  await makeDeferredWork(ctx, f.spaceId, {
    state: "done",
    dedupeKey: "retried",
    updatedAt: NOW - HOUR,
  });
  // A failure older than the window.
  await makeDeferredWork(ctx, f.spaceId, {
    state: "failed",
    updatedAt: NOW - 48 * HOUR,
  });

  await ctx.client.query(
    `INSERT INTO kith.card_entity_bindings
       (id, space_id, created_at, source_account_id, status, candidate_count)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'pending',0),
            ($5,$2,to_timestamp($3/1000.0),$4,'resolved',1)`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId, newKithId()],
  );
  await ctx.client.query(
    `INSERT INTO kith.card_field_drops
       (id, space_id, created_at, source_account_id, kind, code)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'field_dropped','not_on_page')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );

  const facts = await readHealthFacts(ctx, { principal: f.principal });

  // Only this space's source accounts.
  assert.equal(facts.watchers.length, 1);
  const watcher = facts.watchers[0];
  assert.equal(watcher.sourceAccountId, f.sourceAccountId);
  assert.equal(watcher.watcherState, "active");
  assert.equal(watcher.lastSeenAt, NOW - 60_000);
  assert.equal(watcher.assessmentState, "complete");
  assert.deepEqual(watcher.notReadyReasons, { item_state: 2, job_count: 1 });

  assert.deepEqual(facts.index, { eligible: 2, covered: 1, owed: 1 });
  assert.equal(facts.jobs.overdueQueued, 1);
  assert.equal(facts.jobs.failed, 1);
  assert.deepEqual(facts.jobs.failedKinds, { card_queue_tick: 1 });
  assert.deepEqual(facts.review, { pendingBindings: 1, fieldDrops: 1 });
});

test("a reader administers nothing, so the health facts are empty", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, { spaceId: f.spaceId, userId: readerId, role: "reader" });
  const reader = { userId: readerId, credentialId: null };

  await makeEmbeddingTarget(ctx, f.spaceId, { state: "eligible" });
  await makeDeferredWork(ctx, f.spaceId, {
    state: "queued",
    runAfter: NOW - HOUR,
  });

  const facts = await readHealthFacts(ctx, { principal: reader });
  assert.deepEqual(facts.watchers, []);
  assert.deepEqual(facts.index, { eligible: 0, covered: 0, owed: 0 });
  assert.equal(facts.jobs.overdueQueued, 0);
  // Naming the space explicitly does not get past it either.
  assert.deepEqual(
    (await readHealthFacts(ctx, { principal: reader, spaceIds: [f.spaceId] }))
      .watchers,
    [],
  );

  // And the space's owner never sees the other space's rows.
  const owner = await readHealthFacts(ctx, { principal: f.principal });
  assert.equal(
    owner.watchers.every((row) => row.sourceAccountId !== f.otherSourceAccountId),
    true,
  );
});

test("coverage lists every starter area, with the empty ones empty", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);

  await upsertSourceRoot(ctx, {
    principal: f.principal,
    sourceAccountId: f.sourceAccountId,
    kind: "folder",
    area: "Taxes",
  });
  await makeSourceItem(ctx, f.spaceId, f.sourceAccountId);
  await makeSourceItem(ctx, f.spaceId, f.sourceAccountId);
  await makeObservation(ctx, f.spaceId, f.sourceAccountId);
  await ctx.client.query(
    `INSERT INTO kith.coverage_windows
       (id, space_id, created_at, source_account_id, record_type, "from", "to", state)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'statement',
             '2024-03-01T00:00:00Z','2026-06-30T00:00:00Z','partial')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );
  await ctx.client.query(
    `INSERT INTO kith.coverage_gaps
       (id, space_id, created_at, source_account_id, record_type, reason, status,
        condition_key)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'statement','missing quarter','open',
             'synthetic-missing-quarter'),
            ($5,$2,to_timestamp($3/1000.0),$4,'statement','fixed','resolved',
             'synthetic-fixed')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId, newKithId()],
  );
  // Another space's source, root, items and gaps: never in this caller's rows.
  await upsertSourceRoot(ctx, {
    principal: f.stranger,
    sourceAccountId: f.otherSourceAccountId,
    kind: "folder",
    area: "Taxes",
  });
  await makeSourceItem(ctx, f.otherSpaceId, f.otherSourceAccountId);
  await makeObservation(ctx, f.otherSpaceId, f.otherSourceAccountId);

  const areas = await listAreaCoverage(ctx, { principal: f.principal });
  // Every starter area is present whether or not anything landed in it.
  for (const name of LIFE_AREAS) {
    assert.ok(
      areas.some((row) => row.area === name),
      `expected the starter area ${name} to be listed`,
    );
  }

  const taxes = areas.find((row) => row.area === "taxes");
  assert.equal(taxes.sources, 1);
  assert.equal(taxes.documents, 2);
  assert.equal(taxes.records, 1);
  assert.equal(taxes.from, "2024-03-01");
  assert.equal(taxes.to, "2026-06-30");
  assert.equal(taxes.gaps, 1);
  assert.deepEqual(taxes.gapReasons, { "missing quarter": 1 });
  assert.equal(taxes.status, "gaps");

  const medical = areas.find((row) => row.area === "medical");
  assert.equal(medical.documents, 0);
  assert.equal(medical.records, 0);
  assert.equal(medical.from, null);
  assert.equal(medical.status, "empty");

  // A reader gets the starter list with nothing in it, never a count.
  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, { spaceId: f.spaceId, userId: readerId, role: "reader" });
  const readerAreas = await listAreaCoverage(ctx, {
    principal: { userId: readerId, credentialId: null },
  });
  assert.equal(readerAreas.length, LIFE_AREAS.length);
  assert.equal(
    readerAreas.every((row) => row.documents === 0 && row.status === "empty"),
    true,
  );
});

test("thoughts, facts and investment entries land in their own areas", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  await ctx.client.query(
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id, memory_status)
     VALUES ($1,$2,to_timestamp($3/1000.0),'synthetic','{}'::jsonb,$5,'current'),
            ($4,$2,to_timestamp($3/1000.0),'superseded','{}'::jsonb,$5,'superseded')`,
    [newKithId(), f.spaceId, NOW, newKithId(), f.userId],
  );
  await ctx.client.query(
    `INSERT INTO kith.facts
       (id, space_id, created_at, user_id, subject_entity_id, predicate,
        value, statement, search_text, source_type, confidence, status)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,'home_city',
             '{"type":"text","value":"Oakland"}'::jsonb,'synthetic',
             'synthetic','user_stated',1,'current')`,
    [newKithId(), f.spaceId, NOW, f.userId, f.entityId],
  );
  const investmentId = newKithId();
  await ctx.client.query(
    `INSERT INTO kith.investments (id, space_id, name) VALUES ($1,$2,'Synthetic Fund')`,
    [investmentId, f.spaceId],
  );
  await ctx.client.query(
    `INSERT INTO kith.investment_entries
       (id, space_id, investment_id, entry_type, entry_date, amount, currency)
     VALUES ($1,$2,$3,'commitment','2025-02-01',100000,'USD'),
            ($4,$2,$3,'capital_call_paid','2026-01-15',25000,'USD')`,
    [newKithId(), f.spaceId, investmentId, newKithId()],
  );

  const areas = await listAreaCoverage(ctx, { principal: f.principal });
  const memory = areas.find((row) => row.area === "notes and facts");
  // The superseded thought is not current memory, so it is not counted.
  assert.equal(memory.records, 2);
  assert.equal(memory.status, "covered");

  const investments = areas.find((row) => row.area === "outside investments");
  assert.equal(investments.sources, 1);
  assert.equal(investments.records, 2);
  assert.equal(investments.from, "2025-02-01");
  assert.equal(investments.to, "2026-01-15");
});

test(
  "the Epic feed's inventory folds into the medical row, owner-global",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const ctx = f.ctx(NOW);

    const sourceId = await makeHealthSource(ctx, f.entityId, f.spaceId);
    const recordId = await makeHealthRecord(ctx, sourceId, f.entityId, {
      effectiveAt: "2026-01-15T00:00:00Z",
    });
    await makeHealthRecord(ctx, sourceId, f.entityId, {
      resourceType: "Condition",
      effectiveAt: "2025-11-01T00:00:00Z",
    });
    await makeHealthDocument(ctx, recordId, f.entityId);

    // A document-area tag on the same source account, so the merge is
    // proven to add rather than replace what `listAreaCoverage` already
    // found for `medical`.
    await upsertSourceRoot(ctx, {
      principal: f.principal,
      sourceAccountId: f.sourceAccountId,
      kind: "folder",
      area: "Medical",
    });
    await makeSourceItem(ctx, f.spaceId, f.sourceAccountId);

    const contribution = await healthContribution(ctx);
    assert.deepEqual(contribution, {
      sources: 1,
      documents: 1,
      records: 2,
      from: "2025-11-01",
      to: "2026-01-15",
    });

    const areas = await listAreaCoverage(ctx, { principal: f.principal });
    const merged = mergeHealthIntoAreas(areas, contribution);
    const medical = merged.find((row) => row.area === "medical");
    // 1 from the folder tag, plus the feed's own.
    assert.equal(medical.sources, 2);
    assert.equal(medical.documents, 2);
    assert.equal(medical.records, 2);
    assert.equal(medical.from, "2025-11-01");
    assert.equal(medical.to, "2026-01-15");
    assert.equal(medical.status, "covered");

    // Every other row is untouched by the merge.
    for (const row of merged) {
      if (row.area === "medical") continue;
      assert.deepEqual(
        row,
        areas.find((original) => original.area === row.area),
      );
    }

    // Owner-global like `listHealthOverview`: a stranger administering their
    // own, unrelated space still folds in the same feed inventory, because
    // neither `health_records` nor `health_documents` carries a space to
    // narrow this to.
    const strangerAreas = await listAreaCoverage(ctx, {
      principal: f.stranger,
    });
    const strangerMerged = mergeHealthIntoAreas(strangerAreas, contribution);
    const strangerMedical = strangerMerged.find((row) => row.area === "medical");
    assert.equal(strangerMedical.sources, 1);
    assert.equal(strangerMedical.documents, 1);
    assert.equal(strangerMedical.records, 2);

    // `null` (no contribution) changes nothing, same as `mergeFinanceIntoAreas`.
    assert.deepEqual(mergeHealthIntoAreas(areas, null), areas);
  },
);

test("migration 024's triggers put every health and coverage table on the feed", { skip }, async (t) => {
  const f = await fixture(t);
  const ctx = f.ctx(NOW);
  const cursor = await latestChangeId(ctx, [f.spaceId]);

  await makeDeferredWork(ctx, f.spaceId, { state: "queued" });
  await makeObservation(ctx, f.spaceId, f.sourceAccountId);
  await ctx.client.query(
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id)
     VALUES ($1,$2,to_timestamp($3/1000.0),'synthetic','{}'::jsonb,$4)`,
    [newKithId(), f.spaceId, NOW, f.userId],
  );
  await ctx.client.query(
    `INSERT INTO kith.facts
       (id, space_id, created_at, user_id, subject_entity_id, predicate,
        value, statement, search_text, source_type, confidence, status)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,'home_city',
             '{"type":"text","value":"Oakland"}'::jsonb,'synthetic',
             'synthetic','user_stated',1,'current')`,
    [newKithId(), f.spaceId, NOW, f.userId, f.entityId],
  );
  await ctx.client.query(
    `INSERT INTO kith.coverage_windows
       (id, space_id, created_at, source_account_id, record_type)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'statement')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );
  await ctx.client.query(
    `INSERT INTO kith.coverage_gaps
       (id, space_id, created_at, source_account_id, reason, status,
        condition_key)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'missing','open',
             'synthetic-change-feed-gap')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );
  await ctx.client.query(
    `INSERT INTO kith.card_entity_bindings
       (id, space_id, created_at, source_account_id, status, candidate_count)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'pending',0)`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );
  await ctx.client.query(
    `INSERT INTO kith.card_field_drops
       (id, space_id, created_at, source_account_id, kind, code)
     VALUES ($1,$2,to_timestamp($3/1000.0),$4,'field_dropped','not_on_page')`,
    [newKithId(), f.spaceId, NOW, f.sourceAccountId],
  );

  const changes = await listChangesSince(ctx, [f.spaceId], cursor);
  const tables = new Set(changes.map((change) => change.table));
  for (const table of [
    "deferred_work",
    "observations",
    "thoughts",
    "facts",
    "coverage_windows",
    "coverage_gaps",
    "card_entity_bindings",
    "card_field_drops",
  ]) {
    assert.ok(tables.has(table), `expected a change row for ${table}`);
  }

  // The feed carries ids and table names and never a row's content.
  for (const change of changes) {
    assert.deepEqual(Object.keys(change).sort(), ["id", "op", "rowId", "table"]);
  }
});
