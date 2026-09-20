// The finance account override store (ADM-2b), against a real database.

import assert from "node:assert/strict";
import test from "node:test";

import {
  listAccountOverrides,
  setAccountOverride,
} from "../dist/admin/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return { ctx, userId, spaceId, principal: { userId, credentialId: null } };
}

test("an override is stored, replaced, and removed by clearing every field (ADM-2b)", { skip }, async (t) => {
  const { ctx, spaceId, principal } = await fixture(t);
  await setAccountOverride(ctx, {
    principal,
    spaceId,
    accountId: "acct-1",
    displayName: "  Joint brokerage ",
    accountLast4: "4321",
    closed: false,
  });
  assert.deepEqual(await listAccountOverrides(ctx, { spaceId }), [
    {
      accountId: "acct-1",
      displayName: "Joint brokerage",
      accountLast4: "4321",
      accountType: null,
      closed: false,
    },
  ]);

  await setAccountOverride(ctx, {
    principal,
    spaceId,
    accountId: "acct-1",
    displayName: "",
    accountType: "trust",
    closed: true,
  });
  const [changed] = await listAccountOverrides(ctx, { spaceId });
  assert.equal(changed.displayName, null);
  assert.equal(changed.accountLast4, null);
  assert.equal(changed.accountType, "trust");
  assert.equal(changed.closed, true);

  await setAccountOverride(ctx, { principal, spaceId, accountId: "acct-1" });
  assert.deepEqual(await listAccountOverrides(ctx, { spaceId }), []);
});

test("a last four that is not four digits is refused (ADM-2b)", { skip }, async (t) => {
  const { ctx, spaceId, principal } = await fixture(t);
  for (const bad of ["123", "12345", "12a4"]) {
    await assert.rejects(
      setAccountOverride(ctx, {
        principal,
        spaceId,
        accountId: "acct-1",
        accountLast4: bad,
      }),
      /Last four/,
    );
  }
});

test("a reader cannot write an override, and an override is per space (ADM-2b)", { skip }, async (t) => {
  const { ctx, spaceId, principal } = await fixture(t);
  const readerId = await makeUser(ctx, { name: "Reader" });
  await makeMember(ctx, { spaceId, userId: readerId, role: "reader" });
  await assert.rejects(
    setAccountOverride(ctx, {
      principal: { userId: readerId, credentialId: null },
      spaceId,
      accountId: "acct-1",
      displayName: "Nope",
    }),
  );
  const otherSpace = await makeSpace(ctx, {
    createdBy: principal.userId,
    memberId: principal.userId,
    role: "owner",
  });
  await setAccountOverride(ctx, {
    principal,
    spaceId,
    accountId: "acct-1",
    displayName: "Mine",
  });
  assert.deepEqual(await listAccountOverrides(ctx, { spaceId: otherSpace }), []);
});
