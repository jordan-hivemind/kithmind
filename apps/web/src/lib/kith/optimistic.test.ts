import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPendingId,
  optimisticHandlers,
  pendingId,
  requestJson,
} from "@/lib/kith/optimistic";

type Rows = { id: string; name: string }[];

function setup() {
  const queryClient = new QueryClient();
  const key = ["rows"];
  queryClient.setQueryData<Rows>(key, [{ id: "a", name: "A" }]);
  const onFailure = vi.fn();
  const resync = vi.fn();
  const handlers = optimisticHandlers<Rows, string>(
    queryClient,
    key,
    (rows, id) => rows.filter((row) => row.id !== id),
    { onFailure, resync },
  );
  return { queryClient, key, onFailure, resync, handlers };
}

describe("optimisticHandlers", () => {
  it("applies the change before the server answers", async () => {
    const { queryClient, key, handlers } = setup();
    await handlers.onMutate("a");
    expect(queryClient.getQueryData(key)).toEqual([]);
  });

  it("rolls back and reports the message on failure", async () => {
    const { queryClient, key, onFailure, handlers } = setup();
    const snapshot = await handlers.onMutate("a");
    handlers.onError(new Error("No access"), "a", snapshot);
    expect(queryClient.getQueryData(key)).toEqual([{ id: "a", name: "A" }]);
    expect(onFailure).toHaveBeenCalledWith("No access");
  });

  it("resyncs whether the mutation succeeded or failed", () => {
    const { resync, handlers } = setup();
    handlers.onSettled();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty cache empty", async () => {
    const queryClient = new QueryClient();
    const apply = vi.fn();
    const handlers = optimisticHandlers(queryClient, ["none"], apply, {
      onFailure: vi.fn(),
      resync: vi.fn(),
    });
    await handlers.onMutate("x");
    expect(apply).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["none"])).toBeUndefined();
  });
});

describe("pendingId", () => {
  it("is recognisable and unique", () => {
    const first = pendingId();
    expect(isPendingId(first)).toBe(true);
    expect(isPendingId("k1234")).toBe(false);
    expect(pendingId()).not.toBe(first);
  });
});

describe("requestJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(status: number, body?: unknown) {
    const fetchMock = vi.fn(async () =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the JSON content type every guarded route requires", async () => {
    const fetchMock = stub(200, { id: "x" });
    await expect(requestJson("/api/kith/x", { method: "POST" })).resolves.toEqual({
      ok: true,
      body: { id: "x" },
    });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("surfaces the route's error string, or the fallback", async () => {
    stub(403, { error: "Forbidden" });
    await expect(requestJson("/x", {})).resolves.toEqual({ ok: false, message: "Forbidden" });
    stub(500);
    await expect(requestJson("/x", {}, "Nope")).resolves.toEqual({ ok: false, message: "Nope" });
  });

  it("treats 204 as success with no body", async () => {
    stub(204);
    await expect(requestJson("/x", {})).resolves.toEqual({ ok: true, body: undefined });
  });
});
