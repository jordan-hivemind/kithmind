import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  spaces: vi.fn(),
  documents: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/kith/page-session", () => ({
  loadAuthenticatedPage: mocks.session,
}));
vi.mock("@repo/kith-store/identity", async (original) => ({
  ...(await original<typeof import("@repo/kith-store/identity")>()),
  getAuthorizedReadSpaceIds: mocks.spaces,
}));
vi.mock("@repo/kith-store", async (original) => ({
  ...(await original<typeof import("@repo/kith-store")>()),
  documents: { getDocumentsForSourceItem: mocks.documents },
}));
import { GET as content } from "./content/route";
import { GET } from "./route";
const params = {
  params: Promise.resolve({ sourceItemId: "synthetic-source" }),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.spaces.mockResolvedValue(["own-space"]);
});
test("signed-out document metadata and bytes never access source content", async () => {
  mocks.session.mockResolvedValue(null);
  expect(
    (
      await GET(
        new Request("https://app.test/api/kith/documents/synthetic-source"),
        params,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await content(
        new Request(
          "https://app.test/api/kith/documents/synthetic-source/content",
        ),
        params,
      )
    ).status,
  ).toBe(401);
  expect(mocks.documents).not.toHaveBeenCalled();
});
test("an inaccessible source stays absent and reads use fresh authorized spaces", async () => {
  const principal = { userId: "current-user" };
  const ctx = { client: {} };
  mocks.session.mockImplementation(async (_cookie, run) =>
    run({ ctx, principal }),
  );
  mocks.documents.mockResolvedValue({ documents: [] });
  expect(
    (
      await GET(
        new Request(
          "https://app.test/api/kith/documents/synthetic-source?spaceId=foreign",
        ),
        params,
      )
    ).status,
  ).toBe(404);
  expect(mocks.spaces).toHaveBeenCalledWith(ctx, principal);
  expect(mocks.documents).toHaveBeenCalledWith(
    ctx.client,
    ["own-space"],
    "synthetic-source",
  );
});
