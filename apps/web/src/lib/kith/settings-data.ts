// The settings page's first paint, on PostgreSQL: the destination settings,
// the caller's spaces, the source accounts across them, and the first page of
// API keys, all from the one read-only transaction this page's server
// component opens. Every later action (create, revoke, edit) is a client-side
// fetch to `/api/kith/*`, each of which reloads the session and opens its own
// transaction exactly as `app/api/auth/*` already does.

import { sources } from "@repo/kith-store";
import {
  type ApiKeySummary,
  getSettings,
  listApiKeysPage,
  type ListedSpace,
  listSpaces,
} from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

const FIRST_PAGE_SIZE = 25;

export type SettingsData = {
  settings: { personalSpaceId: string; defaultWriteSpaceId: string | null };
  spaces: ListedSpace[];
  sourceAccounts: sources.SourceAccountSummary[];
  apiKeys: {
    page: ApiKeySummary[];
    isDone: boolean;
    continueCursor: string | null;
  };
};

export async function loadSettings(
  cookieHeader: string | null,
): Promise<SettingsData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => {
    const settings = await getSettings(ctx, { principal });
    const spaces = await listSpaces(ctx, { principal });
    const sourceAccounts = await sources.listSourceAccounts(ctx, { principal });
    const apiKeys = await listApiKeysPage(ctx, {
      principal,
      numItems: FIRST_PAGE_SIZE,
    });
    return { settings, spaces, sourceAccounts, apiKeys };
  });
}
