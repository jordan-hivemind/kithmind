import { FinanceReviewActionError } from "@repo/finance-archive";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  resolve: vi.fn<() => unknown>(),
  withPrincipalRead: vi.fn(),
}));

vi.mock("@repo/kith-store/identity", async (original) => ({
  ...(await original<typeof import("@repo/kith-store/identity")>()),
  requireSpaceAccess: mocks.requireAccess,
}));
vi.mock("@/lib/mcp/finance-reviews", () => ({
  resolveFinanceReviews: () => mocks.resolve(),
}));
vi.mock("@/lib/kith/api-route", async (original) => ({
  ...(await original<typeof import("@/lib/kith/api-route")>()),
  withPrincipalRead: mocks.withPrincipalRead,
}));

import { GET, POST } from "./route";

const ORIGIN = "https://kith.example.test";

function request(method: "GET" | "POST", body?: unknown, query = ""): Request {
  return new Request(`${ORIGIN}/api/kith/finance-reviews${query}`, {
    method,
    headers: { "Content-Type": "application/json", origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/kith/finance-reviews", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.withPrincipalRead.mockImplementation(async (_request, run) =>
      run({ ctx: { synthetic: true }, principal: { userId: "owner" } }),
    );
  });

  test("list and detail re-authorize the pinned archive space", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const get = vi.fn().mockResolvedValue({ item: { id: "review-1" } });
    mocks.resolve.mockReturnValue({
      spaceId: "archive-space",
      list,
      get,
      act: vi.fn(),
    });

    expect((await GET(request("GET"))).status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      accountId: undefined,
      cursor: undefined,
      kind: undefined,
      status: "open",
      limit: 100,
    });
    expect(mocks.requireAccess).toHaveBeenLastCalledWith(
      { synthetic: true },
      { userId: "owner" },
      "archive-space",
      "read",
    );

    expect(
      (await GET(request("GET", undefined, "?reviewId=review-1"))).status,
    ).toBe(200);
    expect(get).toHaveBeenCalledWith("review-1");
    expect(mocks.requireAccess).toHaveBeenCalledTimes(2);
  });

  test("a denied caller never reaches archive reads or writes", async () => {
    const list = vi.fn();
    const act = vi.fn();
    mocks.resolve.mockReturnValue({
      spaceId: "archive-space",
      list,
      get: vi.fn(),
      act,
    });
    mocks.requireAccess.mockRejectedValue(new Error("Space not found"));

    await expect(GET(request("GET"))).rejects.toThrow("Space not found");
    await expect(
      POST(
        request("POST", {
          kind: "dismiss",
          reviewItemId: "review-1",
          note: "Not needed for this archive",
        }),
      ),
    ).rejects.toThrow("Space not found");
    expect(list).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  test("write authorization precedes the exact supported archive action", async () => {
    const act = vi.fn().mockResolvedValue({
      reviewItemId: "review-1",
      action: "confirm_instrument_match",
      status: "resolved",
    });
    mocks.resolve.mockReturnValue({
      spaceId: "archive-space",
      list: vi.fn(),
      get: vi.fn(),
      act,
    });
    const action = {
      kind: "confirm_instrument_match",
      reviewItemId: "review-1",
      matchedInstrumentId: "instrument-1",
    };
    const response = await POST(request("POST", action));

    expect(response.status).toBe(200);
    expect(mocks.requireAccess).toHaveBeenCalledWith(
      { synthetic: true },
      { userId: "owner" },
      "archive-space",
      "write",
    );
    expect(act).toHaveBeenCalledWith(action);
  });

  test("invalid candidates and repeated resolutions remain explicit conflicts", async () => {
    const act = vi
      .fn()
      .mockRejectedValueOnce(
        new FinanceReviewActionError("conflict", "candidate changed"),
      )
      .mockRejectedValueOnce(
        new FinanceReviewActionError("not_open", "review is resolved"),
      );
    mocks.resolve.mockReturnValue({
      spaceId: "archive-space",
      list: vi.fn(),
      get: vi.fn(),
      act,
    });
    const action = {
      kind: "confirm_instrument_match",
      reviewItemId: "review-1",
      matchedInstrumentId: "instrument-wrong",
    };
    const conflict = await POST(request("POST", action));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "conflict" });

    const repeated = await POST(request("POST", action));
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ code: "not_open" });
  });

  test("invented financial writes are rejected before the archive", async () => {
    const act = vi.fn();
    mocks.resolve.mockReturnValue({
      spaceId: "archive-space",
      list: vi.fn(),
      get: vi.fn(),
      act,
    });
    const response = await POST(
      request("POST", {
        kind: "correct_amount",
        reviewItemId: "review-1",
        amount: "12.34",
      }),
    );
    expect(response.status).toBe(400);
    expect(act).not.toHaveBeenCalled();
  });

  test("cross-origin actions are refused before authentication or archive access", async () => {
    const requestFromAnotherSite = new Request(
      `${ORIGIN}/api/kith/finance-reviews`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://attacker.example.test",
        },
        body: JSON.stringify({
          kind: "dismiss",
          reviewItemId: "review-1",
          note: "Not needed",
        }),
      },
    );
    const response = await POST(requestFromAnotherSite);
    expect(response.status).toBe(403);
    expect(mocks.withPrincipalRead).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
