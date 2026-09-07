import { v, type Infer } from "convex/values";

import type { Doc } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import type { Principal, PrincipalRef } from "../../lib/spaces";
import { reloadPrincipal } from "../../lib/spaces";
import { createOrGetSourceItem } from "../provenance/model";
import { sha256Hex, utf8ByteLength } from "./hash";
import {
  consumeIngestAdmissionRateLimit,
  resolveIngestSourceAccount,
} from "./inlineInput";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_ACCOUNT_ID_BYTES = 512;
const MAX_FIELD_BYTES = 2_048;

const enqueueUrlInputValidator = v.object({
  spaceId: v.optional(v.id("spaces")),
  requestId: v.string(),
  source: v.object({
    connector: v.literal("mcp-client"),
    accountId: v.string(),
    externalId: v.string(),
  }),
  url: v.string(),
  title: v.optional(v.string()),
});

export type EnqueueUrlInput = Infer<typeof enqueueUrlInputValidator>;

function requireBounded(value: string, label: string, maximum: number) {
  if (!value.trim() || utf8ByteLength(value) > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-8 bytes`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${label} contains malformed UTF-16`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains malformed UTF-16`);
    }
  }
}

export function validateEnqueueUrlInput(input: EnqueueUrlInput) {
  requireBounded(input.requestId, "requestId", MAX_REQUEST_ID_BYTES);
  requireBounded(
    input.source.accountId,
    "Source account ID",
    MAX_ACCOUNT_ID_BYTES,
  );
  requireBounded(
    input.source.externalId,
    "External source ID",
    MAX_FIELD_BYTES,
  );
  if (input.title !== undefined) {
    requireBounded(input.title, "Source title", MAX_FIELD_BYTES);
  }
  requireBounded(input.url, "URL", MAX_FIELD_BYTES);
  if (
    input.url !== input.url.trim() ||
    /[\\\u0000-\u001f\u007f]/u.test(input.url) ||
    !/^https?:\/\//iu.test(input.url)
  ) {
    throw new Error("URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error("URL is invalid");
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(input.url)?.[1];
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    authority === undefined ||
    authority.includes("@") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !parsed.hostname
  ) {
    throw new Error("URL must be an http(s) URL without user information");
  }
}

async function requestDigest(
  sourceAccount: Doc<"sourceAccounts">,
  input: EnqueueUrlInput,
) {
  return await sha256Hex(
    JSON.stringify([
      "enqueue-url-v1",
      sourceAccount._id,
      input.source.connector,
      input.source.accountId,
      input.source.externalId,
      input.url,
      input.title ?? null,
    ]),
  );
}

function result(row: Doc<"sourceFetchRequests">) {
  return {
    state: "queued" as const,
    workerRequired: true as const,
    sourceItemId: row.sourceItemId,
    requestId: row.requestId,
    fetchRequestId: row._id,
  };
}

export async function enqueueSourceFetch(
  ctx: MutationCtx,
  args: {
    principal: Principal | PrincipalRef;
    input: EnqueueUrlInput;
    now: number;
  },
) {
  validateEnqueueUrlInput(args.input);
  if (!Number.isSafeInteger(args.now) || args.now < 0) {
    throw new Error("Queue time is invalid");
  }
  const principal = await reloadPrincipal(
    ctx,
    "capabilities" in args.principal
      ? {
          userId: args.principal.userId,
          ...(args.principal.credentialId
            ? { credentialId: args.principal.credentialId }
            : {}),
        }
      : args.principal,
  );
  if (!principal.credentialId) {
    throw new Error("URL ingestion requires an MCP credential");
  }
  const sourceAccount = await resolveIngestSourceAccount(ctx, principal, {
    ...(args.input.spaceId ? { spaceId: args.input.spaceId } : {}),
    connector: args.input.source.connector,
    accountId: args.input.source.accountId,
  });
  const digest = await requestDigest(sourceAccount, args.input);
  const matches = await ctx.db
    .query("sourceFetchRequests")
    .withIndex("by_sourceAccountId_requestId", (q) =>
      q
        .eq("sourceAccountId", sourceAccount._id)
        .eq("requestId", args.input.requestId),
    )
    .take(2);
  if (matches.length > 1) throw new Error("Duplicate URL request identity");
  const existing = matches[0];
  if (existing) {
    if (existing.requestDigest !== digest) {
      throw new Error("requestId conflicts with a different request");
    }
    if (
      existing.spaceId !== sourceAccount.spaceId ||
      existing.url !== args.input.url ||
      existing.title !== args.input.title ||
      existing.state !== "queued"
    ) {
      throw new Error("Stored URL request is invalid");
    }
    const item = await ctx.db.get(existing.sourceItemId);
    if (
      !item ||
      item.spaceId !== sourceAccount.spaceId ||
      item.sourceAccountId !== sourceAccount._id ||
      item.externalId !== args.input.source.externalId
    ) {
      throw new Error("Stored URL request source is invalid");
    }
    if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
      throw new Error(`Source item is ${item.lifecycle}`);
    }
    return result(existing);
  }

  await consumeIngestAdmissionRateLimit(ctx, {
    credentialId: principal.credentialId,
    now: args.now,
  });
  const sourceItem = await createOrGetSourceItem(ctx, {
    spaceId: sourceAccount.spaceId,
    sourceAccountId: sourceAccount._id,
    externalId: args.input.source.externalId,
    // The request owns pre-fetch metadata. A worker may publish source-item
    // metadata only after it has fetched and validated the source.
    uri: args.input.url,
  });
  const id = await ctx.db.insert("sourceFetchRequests", {
    spaceId: sourceAccount.spaceId,
    sourceAccountId: sourceAccount._id,
    sourceItemId: sourceItem._id,
    actorUserId: principal.userId,
    actorCredentialId: principal.credentialId,
    requestId: args.input.requestId,
    requestDigest: digest,
    url: args.input.url,
    ...(args.input.title === undefined ? {} : { title: args.input.title }),
    state: "queued",
    createdAt: args.now,
  });
  return result((await ctx.db.get(id))!);
}

/** Queue-only Phase 1 endpoint. It never fetches the URL or creates a revision. */
export const enqueue = mutation({
  args: { input: enqueueUrlInputValidator },
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    return await enqueueSourceFetch(ctx, {
      principal,
      input: args.input,
      now: Date.now(),
    });
  },
});
