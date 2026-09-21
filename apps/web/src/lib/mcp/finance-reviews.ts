import {
  actOnFinanceReviewItem,
  type FinanceReviewAction,
  FinanceReviewActionError,
  getFinanceReviewItem,
  listFinanceReviewItems,
  type ListFinanceReviewItemsInput,
} from "@repo/finance-archive";
import {
  type ArchiveClient,
  assertSchemaName,
  createArchivePool,
} from "@repo/finance-archive/store";
import { IdentityError, requireSpaceAccess } from "@repo/kith-store/identity";

import type { WithMcpPrincipal } from "./principal";

export type FinanceReviewAccess = {
  spaceId: string;
  list: (
    args: ListFinanceReviewItemsInput,
  ) => ReturnType<typeof listFinanceReviewItems>;
  get: (id: string) => ReturnType<typeof getFinanceReviewItem>;
  act:
    | ((
        action: FinanceReviewAction,
      ) => ReturnType<typeof actOnFinanceReviewItem>)
    | null;
};

function inputError(message: string): IdentityError {
  return new IdentityError(message, { code: "invalid_input", message });
}

const pools = new Map<string, ReturnType<typeof createArchivePool>>();
function poolFor(url: string, schema: string) {
  const key = JSON.stringify([url, schema]);
  let pool = pools.get(key);
  if (!pool) {
    pool = createArchivePool(url, schema);
    pools.set(key, pool);
  }
  return pool;
}

export function resolveFinanceReviews(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FinanceReviewAccess | null {
  const readerUrl = env.FINANCE_ARCHIVE_READER_DATABASE_URL;
  const writerUrl = env.FINANCE_ARCHIVE_DATABASE_URL;
  const spaceId = env.FINANCE_ARCHIVE_SPACE_ID;
  if (!readerUrl || !spaceId) return null;
  const schema = assertSchemaName(env.FINANCE_ARCHIVE_SCHEMA ?? "finance");

  async function read<T>(
    run: (client: ArchiveClient) => Promise<T>,
  ): Promise<T> {
    const client = await poolFor(readerUrl!, schema).connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }

  return {
    spaceId,
    list: (args) => read((client) => listFinanceReviewItems(client, args)),
    get: (id) => read((client) => getFinanceReviewItem(client, id)),
    act: writerUrl
      ? async (action) => {
          const client = await poolFor(writerUrl, schema).connect();
          try {
            return await actOnFinanceReviewItem(client, action);
          } finally {
            client.release();
          }
        }
      : null,
  };
}

/** The archive has no space column. Always authorize its configured space. */
export function postgresFinanceReviews(
  withPrincipal: WithMcpPrincipal,
  archive: FinanceReviewAccess | null = resolveFinanceReviews(),
) {
  async function authorized<T>(
    operation: "read" | "write",
    run: (access: FinanceReviewAccess) => Promise<T>,
  ): Promise<T> {
    return withPrincipal(
      async ({ ctx, principal }) => {
        if (!archive) {
          throw inputError("Finance review provider is not configured");
        }
        await requireSpaceAccess(ctx, principal, archive.spaceId, operation);
        try {
          return await run(archive);
        } catch (error) {
          if (error instanceof FinanceReviewActionError) {
            throw inputError(error.message);
          }
          throw error;
        }
        // The archive owns its write transaction. A read-only identity transaction
        // avoids replaying an already-committed archive action on Kith write retries.
      },
      { readOnly: true },
    );
  }

  return {
    listReviews: (args: ListFinanceReviewItemsInput) =>
      authorized("read", (access) =>
        access.list({ ...args, status: args.status ?? "open" }),
      ),
    getReview: (args: { reviewId: string }) =>
      authorized("read", (access) => access.get(args.reviewId)),
    manageReview: (action: FinanceReviewAction) =>
      authorized("write", (access) => {
        if (!access.act) {
          throw inputError("Finance review writer is not configured");
        }
        return access.act(action);
      }),
  };
}
