// The owner's overrides of a finance account's descriptive fields (ADM-2b,
// migration 035). The archive keeps the adapter's values; these sit beside
// them and win on screen. See the migration for why they are not written into
// the archive.
//
// The read takes a space the caller already narrowed to `getAdminSpaceIds`,
// the way `attention.ts` reads do. The write checks `requireSpaceAccess(...,
// "write")` itself.

import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";

export type AccountOverride = {
  accountId: string;
  displayName: string | null;
  accountLast4: string | null;
  accountType: string | null;
  closed: boolean;
};

function invalid(message: string): never {
  throw new IdentityError(message, { code: "invalid_input", message });
}

/** Trimmed text, or null for "no override". */
function optionalText(value: unknown, name: string, maximum: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid(`${name} must be text`);
  const text = value.trim();
  if (text === "") return null;
  if (Array.from(text).length > maximum) invalid(`${name} is too long`);
  return text;
}

export async function listAccountOverrides(
  ctx: IdentityCtx,
  args: { spaceId: string },
): Promise<AccountOverride[]> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  const found = await rows<{
    finance_account_id: string;
    display_name: string | null;
    account_last4: string | null;
    account_type: string | null;
    closed: boolean;
  }>(
    ctx,
    `SELECT finance_account_id, display_name, account_last4, account_type, closed
       FROM kith.finance_account_overrides WHERE space_id = $1`,
    [spaceId],
  );
  return found.map((item) => ({
    accountId: item.finance_account_id,
    displayName: item.display_name,
    accountLast4: item.account_last4,
    accountType: item.account_type,
    closed: item.closed,
  }));
}

/**
 * Sets an account's overrides. A blank field is "no override", and an account
 * with every field blank and not closed has no row at all, so clearing the
 * form restores the archive's values completely.
 */
export async function setAccountOverride(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    accountId: string;
    displayName?: string | null;
    accountLast4?: string | null;
    accountType?: string | null;
    closed?: boolean;
  },
): Promise<void> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const accountId = optionalText(args.accountId, "Account", 200);
  if (accountId === null) invalid("Account is required");
  const displayName = optionalText(args.displayName, "Name", 200);
  const accountLast4 = optionalText(args.accountLast4, "Last four", 4);
  if (accountLast4 !== null && !/^[0-9]{4}$/.test(accountLast4)) {
    invalid("Last four must be four digits");
  }
  const accountType = optionalText(args.accountType, "Type", 100);
  const closed = args.closed === true;
  if (
    displayName === null &&
    accountLast4 === null &&
    accountType === null &&
    !closed
  ) {
    await exec(
      ctx,
      `DELETE FROM kith.finance_account_overrides
        WHERE space_id = $1 AND finance_account_id = $2`,
      [spaceId, accountId],
    );
    return;
  }
  await exec(
    ctx,
    `INSERT INTO kith.finance_account_overrides
       (id, space_id, finance_account_id, display_name, account_last4,
        account_type, closed, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, transaction_timestamp(), $8)
     ON CONFLICT (space_id, finance_account_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           account_last4 = EXCLUDED.account_last4,
           account_type = EXCLUDED.account_type,
           closed = EXCLUDED.closed,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
    [
      newKithId(),
      spaceId,
      accountId,
      displayName,
      accountLast4,
      accountType,
      closed,
      args.principal.userId,
    ],
  );
}
