// The identity and authorization service surface.
//
// One closed surface over `kith.users`, `auth_accounts`, `sessions`, `spaces`,
// `space_members`, `user_space_settings`, `api_keys` with its two grant tables,
// `family_invitations` and `consumed_oauth_codes`. Section 2.5 defers row level
// security on the grounds that "all access goes through the closed typed service
// surface, and no untrusted caller ever gets SQL through it" -- this is that
// surface, and the guarantee only holds while it stays the only way in.
//
// Names and argument shapes match the Convex functions they replace so P2-39i is
// a repoint rather than a rewrite. Nothing here is wired to the web app or the MCP
// server yet, by design.

export { IdentityError, notAuthenticated, spaceNotFound } from "./errors.js";
export { identityCtx, type IdentityCtx } from "./db.js";

export {
  API_KEY_TOUCH_MIN_MS,
  // The boundary itself.
  requireSpaceAccess,
  getAuthorizedReadSpaceIds,
  authorizedSpacePredicate,
  reloadPrincipal,
  principalFromApiKey,
  principalRef,
  principalMaxSensitivity,
  webPrincipal,
  hasNoOAuthLifecycle,
  // Personal space bootstrap and write destination.
  ensurePersonalSpace,
  inspectPersonalSpace,
  insertMissingPersonalSpaceRecords,
  isPersonalSpaceReady,
  resolveWriteSpace,
  // Row reads the surface above is built from.
  getApiKey,
  getApiKeyByHash,
  getSpace,
  touchApiKey,
  userExists,
  type ApiKeyRecord,
  type Capability,
  type PersonalSpaceInspection,
  type Principal,
  type PrincipalRef,
  type Space,
  type SpaceMember,
  type SpaceOperation,
  type SpaceRole,
} from "./authorization.js";

export { hashPassword, verifyPassword } from "./scrypt.js";

export {
  PASSWORD_PROVIDER,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  SESSION_TOUCH_MIN_MS,
  changePassword,
  clearedSessionCookie,
  createSession,
  getPasswordAccount,
  parseSessionToken,
  readSessionCookie,
  removeExpiredSessions,
  requireWebPrincipal,
  requireWebSession,
  requireWebUserId,
  resolveSessionToken,
  revokeSession,
  revokeUserSessions,
  serializeSessionToken,
  sessionCookie,
  signIn,
  signOut,
  signUp,
  touchSession,
  type AuthAccount,
  type SessionConfig,
  type SessionRecord,
  type SessionRequest,
  type SessionResolveOptions,
} from "./webAuth.js";

export {
  authenticateApiKey,
  create as createApiKey,
  generateApiKeyMaterial,
  list as listApiKeys,
  listByUser as listApiKeysByUser,
  listPage as listApiKeysPage,
  requireMcpPrincipal,
  revoke as revokeApiKey,
  update as updateApiKey,
  validateApiKeyName,
  validateApiKeyScopes,
  type ApiKeySummary,
} from "./apiKeys.js";

export {
  OAUTH_ERROR_MESSAGES,
  abandonAuthorizationGrant,
  activateAuthorizationGrant,
  auditOAuthLifecycle,
  beginAuthorizationGrant,
  canonicalConsent,
  finalizeAuthorizationGrant,
  grantLifecycle,
  isOAuthError,
  isPendingOAuthKey,
  isPreparingOAuthKey,
  oauthError,
  removeExpired as removeExpiredOAuthGrants,
  requireOAuthExchangeIdentity,
  type BeginResult,
  type ConsentArgs,
  type OAuthErrorCode,
  type OAuthExchangeIdentity,
} from "./oauth.js";

export {
  authorize,
  ensurePersonal,
  getSettings,
  listAuthorizedReadSpaceIds,
  listSpaces,
  resolveWriteDestination,
  setDefaultWriteSpace,
  type ListedSpace,
} from "./spaces.js";

export {
  FAMILY_ERROR_MESSAGES,
  FAMILY_INVITATION_TTL_MS,
  MAX_FAMILY_INVITATIONS,
  MAX_FAMILY_MEMBERS,
  MAX_USER_SPACE_MEMBERSHIPS,
  acceptInvitationByToken,
  activeInvitations,
  approveInvitationForOwner,
  changeFamilyMemberRole,
  createInvitation,
  createSharedSpace,
  familyError,
  getFamilySpace,
  isFamilyError,
  leaveSharedSpace,
  normalizeInvitationEmail,
  removeFamilyMember,
  requireSharedMembership,
  requireSharedOwner,
  rethrowFamilyError,
  revokeInvitationForOwner,
  storeInvitation,
  transferSharedSpaceOwnership,
  validateFamilyInvitationRole,
  validateFamilySpaceName,
  validateInvitationToken,
  type FamilyErrorCode,
  type FamilyInvitation,
  type FamilyInvitationRole,
  type FamilyInvitationStatus,
  type FamilySpaceView,
} from "./family.js";

export {
  authDenialSurface,
  authDenialSurfaceOnPool,
  type AuthDenialSurface,
} from "./denials.js";

export {
  AUTH_RATE_LIMIT_SWEEP_WINDOW_MS,
  consumeAuthAttempt,
  type AuthRateLimitAttempt,
  type AuthRateLimitConsumption,
} from "./rateLimits.js";
