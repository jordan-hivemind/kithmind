// `listInvestmentDocuments`: what the Edit investment drawer lists.
//
// One row per document however many links it has to the investment, the
// strongest link's state, rejected links left out, and nothing from another
// investment or another space. Synthetic fixtures throughout.

import assert from "node:assert/strict";
import test from "node:test";

import { newKithId } from "../dist/index.js";
import {
  createInvestment,
  createInvestmentEntry,
  listInvestmentDocuments,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";
import { org, seedDocument } from "./helpers/investmentDocuments.mjs";

const NOW = Date.parse("2026-09-26T12:00:00Z");

async function link(ctx, spaceId, input) {
  const owner = input.decidedBy === "owner";
  await ctx.client.query(
    `INSERT INTO kith.investment_document_links
       (id, space_id, investment_id, entry_id, document_id, source_item_id,
        state, score, evidence, decided_by, actor_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 4, $8::jsonb, $9, $10, 'synthetic')`,
    [
      newKithId(),
      spaceId,
      input.investmentId,
      input.entryId ?? null,
      input.document.documentId,
      input.document.sourceItemId,
      input.state,
      owner
        ? "[]"
        : JSON.stringify([
            { field: "fund", observationKey: "fund", evidenceSpanId: "x" },
          ]),
      owner ? "owner" : "rule",
      owner ? input.userId : null,
    ],
  );
}

test("lists each linked document once, strongest link first, never a rejected one", { skip }, async (t) => {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  const principal = { userId, credentialId: null };
  const investmentId = await createInvestment(ctx, {
    principal,
    spaceId,
    name: "Synthetic Seed Co",
  });
  const otherInvestmentId = await createInvestment(ctx, {
    principal,
    spaceId,
    name: "Other Synthetic Co",
  });
  const entry = await createInvestmentEntry(ctx, {
    principal,
    investmentId,
    entryType: "capital_call_paid",
    entryDate: "2026-03-10",
    amount: "25000.00",
  });
  const seed = (title, kind) =>
    seedDocument(ctx, spaceId, {
      kind,
      title,
      uri: `fs://dropbox-investing/Synthetic%20Seed%20Co/${encodeURIComponent(title)}.pdf`,
      statements: [org("company", "Synthetic Seed Co")],
    });
  const agreement = await seed("SAFE", "investment_agreement");
  const notice = await seed("Call notice", "capital_call_notice");
  const rejected = await seed("Wrong fund", "letter_or_notice");
  const elsewhere = await seed("Other", "letter_or_notice");

  // The agreement at the investment level and, suggested, on the entry too.
  await link(ctx, spaceId, {
    investmentId,
    document: agreement,
    state: "suggested",
    entryId: entry.id,
  });
  await link(ctx, spaceId, {
    investmentId,
    document: agreement,
    state: "auto_linked",
  });
  await link(ctx, spaceId, {
    investmentId,
    document: notice,
    state: "suggested",
  });
  await link(ctx, spaceId, {
    investmentId,
    document: rejected,
    state: "rejected",
    decidedBy: "owner",
    userId,
  });
  await link(ctx, spaceId, {
    investmentId: otherInvestmentId,
    document: elsewhere,
    state: "confirmed",
    decidedBy: "owner",
    userId,
  });

  const listed = await listInvestmentDocuments(ctx, [spaceId], investmentId);
  assert.deepEqual(
    listed.map((document) => [document.title, document.state, document.entryId]).sort(),
    [
      ["Call notice", "suggested", null],
      ["SAFE", "auto_linked", null],
    ],
  );
  const safe = listed.find((document) => document.title === "SAFE");
  assert.equal(safe.kind, "investment_agreement");
  assert.equal(safe.sourceItemId, agreement.sourceItemId);
  assert.equal(safe.uri, "fs://dropbox-investing/Synthetic%20Seed%20Co/SAFE.pdf");

  const otherSpace = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  assert.deepEqual(
    await listInvestmentDocuments(ctx, [otherSpace], investmentId),
    [],
  );
});
