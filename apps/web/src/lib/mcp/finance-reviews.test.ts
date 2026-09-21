import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  createPool: vi.fn(),
  list: vi.fn(),
  act: vi.fn(),
}));
vi.mock("@repo/finance-archive/store", async (original) => ({
  ...(await original<typeof import("@repo/finance-archive/store")>()),
  createArchivePool: mocks.createPool,
}));
vi.mock("@repo/finance-archive", async (original) => ({
  ...(await original<typeof import("@repo/finance-archive")>()),
  listFinanceReviewItems: mocks.list,
  actOnFinanceReviewItem: mocks.act,
}));
vi.mock("@repo/kith-store/identity", async (original) => ({
  ...(await original<typeof import("@repo/kith-store/identity")>()),
  requireSpaceAccess: mocks.requireAccess,
}));

import {
  type FinanceReviewAccess,
  postgresFinanceReviews,
  resolveFinanceReviews,
} from "./finance-reviews";
import type { McpPrincipalSession, WithMcpPrincipal } from "./principal";

beforeEach(() => vi.resetAllMocks());

function fixture() {
  const archive: FinanceReviewAccess = {
    spaceId: "archive-space",
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(null),
    act: vi.fn().mockResolvedValue({ status: "dismissed" }),
  };
  let revoked = false;
  const session = {
    ctx: {},
    principal: { userId: "owner" },
  } as McpPrincipalSession;
  const loader = vi.fn(async (run, options) => {
    expect(options).toEqual({ readOnly: true });
    if (revoked) throw new Error("Not authenticated");
    return run(session);
  }) as WithMcpPrincipal;
  return {
    archive,
    service: postgresFinanceReviews(loader, archive),
    revoke: () => {
      revoked = true;
    },
  };
}

test("finance review calls authorize the configured archive space every time", async () => {
  const { archive, service, revoke } = fixture();
  await service.listReviews({ accountId: "account" });
  expect(mocks.requireAccess).toHaveBeenLastCalledWith(
    {},
    { userId: "owner" },
    "archive-space",
    "read",
  );
  expect(archive.list).toHaveBeenCalledWith({
    status: "open",
    accountId: "account",
  });
  await service.manageReview({
    kind: "dismiss",
    reviewItemId: "review",
    note: "Already handled",
  });
  expect(mocks.requireAccess).toHaveBeenLastCalledWith(
    {},
    { userId: "owner" },
    "archive-space",
    "write",
  );
  revoke();
  await expect(service.getReview({ reviewId: "review" })).rejects.toThrow(
    "Not authenticated",
  );
  expect(archive.get).not.toHaveBeenCalled();
});

test("denied space or write capability never reaches the archive", async () => {
  const { archive, service } = fixture();
  mocks.requireAccess.mockRejectedValue(new Error("Space not found"));
  await expect(
    service.manageReview({
      kind: "dismiss",
      reviewItemId: "review",
      note: "Handled",
    }),
  ).rejects.toThrow("Space not found");
  await expect(service.listReviews({})).rejects.toThrow("Space not found");
  expect(archive.act).not.toHaveBeenCalled();
  expect(archive.list).not.toHaveBeenCalled();
});

test("missing writer is an explicit configuration error, never a read-only fallback", async () => {
  const { archive, service } = fixture();
  archive.act = null;
  await expect(
    service.manageReview({
      kind: "dismiss",
      reviewItemId: "review",
      note: "Handled",
    }),
  ).rejects.toThrow("Finance review writer is not configured");
  await service.listReviews({});
  expect(archive.list).toHaveBeenCalledOnce();
});

test("separate archive configurations keep database and schema pools separate", async () => {
  const clients: Array<{
    url: string;
    schema: string;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  mocks.createPool.mockImplementation((url, schema) => {
    const client = { url, schema, release: vi.fn() };
    clients.push(client);
    return { connect: async () => client };
  });
  for (const schema of ["finance_a", "finance_b"]) {
    const access = resolveFinanceReviews({
      FINANCE_ARCHIVE_READER_DATABASE_URL:
        "postgres://reader@example.test/archive",
      FINANCE_ARCHIVE_DATABASE_URL: "postgres://writer@example.test/archive",
      FINANCE_ARCHIVE_SPACE_ID: schema,
      FINANCE_ARCHIVE_SCHEMA: schema,
    })!;
    await access.list({});
    expect(mocks.list.mock.lastCall![0]).toMatchObject({
      schema,
      url: "postgres://reader@example.test/archive",
    });
    await access.act!({ kind: "dismiss", reviewItemId: "r", note: "Handled" });
    expect(mocks.act.mock.lastCall![0]).toMatchObject({
      schema,
      url: "postgres://writer@example.test/archive",
    });
  }
  expect(mocks.createPool).toHaveBeenCalledTimes(4);
  for (const client of clients) expect(client.release).toHaveBeenCalledOnce();
});
