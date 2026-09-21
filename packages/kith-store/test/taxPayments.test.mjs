// TAX-PAYMENTS-1. Structured manual tax payments against real PostgreSQL.
// Synthetic identifiers and values only.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaxPayment,
  listTaxPayments,
  setTaxPaymentStatus,
} from "../dist/admin/index.js";
import { newKithId } from "../dist/index.js";
import {
  identityDatabase,
  makeSpace,
  makeUser,
  skip,
} from "./helpers/identityFixture.mjs";

const NOW = Date.parse("2026-09-21T18:00:00Z");

async function fixture(t) {
  const database = await identityDatabase(t);
  const ctx = database.ctx(NOW);
  const userId = await makeUser(ctx, { name: "Synthetic Tax Owner" });
  const spaceId = await makeSpace(ctx, {
    createdBy: userId,
    memberId: userId,
    role: "owner",
  });
  return {
    ...database,
    ctx,
    userId,
    spaceId,
    principal: { userId, credentialId: null },
  };
}

const payer = {
  key: "person:synthetic-tax-payer",
  kind: "person",
  name: "Synthetic Tax Payer",
};

function payment(f, overrides = {}) {
  return {
    principal: f.principal,
    spaceId: f.spaceId,
    payer,
    authority: "us_federal",
    paymentKind: "estimated_income",
    taxYear: 2026,
    amount: "1234.56",
    currency: "USD",
    submittedOn: "2026-09-21",
    confirmationNumber: "CONF-SYNTHETIC-2026-Q3",
    ...overrides,
  };
}

test(
  "a manual estimated payment deduplicates, settles on the same row, and totals by tax year, currency and status",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const first = await createTaxPayment(f.ctx, payment(f));
    assert.equal(first.created, true);

    const retry = await createTaxPayment(
      f.ctx,
      payment(f, {
        amount: "001234.5600",
        confirmationNumber: "conf-synthetic-2026-q3",
        eftTrace: "EFT-SYNTHETIC-001",
      }),
    );
    assert.deepEqual(retry, { paymentId: first.paymentId, created: false });

    let year = await listTaxPayments(f.ctx, [f.spaceId], 2026);
    assert.equal(year.payments.length, 1);
    assert.equal(year.payments[0].id, first.paymentId);
    assert.equal(year.payments[0].taxYear, 2026);
    assert.equal(year.payments[0].submittedOn, "2026-09-21");
    assert.equal(year.payments[0].status, "submitted_processing");
    assert.equal(year.payments[0].eftTrace, "EFT-SYNTHETIC-001");
    assert.deepEqual(year.totals, [
      {
        currency: "USD",
        status: "submitted_processing",
        count: 1,
        amount: "1234.56",
      },
    ]);
    assert.deepEqual(await listTaxPayments(f.ctx, [f.spaceId], 2025), {
      taxYear: 2025,
      payments: [],
      totals: [],
    });

    const settled = await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: first.paymentId,
      status: "settled",
      effectiveOn: "2026-09-23",
      reason: "Synthetic payment cleared",
    });
    assert.deepEqual(settled, { paymentId: first.paymentId, updated: true });
    const repeated = await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: first.paymentId,
      status: "settled",
      effectiveOn: "2026-09-23",
      reason: "Retry of the same settlement receipt",
    });
    assert.deepEqual(repeated, { paymentId: first.paymentId, updated: false });

    year = await listTaxPayments(f.ctx, [f.spaceId], 2026);
    assert.equal(
      year.payments.length,
      1,
      "settlement updates, never duplicates",
    );
    assert.equal(year.payments[0].status, "settled");
    assert.equal(year.payments[0].settledOn, "2026-09-23");
    assert.deepEqual(
      year.payments[0].statusHistory.map((event) => ({
        status: event.status,
        correction: event.correction,
      })),
      [
        { status: "submitted_processing", correction: false },
        { status: "settled", correction: false },
      ],
    );
    assert.deepEqual(year.totals, [
      {
        currency: "USD",
        status: "settled",
        count: 1,
        amount: "1234.56",
      },
    ]);
  },
);

test(
  "identifier conflicts fail closed and rejected or reversed payments remain separate totals",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const first = await createTaxPayment(f.ctx, payment(f));
    await assert.rejects(
      createTaxPayment(f.ctx, payment(f, { amount: "999.00" })),
      /different payment details/,
    );
    const second = await createTaxPayment(
      f.ctx,
      payment(f, {
        amount: "25.00",
        confirmationNumber: "CONF-SYNTHETIC-SECOND",
        eftTrace: "EFT-SYNTHETIC-SECOND",
      }),
    );
    await assert.rejects(
      createTaxPayment(
        f.ctx,
        payment(f, {
          confirmationNumber: "CONF-SYNTHETIC-2026-Q3",
          eftTrace: "EFT-SYNTHETIC-SECOND",
        }),
      ),
      /identify different tax payments/,
    );
    await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: first.paymentId,
      status: "settled",
      effectiveOn: "2026-09-23",
      reason: "Synthetic settlement",
    });
    await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: first.paymentId,
      status: "reversed",
      effectiveOn: "2026-09-24",
      reason: "Synthetic reversal",
    });
    await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: second.paymentId,
      status: "rejected",
      effectiveOn: "2026-09-22",
      reason: "Synthetic rejection",
    });

    const year = await listTaxPayments(f.ctx, [f.spaceId], 2026);
    assert.deepEqual(year.totals, [
      { currency: "USD", status: "rejected", count: 1, amount: "25" },
      { currency: "USD", status: "reversed", count: 1, amount: "1234.56" },
    ]);
    assert.equal(
      year.payments.reduce(
        (sum, item) => sum + (item.status === "settled" ? 1 : 0),
        0,
      ),
      0,
      "neither rejected nor reversed is reported as settled",
    );
  },
);

test(
  "default lifecycle is guarded while an explicit correction is audited on the same payment",
  { skip },
  async (t) => {
    const f = await fixture(t);
    const created = await createTaxPayment(f.ctx, payment(f));
    await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: created.paymentId,
      status: "rejected",
      effectiveOn: "2026-09-22",
      reason: "Synthetic rejection",
    });
    await assert.rejects(
      setTaxPaymentStatus(f.ctx, {
        principal: f.principal,
        paymentId: created.paymentId,
        status: "submitted_processing",
        effectiveOn: "2026-09-22",
        reason: "Mistaken status",
      }),
      /without an explicit correction/,
    );
    await setTaxPaymentStatus(f.ctx, {
      principal: f.principal,
      paymentId: created.paymentId,
      status: "submitted_processing",
      effectiveOn: "2026-09-22",
      reason: "The rejection was entered against the wrong receipt",
      correction: true,
    });
    const year = await listTaxPayments(f.ctx, [f.spaceId], 2026);
    assert.equal(year.payments.length, 1);
    assert.equal(year.payments[0].status, "submitted_processing");
    assert.equal(year.payments[0].statusHistory.at(-1).correction, true);
  },
);

test("payment writes and evidence are space isolated", { skip }, async (t) => {
  const f = await fixture(t);
  const otherUser = await makeUser(f.ctx, { name: "Other Synthetic User" });
  const otherSpace = await makeSpace(f.ctx, {
    createdBy: otherUser,
    memberId: otherUser,
    role: "owner",
  });
  const evidenceId = newKithId();
  await f.ctx.client.query(
    `INSERT INTO kith.evidence_spans (id, space_id, created_at)
       VALUES ($1, $2, transaction_timestamp())`,
    [evidenceId, otherSpace],
  );
  await assert.rejects(
    createTaxPayment(f.ctx, payment(f, { evidenceSpanId: evidenceId })),
    /Evidence span is unavailable/,
  );

  const created = await createTaxPayment(f.ctx, payment(f));
  await assert.rejects(
    setTaxPaymentStatus(f.ctx, {
      principal: { userId: otherUser, credentialId: null },
      paymentId: created.paymentId,
      status: "settled",
      effectiveOn: "2026-09-23",
      reason: "Must not cross spaces",
    }),
    /Tax payment not found/,
  );
  assert.deepEqual(await listTaxPayments(f.ctx, [otherSpace], 2026), {
    taxYear: 2026,
    payments: [],
    totals: [],
  });
});
