// `runHostedLink`'s polling flow against a mocked Plaid client, a fake
// `pg.Pool`, an injected clock and an injected Keychain writer -- no
// network, no database, no Keychain, and no real waiting even for the
// timeout case.

import assert from "node:assert/strict";
import test from "node:test";

import { runHostedLink } from "../dist/index.js";

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text: text.trim(), params });
      return { rows: [] };
    },
  };
}

/** A clock `sleep` visibly advances, so the timeout case needs no real time. */
function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

function fakeKeychain() {
  const written = [];
  return {
    written,
    async writeSecret(service, secret) {
      written.push({ service, secret });
    },
  };
}

const LINK_TOKEN_CREATE_RESPONSE = {
  data: {
    link_token: "link-token-1",
    hosted_link_url: "https://hosted.plaid.com/abc123",
    expiration: "2026-09-23T00:00:00Z",
    request_id: "req-1",
  },
};

function pendingSession() {
  return { data: { link_sessions: [{ link_session_id: "sess-1", finished_at: null }] } };
}

function finishedWithItem(overrides = {}) {
  return {
    data: {
      link_sessions: [
        {
          link_session_id: "sess-1",
          finished_at: "2026-09-22T18:05:00Z",
          results: {
            item_add_results: [
              {
                public_token: "public-token-1",
                accounts: [],
                institution: { name: "Chase", institution_id: "ins_3" },
                ...overrides,
              },
            ],
            cra_item_add_results: [],
            cra_update_results: [],
            bank_income_results: [],
            payroll_income_results: [],
            document_income_results: null,
          },
        },
      ],
    },
  };
}

function finishedWithExit(message) {
  return {
    data: {
      link_sessions: [
        {
          link_session_id: "sess-1",
          finished_at: "2026-09-22T18:05:00Z",
          results: null,
          exit: {
            error: message === null ? null : {
              error_type: "INVALID_REQUEST",
              error_code: "SOME_ERROR",
              error_message: message,
              display_message: message,
            },
            metadata: null,
          },
        },
      ],
    },
  };
}

test("a pending session, then one finished with a public token, is exchanged and stored", async () => {
  const pool = fakePool();
  const keychain = fakeKeychain();
  const clock = fakeClock();
  const reported = [];
  let getCalls = 0;

  const client = {
    async linkTokenCreate() {
      return LINK_TOKEN_CREATE_RESPONSE;
    },
    async linkTokenGet() {
      getCalls += 1;
      return getCalls === 1 ? pendingSession() : finishedWithItem();
    },
    async itemPublicTokenExchange({ public_token }) {
      assert.equal(public_token, "public-token-1");
      return { data: { access_token: "access-token-1", item_id: "item-9", request_id: "req-2" } };
    },
  };

  const outcome = await runHostedLink({
    client,
    pool,
    now: clock.now,
    sleep: clock.sleep,
    writeSecret: keychain.writeSecret,
    report: (line) => reported.push(line),
  });

  assert.deepEqual(outcome, { status: "linked", institutionName: "Chase", itemId: "item-9" });
  assert.equal(getCalls, 2, "polled once while pending, then again to see it finished");
  assert.deepEqual(keychain.written, [
    { service: "com.kithmind.plaid.item.chase", secret: "access-token-1" },
  ]);
  assert.ok(
    reported.some((line) => line.includes("https://hosted.plaid.com/abc123")),
    "the hosted URL was reported for the owner to open",
  );

  const upsert = pool.calls.find((call) => call.text.includes("INSERT INTO kith.plaid_items"));
  assert.ok(upsert, "the item was upserted");
  // params[0] is a freshly generated kith.kith_id (migration 043_plaid_feed.sql
  // gives every table a kith_id primary key beside Plaid's own opaque id, the
  // same convention every other migrated table uses); everything after it is
  // the row's own data.
  assert.equal(upsert.params.length, 5);
  assert.deepEqual(upsert.params.slice(1), [
    "item-9",
    "ins_3",
    "Chase",
    "com.kithmind.plaid.item.chase",
  ]);
});

test("a session that never finishes times out without exchanging anything", async () => {
  const pool = fakePool();
  const keychain = fakeKeychain();
  const clock = fakeClock();
  let getCalls = 0;
  let exchangeCalled = false;

  const client = {
    async linkTokenCreate() {
      return LINK_TOKEN_CREATE_RESPONSE;
    },
    async linkTokenGet() {
      getCalls += 1;
      return pendingSession();
    },
    async itemPublicTokenExchange() {
      exchangeCalled = true;
      return { data: { access_token: "should-not-happen", item_id: "x", request_id: "req" } };
    },
  };

  const outcome = await runHostedLink({
    client,
    pool,
    timeoutMs: 15_000,
    pollIntervalMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    writeSecret: keychain.writeSecret,
    report: () => {},
  });

  assert.deepEqual(outcome, { status: "timeout" });
  assert.equal(getCalls, 3, "polled until the clock reached the deadline");
  assert.equal(exchangeCalled, false);
  assert.equal(keychain.written.length, 0);
  assert.equal(pool.calls.length, 0, "nothing was written to the database");
});

test("a session that finishes with an exit (the owner backed out) is reported, not linked", async () => {
  const pool = fakePool();
  const keychain = fakeKeychain();
  const clock = fakeClock();
  let exchangeCalled = false;

  const client = {
    async linkTokenCreate() {
      return LINK_TOKEN_CREATE_RESPONSE;
    },
    async linkTokenGet() {
      return finishedWithExit("The user closed the window.");
    },
    async itemPublicTokenExchange() {
      exchangeCalled = true;
      return { data: { access_token: "x", item_id: "x", request_id: "req" } };
    },
  };

  const outcome = await runHostedLink({
    client,
    pool,
    now: clock.now,
    sleep: clock.sleep,
    writeSecret: keychain.writeSecret,
    report: () => {},
  });

  assert.deepEqual(outcome, { status: "exited", message: "The user closed the window." });
  assert.equal(exchangeCalled, false);
  assert.equal(keychain.written.length, 0);
});

test("linkTokenCreate is asked for the transactions-required, investments-optional, hosted-link, 730-day-history shape", async () => {
  const pool = fakePool();
  let request;
  const client = {
    async linkTokenCreate(body) {
      request = body;
      return LINK_TOKEN_CREATE_RESPONSE;
    },
    async linkTokenGet() {
      return finishedWithExit(null);
    },
    async itemPublicTokenExchange() {
      throw new Error("not reached");
    },
  };

  await runHostedLink({
    client,
    pool,
    now: fakeClock().now,
    sleep: fakeClock().sleep,
    writeSecret: async () => {},
    report: () => {},
  });

  assert.deepEqual(request.products, ["transactions"]);
  assert.deepEqual(request.optional_products, ["investments"]);
  assert.deepEqual(request.hosted_link, {});
  assert.equal(request.redirect_uri, undefined, "Hosted Link needs no redirect URI");
  // PLAID-3: request Plaid's maximum banking-transactions history window
  // (default is 90 days; 730 is the max) so a newly linked Item is not
  // stuck with only recent activity.
  assert.deepEqual(request.transactions, { days_requested: 730 });
});
