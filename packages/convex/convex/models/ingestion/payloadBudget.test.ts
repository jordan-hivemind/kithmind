import { convexTest } from "convex-test";
import { getDocumentSize } from "convex/values";
import { describe, expect, test, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  boundedDocumentSize,
  MAX_PAYLOAD_READ_BYTES,
  PayloadBudgetError,
  PayloadReadBudget,
} from "./payloadBudget";

const MIB = 1_024 * 1_024;
const ID = "synthetic-user" as Id<"users">;

function metricFixture(bytesUsed = 0, bytesRemaining = 16 * MIB - bytesUsed) {
  return {
    bytesRead: { used: bytesUsed, remaining: bytesRemaining },
    documentsRead: { used: 0, remaining: 32_000 },
    databaseQueries: { used: 0, remaining: 4_096 },
  };
}

function fakeContext(getMetrics: () => Promise<unknown>, row: unknown = null) {
  const get = vi.fn(async () => row);
  const ctx = { db: { get }, meta: { getTransactionMetrics: getMetrics } };
  return { ctx: ctx as unknown as Pick<QueryCtx, "db" | "meta">, get };
}

describe("bounded payload point reads", () => {
  test("accounts actual Convex bytes and reads with real transaction metrics", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Unicode 🧠" }),
    );
    await t.run(async (ctx) => {
      const budget = new PayloadReadBudget(ctx);
      const row = await budget.read(id, 16 * 1_024);
      expect(row?.name).toBe("Unicode 🧠");
      expect(await budget.finish()).toEqual({
        pointReads: 1,
        hydratedBytes: getDocumentSize(row!),
      });
    });
  });

  test("includes system fields and rejects a one-byte-over row", () => {
    const row = { name: "🧠" };
    const size = getDocumentSize(row);
    expect(size).toBeGreaterThan(
      new TextEncoder().encode(JSON.stringify(row)).length,
    );
    expect(boundedDocumentSize(row, size)).toBe(size);
    expect(() => boundedDocumentSize(row, size - 1)).toThrow(
      PayloadBudgetError,
    );
  });

  test("unavailable, incomplete, and malformed metrics prevent database reads", async () => {
    for (const value of [
      null,
      {},
      { ...metricFixture(), bytesRead: { used: NaN, remaining: 16 * MIB } },
      { ...metricFixture(), bytesRead: { used: -1, remaining: 16 * MIB } },
      { ...metricFixture(), bytesRead: { used: 0.5, remaining: 16 * MIB } },
      { ...metricFixture(), documentsRead: { used: 0, remaining: Infinity } },
      { ...metricFixture(), databaseQueries: { used: 0, remaining: -1 } },
    ]) {
      const { ctx, get } = fakeContext(async () => value);
      await expect(new PayloadReadBudget(ctx).read(ID, 100)).rejects.toThrow(
        PayloadBudgetError,
      );
      expect(get).not.toHaveBeenCalled();
    }
    const { ctx, get } = fakeContext(async () => {
      throw new Error("private detail");
    });
    await expect(new PayloadReadBudget(ctx).read(ID, 100)).rejects.toThrow(
      "Payload read budget is unavailable or exceeded",
    );
    expect(get).not.toHaveBeenCalled();
  });

  test("reserves a full stored document plus headroom before reading", async () => {
    const { ctx, get } = fakeContext(async () => metricFixture(0, 2 * MIB - 1));
    await expect(new PayloadReadBudget(ctx).read(ID, 16)).rejects.toThrow(
      PayloadBudgetError,
    );
    expect(get).not.toHaveBeenCalled();
  });

  test("includes reads made before the reader was created in the 8 MiB limit", async () => {
    const { ctx, get } = fakeContext(async () =>
      metricFixture(MAX_PAYLOAD_READ_BYTES - 15),
    );
    await expect(new PayloadReadBudget(ctx).read(ID, 16)).rejects.toThrow(
      PayloadBudgetError,
    );
    expect(get).not.toHaveBeenCalled();
  });

  test("a malformed manifest row cannot permit later publication checks", async () => {
    const row = { _id: ID, _creationTime: 1, name: "private row" };
    const { ctx, get } = fakeContext(async () => metricFixture(), row);
    const budget = new PayloadReadBudget(ctx);
    await expect(budget.read(ID, getDocumentSize(row) - 1)).rejects.toThrow(
      PayloadBudgetError,
    );
    await expect(budget.finish()).rejects.toThrow(PayloadBudgetError);
    await expect(budget.read(ID, 1_024)).rejects.toThrow(PayloadBudgetError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("a corrupt full-size row trips post-read metrics before publication", async () => {
    let call = 0;
    const { ctx } = fakeContext(async () =>
      metricFixture(
        call++ === 0
          ? MAX_PAYLOAD_READ_BYTES - 100
          : MAX_PAYLOAD_READ_BYTES + 1,
      ),
    );
    const budget = new PayloadReadBudget(ctx);
    await expect(budget.read(ID, 100)).rejects.toThrow(PayloadBudgetError);
    await expect(budget.finish()).rejects.toThrow(PayloadBudgetError);
  });

  test("metrics cannot decrease or change transaction limits mid-reader", async () => {
    for (const second of [metricFixture(99), metricFixture(100, 16 * MIB)]) {
      let call = 0;
      const { ctx } = fakeContext(async () =>
        call++ === 0 ? metricFixture(100) : second,
      );
      await expect(new PayloadReadBudget(ctx).read(ID, 100)).rejects.toThrow(
        PayloadBudgetError,
      );
    }
  });

  test("parallel point reads fail closed instead of racing accounting", async () => {
    let release!: (value: unknown) => void;
    let call = 0;
    const { ctx } = fakeContext(() =>
      call++ === 0
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(metricFixture()),
    );
    const budget = new PayloadReadBudget(ctx);
    const first = budget.read(ID, 100);
    await expect(budget.read(ID, 100)).rejects.toThrow(PayloadBudgetError);
    release(metricFixture());
    await first;
    await expect(budget.finish()).rejects.toThrow(PayloadBudgetError);
  });
});
