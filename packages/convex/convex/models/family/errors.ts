import { ConvexError } from "convex/values";

const FAMILY_ERROR_MESSAGES = {
  not_authenticated: "Sign in to manage family spaces.",
  invalid_input: "The family space request is invalid.",
  space_not_found: "Family space not found.",
  owner_required: "Only a family space owner can do that.",
  invitation_not_found: "Invitation not found.",
  invitation_expired: "This invitation has expired.",
  invitation_unavailable: "This invitation is no longer available.",
  invitation_limit_reached: "This family space has too many invitations.",
  member_limit_reached: "This family space has reached its member limit.",
  already_member: "This account is already a member of the family space.",
  cannot_self_approve: "Another owner must approve this account.",
  last_owner: "A family space must keep at least one owner.",
} as const;

export type FamilyErrorCode = keyof typeof FAMILY_ERROR_MESSAGES;

export type FamilyErrorData = {
  code: FamilyErrorCode;
  message: (typeof FAMILY_ERROR_MESSAGES)[FamilyErrorCode];
};

const familyErrorCodes = new Set<string>(Object.keys(FAMILY_ERROR_MESSAGES));

export function parseFamilyErrorData(
  value: unknown,
): FamilyErrorData | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !familyErrorCodes.has(value.code) ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  const code = value.code as FamilyErrorCode;
  const message = FAMILY_ERROR_MESSAGES[code];
  return value.message === message ? { code, message } : undefined;
}

export function familyError(code: FamilyErrorCode): never {
  throw new ConvexError({ code, message: FAMILY_ERROR_MESSAGES[code] });
}

export function rethrowFamilyError(error: unknown): never {
  if (
    error instanceof ConvexError &&
    parseFamilyErrorData(error.data) !== undefined
  ) {
    throw error;
  }
  if (error instanceof Error && error.message === "Not authenticated") {
    familyError("not_authenticated");
  }
  throw error;
}
