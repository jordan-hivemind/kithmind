import assert from "node:assert/strict";
import test from "node:test";

import * as embeddings from "../dist/embeddings/index.js";
import * as memory from "../dist/memory/index.js";
import { identityDatabase, makeSpace, makeUser, skip } from "./helpers/memoryFixture.mjs";

const metadata = (summary, type = "reference") => ({
  type,
  topics: ["synthetic"],
  people: [],
  actionItems: [],
  summary,
});

test("facts retain history, corrections stay withheld, and entity values cannot cross a space", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const otherSpaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const first = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan", aliases: ["R. Example"] },
      predicate: "home_city",
      value: { type: "text", value: "Oakland" },
      sourceType: "user_stated",
      isCore: true,
      validFrom: 1_700_000_000_000,
    });
    const second = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "home_city",
      value: { type: "text", value: "Berkeley" },
      sourceType: "user_confirmed",
      validFrom: 1_710_000_000_000,
      changeKind: "changed",
    });
    assert.equal(second.operation, "superseded");
    assert.equal((await memory.listFacts(ctx, [spaceId], { includeHistorical: false }))[0].id, second.factId);
    assert.deepEqual(
      (await memory.listFacts(ctx, [spaceId], { includeHistorical: true })).map((fact) => fact.id).sort(),
      [first.factId, second.factId].sort(),
    );

    const correction = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "home_city",
      value: { type: "text", value: "Albany" },
      sourceType: "user_confirmed",
      changeKind: "corrected",
    });
    assert.equal(correction.operation, "corrected");
    const historical = await memory.listFacts(ctx, [spaceId], { includeHistorical: true });
    assert.equal(historical.some((fact) => fact.id === second.factId), false, "retracted facts are never history");
    await ctx.client.query("UPDATE kith.facts SET supersedes = $1::jsonb WHERE id = $2", [
      JSON.stringify([123]),
      correction.factId,
    ]);
    assert.equal(await memory.getFactById(ctx, [spaceId], correction.factId), null);
    await ctx.client.query("UPDATE kith.facts SET supersedes = $1::jsonb WHERE id = $2", [
      JSON.stringify([second.factId]),
      correction.factId,
    ]);

    const foreignEntity = await memory.resolveEntity(ctx, userId, otherSpaceId, {
      kind: "person",
      name: "Foreign person",
    });
    // The JSON representation cannot carry a foreign key. A corrupted value
    // must therefore be withheld by hydration rather than leaking a foreign
    // entity into a fact returned from this space.
    await ctx.client.query("UPDATE kith.facts SET value = $1::jsonb WHERE id = $2", [
      JSON.stringify({ type: "entity", entityId: foreignEntity.id }),
      correction.factId,
    ]);
    assert.equal(await memory.getFactById(ctx, [spaceId], correction.factId), null);
    assert.equal(await memory.getFactById(ctx, [otherSpaceId], correction.factId), null);
  });
});

test("thought transitions, authorized candidate hydration, and recall blending preserve lifecycle and rank order", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const otherSpaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const coreThought = await memory.captureThought(ctx, userId, spaceId, {
      content: "Keep the synthetic household ledger current.",
      metadata: metadata("ledger", "decision"),
      isCore: true,
    });
    const oldThought = await memory.captureThought(ctx, userId, spaceId, {
      content: "The old archive is the current reference.",
      metadata: metadata("old archive"),
    });
    const currentThought = await memory.transitionMemory(
      ctx,
      userId,
      spaceId,
      { content: "The current archive is the verified reference.", metadata: metadata("current archive") },
      [oldThought],
      "superseded",
      "Verified replacement",
      ctx.now,
    );
    const foreignThought = await memory.captureThought(ctx, userId, otherSpaceId, {
      content: "Foreign archive candidate.",
      metadata: metadata("foreign"),
    });

    assert.deepEqual(
      (await memory.getThoughtsByIds(ctx, [spaceId], [foreignThought, currentThought, oldThought])).map((thought) => thought.id),
      [currentThought],
    );
    assert.deepEqual(
      (await memory.getThoughtsByIds(ctx, [spaceId], [oldThought], { includeHistorical: true })).map((thought) => thought.id),
      [oldThought],
    );

    // Imported/corrupt history is not a foreign-key relationship. Every read
    // path must withhold it when it names another space, a missing row, or a
    // list larger than the transition contract's ten links.
    await ctx.client.query("UPDATE kith.thoughts SET supersedes = $1::jsonb WHERE id = $2", [JSON.stringify([foreignThought]), currentThought]);
    assert.deepEqual((await memory.getThoughtsByAuthorizedIds(ctx, [spaceId], [currentThought])).map((thought) => thought.id), []);
    assert.deepEqual((await memory.listBySpaces(ctx, [spaceId], 10)).map((thought) => thought.id).includes(currentThought), false);
    await ctx.client.query("UPDATE kith.thoughts SET supersedes = $1::jsonb WHERE id = $2", [JSON.stringify(Array(11).fill(oldThought)), currentThought]);
    assert.deepEqual((await memory.getThoughtsByIds(ctx, [spaceId], [currentThought], { includeHistorical: true })).map((thought) => thought.id), []);
    await ctx.client.query("UPDATE kith.thoughts SET supersedes = $1::jsonb WHERE id = $2", [JSON.stringify(["z".repeat(26)]), currentThought]);
    assert.deepEqual((await memory.getThoughtsByIds(ctx, [spaceId], [currentThought], { includeHistorical: true })).map((thought) => thought.id), []);
    await assert.rejects(
      memory.transitionMemory(ctx, userId, spaceId, { content: "Invalid status", metadata: metadata("invalid") }, [coreThought], "current", "bad", ctx.now),
      /superseded or retracted/,
    );
    await ctx.client.query("UPDATE kith.thoughts SET supersedes = $1::jsonb WHERE id = $2", [JSON.stringify([oldThought]), currentThought]);

    const fact = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "archive_owner",
      value: { type: "text", value: "Jordan" },
      sourceType: "user_confirmed",
      isCore: true,
    });
    const recall = await memory.recallContext(
      ctx,
      [spaceId],
      { factIds: [fact.factId], thoughtIds: [foreignThought, currentThought, oldThought] },
      { limit: 5 },
    );
    assert.deepEqual(recall.coreFacts.map((item) => item.id), [fact.factId]);
    assert.deepEqual(recall.coreThoughts.map((item) => item.id), [coreThought]);
    assert.deepEqual(recall.relevanceThoughts.map((item) => item.id), [currentThought]);
  });
});

test("recallCandidates feeds recallContext from the real indexes", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const otherSpaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const relevant = await memory.captureThought(ctx, userId, spaceId, {
      content: "The archive migration runs on Sunday.",
      metadata: metadata("archive migration"),
    });
    await memory.captureThought(ctx, userId, spaceId, {
      content: "Lunch is at noon.",
      metadata: metadata("lunch"),
    });
    const foreignThought = await memory.captureThought(ctx, userId, otherSpaceId, {
      content: "The archive migration runs on Sunday.",
      metadata: metadata("foreign archive migration"),
    });
    const relevantFact = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "project", name: "Archive" },
      predicate: "migration_window",
      value: { type: "text", value: "Sunday" },
      sourceType: "user_confirmed",
    });
    await memory.rememberFact(ctx, userId, otherSpaceId, {
      subject: { kind: "project", name: "Archive" },
      predicate: "migration_window",
      value: { type: "text", value: "Sunday" },
      sourceType: "user_confirmed",
    });

    // No embedder: the vector leg is off, the keyword legs are the answer,
    // and `vectorStatus` says so rather than pretending otherwise.
    const candidates = await embeddings.recallCandidates(ctx, [spaceId], "migrations");
    assert.equal(candidates.vectorStatus, "unavailable");
    assert.deepEqual(candidates.factIds, [relevantFact.factId]);
    assert.deepEqual(candidates.thoughtIds, [relevant]);
    assert.equal(candidates.thoughtIds.includes(foreignThought), false);
    // P2-39i3: the fused score comes back with the ids, because hydration by
    // id cannot recover it and `recall_context` reports it on every relevance
    // thought it returns.
    assert.deepEqual([...candidates.thoughtScores.keys()], [relevant]);
    assert.equal(typeof candidates.thoughtScores.get(relevant), "number");

    const recall = await memory.recallContext(ctx, [spaceId], candidates, { limit: 5 });
    assert.deepEqual(recall.relevanceFacts.map((item) => item.id), [relevantFact.factId]);
    assert.deepEqual(recall.relevanceThoughts.map((item) => item.id), [relevant]);

    // An empty authorized set is not a query that searches everything.
    assert.deepEqual(await embeddings.recallCandidates(ctx, [], "migrations"), {
      factIds: [],
      thoughtIds: [],
      thoughtScores: new Map(),
      vectorStatus: "unavailable",
    });
  });
});

test("thoughts with identical createdAt are ordered by id ascending", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    // Insert two thoughts in the same transaction with the same timestamp.
    // Use fixed createdAt to ensure identical timestamps.
    const fixedTimestamp = new Date(ctx.now);
    const firstContent = "First thought content";
    const secondContent = "Second thought content";

    const ids = [];
    for (const content of [firstContent, secondContent]) {
      const id = await memory.captureThought(ctx, userId, spaceId, {
        content,
        metadata: metadata(content, "reference"),
      });
      ids.push(id);
    }

    // Ensure the test is meaningful: both thoughts should have the same created_at
    const thoughts = await memory.listBySpaces(ctx, [spaceId], 10);
    assert.equal(thoughts.length, 2, "Should have captured 2 thoughts");
    const timestamps = thoughts.map(t => t.createdAt);
    assert.equal(timestamps[0], timestamps[1], "Both thoughts should have same createdAt");

    // The critical assertion: when createdAt is identical, results must be ordered by id ascending.
    // localeCompare with string IDs provides lexicographic ordering, which is consistent
    // with Convex's behavior where _id.localeCompare is used for the tie-break.
    const sortedIds = thoughts.map(t => t.id);
    const expectedIds = [...ids].sort();
    assert.deepEqual(sortedIds, expectedIds, "Thoughts with same createdAt must be ordered by id ascending");
  });
});

test("updateThought edits through supersession and deleteThought retracts without a replacement", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const otherSpaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const original = await memory.captureThought(ctx, userId, spaceId, {
      content: "The archive lives on the old drive.",
      metadata: metadata("archive location", "reference"),
      isCore: true,
    });

    const edited = await memory.updateThought(ctx, userId, spaceId, original, {
      content: "The archive lives on the new drive.",
      type: "reference",
      topics: ["archive", "storage"],
      people: [],
    });
    assert.notEqual(edited, original);

    // The edit is a supersession: the old content survives as history and a
    // current read returns only the new content.
    const current = await memory.listBySpaces(ctx, [spaceId], 10);
    assert.deepEqual(current.map((thought) => thought.id), [edited]);
    assert.equal(current[0].content, "The archive lives on the new drive.");
    assert.equal(current[0].isCore, true, "isCore carries over from the edited thought");

    const historical = await memory.listBySpaces(ctx, [spaceId], 10, true);
    assert.deepEqual(historical.map((thought) => thought.id).sort(), [edited, original].sort());
    const previous = await memory.getThoughtById(ctx, original);
    assert.equal(previous.memoryStatus, "superseded");
    assert.equal(previous.content, "The archive lives on the old drive.");

    // Editing a thought that is no longer current, or not in this space, is
    // refused.
    await assert.rejects(
      memory.updateThought(ctx, userId, spaceId, original, {
        content: "second edit",
        type: "reference",
        topics: [],
        people: [],
      }),
      /Current thought not found/,
    );
    const foreign = await memory.captureThought(ctx, userId, otherSpaceId, {
      content: "Not this space's thought.",
      metadata: metadata("foreign"),
    });
    await assert.rejects(
      memory.updateThought(ctx, userId, spaceId, foreign, {
        content: "stolen edit",
        type: "reference",
        topics: [],
        people: [],
      }),
      /Current thought not found/,
    );

    // Delete retracts without a replacement: the row survives, a current read
    // withholds it, and its content is preserved rather than erased. It is
    // withheld from history too, unlike `original`, which is superseded (was
    // true once) rather than retracted (never was) and so still appears.
    await memory.deleteThought(ctx, spaceId, edited);
    assert.deepEqual(await memory.listBySpaces(ctx, [spaceId], 10), []);
    assert.deepEqual(
      (await memory.listBySpaces(ctx, [spaceId], 10, true)).map((thought) => thought.id),
      [original],
    );
    const deleted = await memory.getThoughtById(ctx, edited);
    assert.equal(deleted.memoryStatus, "retracted");
    assert.equal(
      deleted.content,
      "The archive lives on the new drive.",
      "content is preserved, not erased",
    );

    await assert.rejects(
      memory.deleteThought(ctx, spaceId, edited),
      /Current thought not found/,
      "deleting an already-retracted thought is refused, not a silent no-op",
    );
  });
});

test("updateFact corrects through the existing versioning path and refuses a multi-valued predicate", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const first = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "home_city",
      value: { type: "text", value: "Oakland" },
      sourceType: "user_stated",
      isCore: true,
    });

    const corrected = await memory.updateFact(ctx, userId, spaceId, first.factId, {
      value: { type: "text", value: "Berkeley" },
      sourceType: "user_confirmed",
    });
    assert.equal(corrected.operation, "corrected");
    assert.notEqual(corrected.factId, first.factId);

    const current = await memory.listFacts(ctx, [spaceId], { includeHistorical: false });
    assert.deepEqual(current.map((fact) => fact.id), [corrected.factId]);
    assert.equal(current[0].value.value, "Berkeley");
    assert.equal(current[0].isCore, true, "isCore carries over from the corrected fact");

    // The old value is retracted (`rememberFact`'s corrected branch sets
    // status: 'retracted', not superseded), and a retracted fact is withheld
    // even from history -- the existing rule this asserts, not a new one.
    const historical = await memory.listFacts(ctx, [spaceId], { includeHistorical: true });
    assert.deepEqual(historical.map((fact) => fact.id), [corrected.factId]);

    // Editing a fact that is no longer current is refused.
    await assert.rejects(
      memory.updateFact(ctx, userId, spaceId, first.factId, {
        value: { type: "text", value: "Oakland again" },
      }),
      /Current fact not found/,
    );

    // Two current values under the same predicate: editing either refuses
    // rather than silently retracting the sibling.
    const nicknameA = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "nickname",
      value: { type: "text", value: "Ro" },
      sourceType: "user_stated",
      cardinality: "multiple",
    });
    await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "nickname",
      value: { type: "text", value: "Rowie" },
      sourceType: "user_stated",
      cardinality: "multiple",
    });
    await assert.rejects(
      memory.updateFact(ctx, userId, spaceId, nicknameA.factId, {
        value: { type: "text", value: "Ro-Ro" },
      }),
      /more than one current value/,
    );
  });
});

test("retireFact ends a fact's validity without erasing it", { skip }, async (t) => {
  const db = await identityDatabase(t);
  await db.tx(async (ctx) => {
    const userId = await makeUser(ctx);
    const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
    const otherSpaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });

    const fact = await memory.rememberFact(ctx, userId, spaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "employer",
      value: { type: "text", value: "Acme" },
      sourceType: "user_stated",
    });

    await memory.retireFact(ctx, spaceId, fact.factId);

    assert.deepEqual(await memory.listFacts(ctx, [spaceId], { includeHistorical: false }), []);
    const historical = await memory.listFacts(ctx, [spaceId], { includeHistorical: true });
    assert.equal(historical.length, 1);
    assert.equal(historical[0].id, fact.factId);
    assert.equal(historical[0].value.value, "Acme", "value is preserved, not erased");
    assert.equal(historical[0].status, "current", "retirement ends validity, it does not retract");

    // Retiring again is idempotent -- the same rule `archiveInvestment` uses:
    // "when was this retired" should not move because someone clicked twice.
    // `retireFact` never advances `validTo` past its first value.
    await memory.retireFact(ctx, spaceId, fact.factId);
    const retiredAgain = await memory.listFacts(ctx, [spaceId], { includeHistorical: true });
    assert.equal(retiredAgain[0].validTo, historical[0].validTo);

    // A fact in another space is refused rather than a cross-space write.
    const foreign = await memory.rememberFact(ctx, userId, otherSpaceId, {
      subject: { kind: "person", name: "Rowan" },
      predicate: "employer",
      value: { type: "text", value: "Acme" },
      sourceType: "user_stated",
    });
    await assert.rejects(memory.retireFact(ctx, spaceId, foreign.factId), /Current fact not found/);
  });
});
