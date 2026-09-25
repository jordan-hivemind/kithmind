import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTaxPayment } from "../dist/admin/index.js";
import * as memory from "../dist/memory/index.js";
import { coverage, newKithId } from "../dist/index.js";
import { webPrincipal } from "../dist/identity/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/memoryFixture.mjs";

async function applyProfilesMigration(ctx) {
  const present = await ctx.client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'kith' AND table_name = 'entities'
        AND column_name = 'merged_into'`,
  );
  if (present.rowCount === 0) {
    await ctx.client.query(
      await readFile(
        new URL("../migrations/039_profiles.sql", import.meta.url),
        "utf8",
      ),
    );
  }
}

test(
  "profiles reuse aliases, resolve relationships, expose typed history, and support vehicles",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      await applyProfilesMigration(ctx);
      const userId = await makeUser(ctx);
      const outsiderId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const principal = webPrincipal(userId);
      const outsider = webPrincipal(outsiderId);

      const me = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Rowan Example",
        aliases: ["Rowan"],
      });
      assert.equal(me.created, true);
      await memory.linkMeToPerson(ctx, {
        principal,
        spaceId,
        entityId: me.entity.id,
      });

      const child = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Alex Example",
        aliases: ["Alex"],
      });
      const reused = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Alex",
        aliases: ["Lex"],
      });
      assert.equal(reused.created, false);
      assert.equal(reused.entity.id, child.entity.id);
      await assert.rejects(
        memory.getEntityProfile(ctx, outsider, spaceId, {
          entityId: child.entity.id,
        }),
        /Space not found/,
      );
      await assert.rejects(
        memory.updateNamedEntity(ctx, {
          principal: outsider,
          entityId: child.entity.id,
          name: "Unauthorized rename",
        }),
        /Entity not found/,
      );

      const samRivera = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Sam Rivera",
        aliases: ["Sam"],
      });
      const samChen = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Sam Chen",
        aliases: ["Sam"],
      });
      assert.notEqual(
        samRivera.entity.id,
        samChen.entity.id,
        "an incoming alias does not prove identity",
      );
      await memory.updateNamedEntity(ctx, {
        principal,
        entityId: samChen.entity.id,
        aliases: ["Sam", "Samuel"],
      });
      await assert.rejects(
        memory.getEntityProfile(ctx, principal, spaceId, {
          kind: "person",
          name: "Sam",
        }),
        /Profile entity is ambiguous/,
        "a shared alias stays ambiguous",
      );

      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: me.entity.key,
          kind: "person",
          name: me.entity.canonicalName,
        },
        predicate: "child",
        value: {
          type: "entity",
          entity: {
            key: child.entity.key,
            kind: "person",
            name: child.entity.canonicalName,
          },
        },
        sourceType: "user_confirmed",
        cardinality: "multiple",
      });
      const firstName = await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: child.entity.key,
          kind: "person",
          name: child.entity.canonicalName,
        },
        predicate: "preferred_name",
        value: { type: "text", value: "Al" },
        sourceType: "user_stated",
      });
      const correctedName = await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: child.entity.key,
          kind: "person",
          name: child.entity.canonicalName,
        },
        predicate: "preferred_name",
        value: { type: "text", value: "Alex" },
        sourceType: "user_confirmed",
        changeKind: "corrected",
      });
      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: child.entity.key,
          kind: "person",
          name: child.entity.canonicalName,
        },
        predicate: "ssn",
        value: { type: "text", value: "999-88-7777" },
        sourceType: "user_confirmed",
      });
      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: child.entity.key,
          kind: "person",
          name: child.entity.canonicalName,
        },
        predicate: "favorite_snack",
        value: { type: "text", value: "Synthetic crackers" },
        sourceType: "user_confirmed",
      });

      const profile = await memory.getEntityProfile(ctx, principal, spaceId, {
        relationship: "child",
      });
      assert.equal(profile.entity.id, child.entity.id);
      await assert.rejects(
        memory.getEntityProfile(ctx, principal, spaceId, {
          relationship: "son",
        }),
        /Relationship is not recorded/,
        "a generic child fact does not guess a qualified son relationship",
      );
      const preferred = profile.fields.find(
        (field) => field.factId === correctedName.factId,
      );
      assert.equal(preferred.historyAvailable, true);
      assert.deepEqual(preferred.historyFactIds, [firstName.factId]);
      assert.equal(
        profile.fields.find((field) => field.predicate === "ssn").value.value,
        "999-88-7777",
      );
      assert.equal(
        profile.fields.find((field) => field.predicate === "ssn").sensitivity,
        "restricted",
      );
      assert.equal(
        profile.fields.find((field) => field.predicate === "favorite_snack")
          .value.value,
        "Synthetic crackers",
        "custom predicates remain readable",
      );

      const anotherChild = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Morgan Example",
      });
      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: me.entity.key,
          kind: "person",
          name: me.entity.canonicalName,
        },
        predicate: "daughter",
        value: {
          type: "entity",
          entity: {
            key: anotherChild.entity.key,
            kind: "person",
            name: anotherChild.entity.canonicalName,
          },
        },
        sourceType: "user_confirmed",
        cardinality: "multiple",
      });
      await assert.rejects(
        memory.getEntityProfile(ctx, principal, spaceId, {
          relationship: "child",
        }),
        /Relationship is ambiguous/,
        "generic child includes qualified child relationships",
      );
      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: me.entity.key,
          kind: "person",
          name: me.entity.canonicalName,
        },
        predicate: "spouse",
        value: {
          type: "entity",
          entity: {
            key: samRivera.entity.key,
            kind: "person",
            name: samRivera.entity.canonicalName,
          },
        },
        sourceType: "user_confirmed",
      });
      await assert.rejects(
        memory.getEntityProfile(ctx, principal, spaceId, {
          relationship: "husband",
        }),
        /Relationship is not recorded/,
        "a generic spouse fact does not guess a qualified husband relationship",
      );

      const sourceItemId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.source_items
         (id, space_id, created_at, title, doc_type, lifecycle, desired_processing_epoch)
       VALUES ($1, $2, transaction_timestamp(), 'Synthetic service record',
               'vehicle_service', 'available', 1)`,
        [sourceItemId, spaceId],
      );
      const linked = await memory.linkProfileDocument(ctx, {
        principal,
        entityId: child.entity.id,
        sourceItemId,
      });
      const withDocument = await memory.getEntityProfile(
        ctx,
        principal,
        spaceId,
        { entityId: child.entity.id },
      );
      assert.equal(withDocument.documents[0].sourceItemId, sourceItemId);
      assert.equal(
        withDocument.documents[0].citation,
        `source:${sourceItemId}`,
      );
      const linkField = withDocument.fields.find(
        (field) => field.predicate === "supporting_document",
      );
      assert.equal(linkField.factId, linked.factId);
      await memory.retireFact(ctx, spaceId, linkField.factId);
      const withoutDocument = await memory.getEntityProfile(
        ctx,
        principal,
        spaceId,
        { entityId: child.entity.id },
      );
      assert.equal(
        withoutDocument.documents.length,
        0,
        "retiring the link fact unlinks without deleting the source",
      );
      assert.equal(
        (
          await ctx.client.query(
            "SELECT count(*)::int AS count FROM kith.source_items WHERE id = $1",
            [sourceItemId],
          )
        ).rows[0].count,
        1,
      );

      const vehicle = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "vehicle",
        name: "Blue Car",
      });
      for (const [predicate, value] of [
        ["vin", { type: "text", value: "1M8GDM9AXKP042788" }],
        ["make", { type: "text", value: "Toyota" }],
        ["model", { type: "text", value: "RAV4" }],
        ["year", { type: "number", value: 2024 }],
        ["plate", { type: "text", value: "SYNTH24" }],
        ["purchased_on", { type: "date", value: "2026-01-15" }],
      ]) {
        await memory.rememberFact(ctx, userId, spaceId, {
          subject: {
            key: vehicle.entity.key,
            kind: "vehicle",
            name: vehicle.entity.canonicalName,
          },
          predicate,
          value,
          sourceType: "user_confirmed",
        });
      }
      const vehicleProfile = await memory.getEntityProfile(
        ctx,
        principal,
        spaceId,
        { entityId: vehicle.entity.id },
      );
      assert.equal(vehicleProfile.entity.canonicalName, "Blue Car");
      assert.deepEqual(
        new Set(vehicleProfile.fields.map((field) => field.predicate)),
        new Set(["vin", "make", "model", "year", "plate", "purchased_on"]),
      );
    });
  },
);

test(
  "explicit merge preserves facts, references, aliases, old IDs, conflicts, and space isolation",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      await applyProfilesMigration(ctx);
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const otherSpaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const principal = webPrincipal(userId);
      const aliases = (prefix) =>
        Array.from({ length: 15 }, (_, index) => `${prefix} ${index}`);
      const target = await memory.resolveEntity(ctx, userId, spaceId, {
        key: "person:alex",
        kind: "person",
        name: "Alex Example",
        aliases: aliases("Target alias"),
      });
      const source = await memory.resolveEntity(ctx, userId, spaceId, {
        key: "person:alex-duplicate",
        kind: "person",
        name: "A. Example",
        aliases: aliases("Source alias"),
      });
      const targetFact = await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: target.key,
          kind: "person",
          name: target.canonicalName,
        },
        predicate: "preferred_name",
        value: { type: "text", value: "Alex" },
        sourceType: "user_confirmed",
      });
      const sourceFact = await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: source.key,
          kind: "person",
          name: source.canonicalName,
        },
        predicate: "preferred_name",
        value: { type: "text", value: "Lex" },
        sourceType: "user_confirmed",
      });
      const relationship = await memory.rememberFact(ctx, userId, spaceId, {
        subject: { kind: "person", name: "Synthetic Relative" },
        predicate: "sibling",
        value: {
          type: "entity",
          entity: {
            key: source.key,
            kind: "person",
            name: source.canonicalName,
          },
        },
        sourceType: "user_confirmed",
        cardinality: "multiple",
      });

      const foreign = await memory.rememberFact(ctx, userId, otherSpaceId, {
        subject: { kind: "person", name: "Foreign Synthetic" },
        predicate: "custom_pointer",
        value: { type: "text", value: "unrelated" },
        sourceType: "user_confirmed",
      });
      await ctx.client.query(
        "UPDATE kith.facts SET value = $1::jsonb WHERE id = $2",
        [
          JSON.stringify({ type: "entity", entityId: source.id }),
          foreign.factId,
        ],
      );

      const taxPayment = await createTaxPayment(ctx, {
        principal,
        spaceId,
        payer: {
          key: source.key,
          kind: "person",
          name: source.canonicalName,
        },
        authority: "us_federal",
        paymentKind: "estimated_income",
        taxYear: 2026,
        amount: "500.00",
        currency: "USD",
        submittedOn: "2026-09-01",
        confirmationNumber: "CONF-MERGE-SYNTHETIC-1",
      });
      const healthSourceId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.health_sources
           (id, person_id, space_id, org_name, fhir_base, patient_fhir_id,
            keychain_service, scopes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          healthSourceId,
          source.id,
          spaceId,
          "Synthetic Health System",
          "https://fhir.example.test/synthetic",
          "patient-synthetic",
          "com.kithmind.epic.token.synthetic",
          "patient/*.read",
        ],
      );
      const healthRecordId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.health_records
           (id, source_id, person_id, resource_type, fhir_id, raw)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          healthRecordId,
          healthSourceId,
          source.id,
          "Observation",
          "obs-synthetic",
          JSON.stringify({ resourceType: "Observation" }),
        ],
      );
      const healthDocumentId = newKithId();
      await ctx.client.query(
        `INSERT INTO kith.health_documents
           (id, record_id, person_id, content_type, byte_length)
         VALUES ($1,$2,$3,$4,$5)`,
        [healthDocumentId, healthRecordId, source.id, "text/plain", 42],
      );

      const merged = await memory.mergeEntities(ctx, {
        principal,
        sourceEntityId: source.id,
        targetEntityId: target.id,
      });
      assert.equal(merged.entity.id, target.id);
      assert.equal(merged.mergedEntityId, source.id);
      assert.equal(merged.conflicts.length, 1);
      assert.equal(merged.conflicts[0].predicate, "preferred_name");
      assert.deepEqual(
        [...merged.conflicts[0].factIds].sort(),
        [sourceFact.factId, targetFact.factId].sort(),
      );
      assert.equal(
        merged.entity.aliases.length,
        31,
        "both alias sets and the losing canonical name survive",
      );
      assert.equal(merged.repointed.taxPayments, 1);
      assert.equal(merged.repointed.healthSources, 1);
      assert.equal(merged.repointed.healthRecords, 1);
      assert.equal(merged.repointed.healthDocuments, 1);
      const movedTaxPayment = await ctx.client.query(
        "SELECT payer_entity_id FROM kith.tax_payments WHERE id = $1",
        [taxPayment.paymentId],
      );
      assert.equal(movedTaxPayment.rows[0].payer_entity_id, target.id);
      const movedHealthSource = await ctx.client.query(
        "SELECT person_id FROM kith.health_sources WHERE id = $1",
        [healthSourceId],
      );
      assert.equal(movedHealthSource.rows[0].person_id, target.id);
      const movedHealthRecord = await ctx.client.query(
        "SELECT person_id FROM kith.health_records WHERE id = $1",
        [healthRecordId],
      );
      assert.equal(movedHealthRecord.rows[0].person_id, target.id);
      const movedHealthDocument = await ctx.client.query(
        "SELECT person_id FROM kith.health_documents WHERE id = $1",
        [healthDocumentId],
      );
      assert.equal(movedHealthDocument.rows[0].person_id, target.id);
      await memory.rememberFact(ctx, userId, spaceId, {
        subject: {
          key: target.key,
          kind: "person",
          name: target.canonicalName,
          aliases: ["Newest alias"],
        },
        predicate: "email_address",
        value: { type: "text", value: "alex@example.test" },
        sourceType: "user_confirmed",
        cardinality: "multiple",
      });
      const renamed = await memory.updateNamedEntity(ctx, {
        principal,
        entityId: target.id,
        name: "Alex Renamed",
      });
      assert.equal(
        renamed.aliases.length,
        33,
        "later writes and a rename do not truncate merged aliases",
      );
      const oldIdProfile = await memory.getEntityProfile(
        ctx,
        principal,
        spaceId,
        { entityId: source.id },
      );
      assert.equal(
        oldIdProfile.entity.id,
        target.id,
        "old id resolves to the survivor",
      );
      const movedSource = await memory.getStoredFact(ctx, sourceFact.factId);
      assert.equal(movedSource.subjectEntityId, target.id);
      const movedRelationship = await memory.getStoredFact(
        ctx,
        relationship.factId,
      );
      assert.equal(movedRelationship.value.entityId, target.id);
      const untouchedForeign = await memory.getStoredFact(ctx, foreign.factId);
      assert.equal(
        untouchedForeign.value.entityId,
        source.id,
        "a corrupted cross-space pointer is not rewritten",
      );
      const listed = await memory.listEntities(ctx, [spaceId], {
        kind: "person",
      });
      assert.equal(
        listed.entities.some((entity) => entity.id === source.id),
        false,
      );

      const finalTarget = await memory.resolveEntity(ctx, userId, spaceId, {
        key: "person:alex-final",
        kind: "person",
        name: "Alex Final",
      });
      await memory.mergeEntities(ctx, {
        principal,
        sourceEntityId: target.id,
        targetEntityId: finalTarget.id,
      });
      const twiceMergedProfile = await memory.getEntityProfile(
        ctx,
        principal,
        spaceId,
        {
          entityId: source.id,
        },
      );
      assert.equal(twiceMergedProfile.entity.id, finalTarget.id);
      const mergePointers = await ctx.client.query(
        "SELECT id, merged_into FROM kith.entities WHERE id = ANY($1::text[]) ORDER BY id",
        [[source.id, target.id]],
      );
      assert.deepEqual(
        mergePointers.rows.map((entity) => entity.merged_into),
        [finalTarget.id, finalTarget.id],
        "repeat merges flatten old IDs to the final survivor",
      );
    });
  },
);

test(
  "entity merge preserves coverage occurrences and accepts repeated detection through old IDs",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx);
      const spaceId = await makeSpace(ctx, {
        createdBy: userId,
        role: "owner",
      });
      const principal = webPrincipal(userId);
      const source = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Alex One",
      });
      const target = await memory.createNamedEntity(ctx, {
        principal,
        spaceId,
        kind: "person",
        name: "Alex Two",
      });
      const accountId = newKithId();
      await ctx.client.query(
        "INSERT INTO kith.source_accounts(id,space_id,created_at,name,connector,account_id,enabled,freshness_ms) VALUES($1,$2,transaction_timestamp(),'Synthetic','filesystem','synthetic',true,1000)",
        [accountId, spaceId],
      );
      const input = {
        spaceId,
        sourceAccountId: accountId,
        recordType: "lab",
        from: 0,
        to: 100,
        reason: "missing_period",
        detectedAt: ctx.now - 10,
      };
      const oldGap = await coverage.openCoverageGap(ctx, {
        ...input,
        entityId: source.entity.id,
      });
      await coverage.acknowledgeCoverageGap(ctx, {
        principal,
        gapId: oldGap,
        action: "mark_unavailable",
      });
      const a = await coverage.openCoverageGap(ctx, {
        ...input,
        entityId: source.entity.id,
      });
      const b = await coverage.openCoverageGap(ctx, {
        ...input,
        entityId: target.entity.id,
      });
      const window = {
        spaceId,
        sourceAccountId: accountId,
        recordType: "lab",
        from: 0,
        to: 100,
        state: "partial",
        lastEnumeratedAt: ctx.now,
        lastProcessedAt: ctx.now,
        discoveredCount: 2,
        indexedCount: 1,
        skippedCount: 1,
      };
      const w1 = await coverage.upsertCoverageWindow(ctx, {
        ...window,
        entityId: source.entity.id,
      });
      const w2 = await coverage.upsertCoverageWindow(ctx, {
        ...window,
        entityId: target.entity.id,
      });
      await memory.mergeEntities(ctx, {
        principal,
        sourceEntityId: source.entity.id,
        targetEntityId: target.entity.id,
      });
      const gaps = await ctx.client.query(
        "SELECT id, entity_id, status, condition_key FROM kith.coverage_gaps WHERE space_id=$1",
        [spaceId],
      );
      assert.equal(gaps.rowCount, 3);
      assert.ok(gaps.rows.every((gap) => gap.entity_id === target.entity.id));
      assert.equal(gaps.rows.filter((gap) => gap.status === "open").length, 2);
      assert.equal(
        new Set(
          gaps.rows
            .filter((gap) => gap.status === "open")
            .map((gap) => gap.condition_key),
        ).size,
        2,
      );
      const actions = await ctx.client.query(
        "SELECT coverage_gap_id, action FROM kith.coverage_gap_actions WHERE space_id=$1",
        [spaceId],
      );
      assert.deepEqual(actions.rows, [
        { coverage_gap_id: oldGap, action: "mark_unavailable" },
      ]);
      const detected = await coverage.openCoverageGap(ctx, {
        ...input,
        entityId: source.entity.id,
        detectedAt: ctx.now,
      });
      assert.ok([a, b].includes(detected));
      assert.equal(
        await coverage.openCoverageGap(ctx, {
          ...input,
          entityId: target.entity.id,
          detectedAt: ctx.now,
        }),
        detected,
      );
      await coverage.upsertCoverageWindow(ctx, {
        ...window,
        entityId: source.entity.id,
        state: "complete",
        indexedCount: 2,
        skippedCount: 0,
      });
      const windows = await ctx.client.query(
        "SELECT id, state FROM kith.coverage_windows WHERE space_id=$1 ORDER BY id",
        [spaceId],
      );
      assert.deepEqual(
        windows.rows.map((row) => row.id),
        [w1, w2].sort(),
      );
      assert.ok(windows.rows.every((row) => row.state === "complete"));
      const args = {
        spaceId,
        sourceAccountIds: [accountId],
        recordType: "lab",
        from: 0,
        to: 100,
        now: ctx.now,
        snapshotAt: ctx.now,
      };
      const throughOld = await coverage.calculateCoverage(ctx, {
        ...args,
        entityId: source.entity.id,
      });
      const throughNew = await coverage.calculateCoverage(ctx, {
        ...args,
        entityId: target.entity.id,
      });
      assert.deepEqual(throughOld, throughNew);
      assert.equal(throughOld.knownGaps.length, 2);
    });
  },
);
