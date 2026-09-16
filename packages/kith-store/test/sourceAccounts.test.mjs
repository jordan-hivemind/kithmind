// The port of `packages/convex/convex/models/sourceAccounts/public.ts` against
// a real migrated schema: create, update and list for the settings page, plus
// the authorization half `authorization.test.ts` covers through
// `requireSourceAccountAccess`.
//
// docs/plans/2026-09-16-web-mcp-postgres-surface.md section 1.5 ("Source
// account create, update, list for the owner UI") and question 1 of section 8
// ("Add the row").

import assert from "node:assert/strict";
import test from "node:test";

import {
  createSourceAccount,
  listSourceAccounts,
  updateSourceAccount,
} from "../dist/sources/index.js";
import { webPrincipal } from "../dist/identity/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeMember,
  makeSpace,
  makeUser,
  refusal,
  refusalCode,
  skip,
} from "./helpers/identityFixture.mjs";

const SOURCE_ACCOUNT_NOT_FOUND = "Source account not found";

test(
  "create then list returns the row with the Convex fields, default freshness included",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const principal = webPrincipal(userId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "owner@gmail.example",
        name: "Owner inbox",
      });
      assert.equal(typeof id, "string");

      const listed = await listSourceAccounts(ctx, { principal });
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0], {
        id,
        spaceId,
        name: "Owner inbox",
        connector: "gmail",
        accountId: "owner@gmail.example",
        // Convex's default: `args.freshnessMs ?? 86_400_000`.
        freshnessMs: 86_400_000,
        enabled: true,
      });

      // An explicit freshness is kept as given.
      const secondId = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "second@gmail.example",
        name: "Second inbox",
        freshnessMs: 3_600_000,
      });
      const second = (await listSourceAccounts(ctx, { principal })).find(
        (row) => row.id === secondId,
      );
      assert.equal(second.freshnessMs, 3_600_000);

      // The same (space, connector, account) triple twice is refused, not
      // silently accepted as a second row -- Convex's `source_account_exists`.
      assert.equal(
        await refusalCode(() =>
          createSourceAccount(ctx, {
            principal,
            spaceId,
            connector: "gmail",
            accountId: "owner@gmail.example",
            name: "Duplicate",
          }),
        ),
        "source_account_exists",
      );
    });
  },
);

test(
  "update changes only the permitted fields, and a cross-space update is refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const ownerId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: ownerId, role: "owner" });
      const principal = webPrincipal(ownerId);

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "drive",
        accountId: "owner-drive",
        name: "Original name",
        freshnessMs: 7_200_000,
      });

      // Only `name` is given: `freshnessMs`, `connector`, `accountId` and
      // `enabled` are untouched.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        name: "Renamed",
      });
      let row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 7_200_000);
      assert.equal(row.connector, "drive");
      assert.equal(row.accountId, "owner-drive");
      assert.equal(row.enabled, true);

      // Only `enabled` is given this time: name and freshness stay put.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        enabled: false,
      });
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.enabled, false);
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 7_200_000);

      // Only `freshnessMs` is given: name and enabled stay put.
      await updateSourceAccount(ctx, {
        principal,
        sourceAccountId: id,
        freshnessMs: 120_000,
      });
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.freshnessMs, 120_000);
      assert.equal(row.name, "Renamed");
      assert.equal(row.enabled, false);

      // A stranger with no membership in the space at all.
      const strangerId = await makeUser(ctx, { email: "stranger@example.test" });
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal: webPrincipal(strangerId),
            sourceAccountId: id,
            name: "Hijacked",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // A member whose role cannot write (reader) is refused the same words:
      // read access to the space does not carry write access to its sources.
      const readerId = await makeUser(ctx, { email: "reader@example.test" });
      await makeMember(ctx, { spaceId, userId: readerId, role: "reader" });
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal: webPrincipal(readerId),
            sourceAccountId: id,
            name: "Reader edit",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // An id that does not exist at all gets the same non-enumerating words.
      assert.equal(
        await refusal(() =>
          updateSourceAccount(ctx, {
            principal,
            sourceAccountId: newKithId(),
            name: "Nobody",
          }),
        ),
        SOURCE_ACCOUNT_NOT_FOUND,
      );

      // The refused updates changed nothing.
      row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Renamed");
      assert.equal(row.freshnessMs, 120_000);
      assert.equal(row.enabled, false);
    });
  },
);

test(
  "create and update refuse the same malformed input Convex refused",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const principal = webPrincipal(userId);

      const badText = ["", "   ", "n".repeat(201), "bad \ud800"];
      for (const name of badText) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId: "a",
              name,
            }),
          ),
          "invalid_input",
          JSON.stringify(name),
        );
      }
      for (const connector of ["", "   ", "c".repeat(101), "bad \ud800"]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector,
              accountId: "a",
              name: "Valid",
            }),
          ),
          "invalid_input",
          JSON.stringify(connector),
        );
      }
      for (const accountId of ["", "   ", "a".repeat(513), "bad \ud800"]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId,
              name: "Valid",
            }),
          ),
          "invalid_input",
          JSON.stringify(accountId),
        );
      }
      // One minute to one year, an integer. 59_999 is just under, the year
      // bound plus one millisecond is just over, and both non-integers are
      // refused the same way.
      for (const freshnessMs of [
        59_999,
        365 * 86_400_000 + 1,
        1.5,
        Number.NaN,
        -1,
      ]) {
        assert.equal(
          await refusalCode(() =>
            createSourceAccount(ctx, {
              principal,
              spaceId,
              connector: "gmail",
              accountId: `fresh-${freshnessMs}`,
              name: "Valid",
              freshnessMs,
            }),
          ),
          "invalid_input",
          JSON.stringify(freshnessMs),
        );
      }

      const id = await createSourceAccount(ctx, {
        principal,
        spaceId,
        connector: "gmail",
        accountId: "valid-account",
        name: "Valid",
      });
      for (const name of badText) {
        assert.equal(
          await refusalCode(() =>
            updateSourceAccount(ctx, { principal, sourceAccountId: id, name }),
          ),
          "invalid_input",
          JSON.stringify(name),
        );
      }
      for (const freshnessMs of [59_999, 365 * 86_400_000 + 1, 1.5]) {
        assert.equal(
          await refusalCode(() =>
            updateSourceAccount(ctx, {
              principal,
              sourceAccountId: id,
              freshnessMs,
            }),
          ),
          "invalid_input",
          JSON.stringify(freshnessMs),
        );
      }
      // A refused update left the valid row valid.
      const row = (await listSourceAccounts(ctx, { principal })).find(
        (r) => r.id === id,
      );
      assert.equal(row.name, "Valid");
      assert.equal(row.freshnessMs, 86_400_000);
    });
  },
);

test(
  "list is bounded, space-isolated, and empty rather than an error for no spaces",
  { skip },
  async (t) => {
    const db = await identityDatabase(t);
    await db.tx(async (ctx) => {
      const userId = await makeUser(ctx, { email: "owner@example.test" });
      const spaceId = await makeSpace(ctx, { createdBy: userId, role: "owner" });
      const otherOwnerId = await makeUser(ctx, { email: "other@example.test" });
      const otherSpaceId = await makeSpace(ctx, {
        createdBy: otherOwnerId,
        role: "owner",
      });
      const principal = webPrincipal(userId);

      // A source account in a space this principal cannot read never appears.
      await createSourceAccount(ctx, {
        principal: webPrincipal(otherOwnerId),
        spaceId: otherSpaceId,
        connector: "gmail",
        accountId: "isolated",
        name: "Not mine",
      });
      assert.deepEqual(await listSourceAccounts(ctx, { principal }), []);

      // A principal with read access to no space at all gets an empty list,
      // not the "unauthorized" the bare predicate throws for zero spaces.
      const strangerId = await makeUser(ctx, { email: "no-space@example.test" });
      assert.deepEqual(
        await listSourceAccounts(ctx, { principal: webPrincipal(strangerId) }),
        [],
      );

      // 101 rows in one space: one more than Convex's 100-row bound.
      for (let index = 0; index < 101; index += 1) {
        await createSourceAccount(ctx, {
          principal,
          spaceId,
          connector: "bulk",
          accountId: `bulk-${index}`,
          name: `Bulk ${index}`,
        });
      }
      assert.equal(
        await refusalCode(() => listSourceAccounts(ctx, { principal })),
        "source_account_limit",
      );
      // Filtering to a space with 101 rows is still over the bound.
      assert.equal(
        await refusalCode(() =>
          listSourceAccounts(ctx, { principal, spaceIds: [spaceId] }),
        ),
        "source_account_limit",
      );
    });
  },
);
