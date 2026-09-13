import assert from "node:assert/strict";
import test from "node:test";

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
