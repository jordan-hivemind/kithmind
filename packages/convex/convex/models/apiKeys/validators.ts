import { v } from "convex/values";

export const capability = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("ingest"),
);

export const principalRefValidator = v.object({
  userId: v.id("users"),
  credentialId: v.optional(v.id("apiKeys")),
});

export const oauthLifecycle = v.union(
  v.literal("preparing"),
  v.literal("pending"),
);

export const apiKeyFields = {
  userId: v.id("users"),
  keyHash: v.string(),
  keyPrefix: v.string(),
  name: v.string(),
  lastUsedAt: v.optional(v.number()),
  capabilities: v.array(capability),
  spaceIds: v.array(v.id("spaces")),
  sourceAccountIds: v.optional(v.array(v.id("sourceAccounts"))),
  oauthLifecycle: v.optional(oauthLifecycle),
  oauthRequestHash: v.optional(v.string()),
  oauthCodeHash: v.optional(v.string()),
  oauthBindingHash: v.optional(v.string()),
  oauthBindingSeedHash: v.optional(v.string()),
  oauthEncryptedCode: v.optional(v.string()),
  oauthGrantExpiresAt: v.optional(v.number()),
  oauthPreparationExpiresAt: v.optional(v.number()),
  oauthPreparationNonce: v.optional(v.string()),
};

type OAuthLifecycleFields = {
  oauthLifecycle?: "preparing" | "pending";
  oauthRequestHash?: string;
  oauthCodeHash?: string;
  oauthBindingHash?: string;
  oauthBindingSeedHash?: string;
  oauthEncryptedCode?: string;
  oauthGrantExpiresAt?: number;
  oauthPreparationExpiresAt?: number;
  oauthPreparationNonce?: string;
};

type ActiveOAuthKey = OAuthLifecycleFields & {
  oauthLifecycle?: undefined;
  oauthRequestHash?: undefined;
  oauthCodeHash?: undefined;
  oauthBindingHash?: undefined;
  oauthBindingSeedHash?: undefined;
  oauthEncryptedCode?: undefined;
  oauthGrantExpiresAt?: undefined;
  oauthPreparationExpiresAt?: undefined;
  oauthPreparationNonce?: undefined;
};

type PreparingOAuthKey = OAuthLifecycleFields & {
  oauthLifecycle: "preparing";
  oauthRequestHash: string;
  oauthCodeHash?: undefined;
  oauthBindingHash?: undefined;
  oauthBindingSeedHash: string;
  oauthEncryptedCode?: undefined;
  oauthGrantExpiresAt: number;
  oauthPreparationExpiresAt: number;
  oauthPreparationNonce: string;
};

type PendingOAuthKey = OAuthLifecycleFields & {
  oauthLifecycle: "pending";
  oauthRequestHash: string;
  oauthCodeHash: string;
  oauthBindingHash: string;
  oauthBindingSeedHash: string;
  oauthEncryptedCode: string;
  oauthGrantExpiresAt: number;
  oauthPreparationExpiresAt?: undefined;
  oauthPreparationNonce?: undefined;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function hasNoOAuthLifecycle<T extends OAuthLifecycleFields>(
  fields: T,
): fields is T & ActiveOAuthKey {
  return (
    fields.oauthLifecycle === undefined &&
    fields.oauthRequestHash === undefined &&
    fields.oauthCodeHash === undefined &&
    fields.oauthBindingHash === undefined &&
    fields.oauthBindingSeedHash === undefined &&
    fields.oauthEncryptedCode === undefined &&
    fields.oauthGrantExpiresAt === undefined &&
    fields.oauthPreparationExpiresAt === undefined &&
    fields.oauthPreparationNonce === undefined
  );
}

export function isPreparingOAuthKey<T extends OAuthLifecycleFields>(
  fields: T,
): fields is T & PreparingOAuthKey {
  return (
    fields.oauthLifecycle === "preparing" &&
    fields.oauthRequestHash !== undefined &&
    fields.oauthCodeHash === undefined &&
    fields.oauthBindingHash === undefined &&
    fields.oauthBindingSeedHash !== undefined &&
    fields.oauthEncryptedCode === undefined &&
    fields.oauthGrantExpiresAt !== undefined &&
    fields.oauthPreparationExpiresAt !== undefined &&
    Number.isSafeInteger(fields.oauthGrantExpiresAt) &&
    Number.isSafeInteger(fields.oauthPreparationExpiresAt) &&
    fields.oauthPreparationNonce !== undefined &&
    fields.oauthGrantExpiresAt > 0 &&
    fields.oauthPreparationExpiresAt > 0 &&
    fields.oauthPreparationExpiresAt <= fields.oauthGrantExpiresAt &&
    SHA256_HEX.test(fields.oauthRequestHash) &&
    SHA256_HEX.test(fields.oauthBindingSeedHash) &&
    SHA256_HEX.test(fields.oauthPreparationNonce)
  );
}

export function isPendingOAuthKey<T extends OAuthLifecycleFields>(
  fields: T,
): fields is T & PendingOAuthKey {
  return (
    fields.oauthLifecycle === "pending" &&
    fields.oauthRequestHash !== undefined &&
    fields.oauthCodeHash !== undefined &&
    fields.oauthBindingHash !== undefined &&
    fields.oauthBindingSeedHash !== undefined &&
    fields.oauthEncryptedCode !== undefined &&
    /^obac1\.[A-Za-z0-9_-]+$/.test(fields.oauthEncryptedCode) &&
    fields.oauthEncryptedCode.length <= 8192 &&
    fields.oauthGrantExpiresAt !== undefined &&
    Number.isSafeInteger(fields.oauthGrantExpiresAt) &&
    fields.oauthGrantExpiresAt > 0 &&
    fields.oauthPreparationExpiresAt === undefined &&
    fields.oauthPreparationNonce === undefined &&
    SHA256_HEX.test(fields.oauthRequestHash) &&
    SHA256_HEX.test(fields.oauthCodeHash) &&
    SHA256_HEX.test(fields.oauthBindingHash) &&
    SHA256_HEX.test(fields.oauthBindingSeedHash)
  );
}
