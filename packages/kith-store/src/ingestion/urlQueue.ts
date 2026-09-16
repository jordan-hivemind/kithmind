// The `ingest_url` tool's whole Phase 1 behaviour: store the request, fetch
// nothing.
//
// Ported from `models/ingestion/urlQueue.ts`. The contract is explicit that this
// endpoint "is stored as a fetch request, not as invented source text or an
// indexed document" and that "Phase 1 does not fetch, follow redirects,
// download files, or make model calls", so the only durable effect is one
// `kith.source_fetch_requests` row and the `kith.source_items` row it hangs off.
//
// The URL validation is the part worth not simplifying. A later fetch worker
// will hand these strings to an HTTP client, so the refusals here -- no
// credentials in the authority, no control characters, no backslash, http(s)
// only -- are the first of the defenses that worker still owes, not a tidiness
// check. They stay byte-exact with the Convex original for that reason.

import { newKithId } from "../ids.js";
import {
  reloadPrincipal,
  type Principal,
  type PrincipalRef,
} from "../identity/authorization.js";
import { createOrGetSourceItem } from "../provenance/model.js";
import { at, exec, row, rows } from "../workers/db.js";
import { sha256Hex, utf8ByteLength } from "./inline.js";
import {
  consumeIngestAdmissionRateLimit,
  identityFor,
  resolveIngestSourceAccount,
  type InlineCtx,
} from "./input.js";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_ACCOUNT_ID_BYTES = 512;
const MAX_FIELD_BYTES = 2_048;

export type EnqueueUrlInput = {
  spaceId?: string;
  requestId: string;
  source: {
    connector: "mcp-client";
    accountId: string;
    externalId: string;
  };
  url: string;
  title?: string;
};

export type EnqueueUrlResult = {
  state: "queued";
  workerRequired: true;
  sourceItemId: string;
  requestId: string;
  fetchRequestId: string;
};

function requireBounded(value: string, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    utf8ByteLength(value) > maximum
  ) {
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

/** Every refusal the queued URL has to survive before a worker ever sees it. */
export function validateEnqueueUrlInput(input: EnqueueUrlInput): void {
  if (input === null || typeof input !== "object") {
    throw new Error(
      `requestId must contain 1-${MAX_REQUEST_ID_BYTES} UTF-8 bytes`,
    );
  }
  if (input.source?.connector !== "mcp-client") {
    throw new Error("source.connector is invalid");
  }
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
  // The authority is re-extracted from the raw string rather than trusted from
  // the parser: `URL` normalizes some credential forms away, and a URL whose
  // userinfo only disappears on parse is exactly the one to refuse.
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
  sourceAccountId: string,
  input: EnqueueUrlInput,
): Promise<string> {
  return await sha256Hex(
    JSON.stringify([
      "enqueue-url-v1",
      sourceAccountId,
      input.source.connector,
      input.source.accountId,
      input.source.externalId,
      input.url,
      input.title ?? null,
    ]),
  );
}

type FetchRequestRow = {
  id: string;
  space_id: string;
  source_account_id: string;
  source_item_id: string;
  request_id: string;
  request_digest: string;
  url: string;
  title: string | null;
  state: string;
};

function result(record: FetchRequestRow): EnqueueUrlResult {
  return {
    state: "queued",
    workerRequired: true,
    sourceItemId: record.source_item_id,
    requestId: record.request_id,
    fetchRequestId: record.id,
  };
}

/**
 * `models/ingestion/urlQueue.ts` `enqueueSourceFetch`, one transaction.
 *
 * Idempotent by `(source account, request id)` exactly as inline admission is
 * by its receipt: a replay with the same arguments returns the stored request
 * and writes nothing, a replay with different arguments is a conflict, and only
 * a genuinely new request consumes a rate-limit slot.
 */
export async function enqueueSourceFetch(
  ctx: InlineCtx,
  args: { principal: Principal | PrincipalRef; input: EnqueueUrlInput },
): Promise<EnqueueUrlResult> {
  validateEnqueueUrlInput(args.input);
  if (!Number.isSafeInteger(ctx.now) || ctx.now < 0) {
    throw new Error("Queue time is invalid");
  }
  const principal = await reloadPrincipal(
    identityFor(ctx),
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
  const account = await resolveIngestSourceAccount(ctx, principal, {
    ...(args.input.spaceId === undefined
      ? {}
      : { spaceId: args.input.spaceId }),
    connector: args.input.source.connector,
    accountId: args.input.source.accountId,
  });
  const spaceId = account.spaceId;
  const digest = await requestDigest(account.id, args.input);
  const matches = await rows<FetchRequestRow>(
    ctx,
    `SELECT id, space_id, source_account_id, source_item_id, request_id,
            request_digest, url, title, state
       FROM kith.source_fetch_requests
      WHERE space_id = $1 AND source_account_id = $2 AND request_id = $3
      ORDER BY created_at, id LIMIT 2`,
    [spaceId, account.id, args.input.requestId],
  );
  if (matches.length > 1) throw new Error("Duplicate URL request identity");
  const existing = matches[0];
  if (existing) {
    if (existing.request_digest !== digest) {
      throw new Error("requestId conflicts with a different request");
    }
    if (
      existing.url !== args.input.url ||
      existing.title !== (args.input.title ?? null) ||
      existing.state !== "queued"
    ) {
      throw new Error("Stored URL request is invalid");
    }
    const item = await row<{
      id: string;
      source_account_id: string;
      external_id: string | null;
      lifecycle: string;
    }>(
      ctx,
      `SELECT id, source_account_id, external_id, lifecycle
         FROM kith.source_items WHERE id = $1 AND space_id = $2`,
      [existing.source_item_id, spaceId],
    );
    if (
      !item ||
      item.source_account_id !== account.id ||
      item.external_id !== args.input.source.externalId
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
    now: ctx.now,
  });
  const sourceItem = await createOrGetSourceItem(ctx.client, {
    spaceId,
    sourceAccountId: account.id,
    externalId: args.input.source.externalId,
    // The request owns pre-fetch metadata, including the title. A worker may
    // publish source-item metadata only once it has fetched and validated the
    // source, so inventory may legitimately show this item untitled until then.
    uri: args.input.url,
  });
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.source_fetch_requests
       (id, space_id, created_at, source_account_id, source_item_id, actor_user_id,
        actor_credential_id, request_id, request_digest, url, title, state,
        created_at_field)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11)`,
    [
      id,
      spaceId,
      account.id,
      sourceItem.id,
      principal.userId,
      principal.credentialId,
      args.input.requestId,
      digest,
      args.input.url,
      args.input.title ?? null,
      at(ctx.now),
    ],
  );
  const created = await row<FetchRequestRow>(
    ctx,
    `SELECT id, space_id, source_account_id, source_item_id, request_id,
            request_digest, url, title, state
       FROM kith.source_fetch_requests WHERE id = $1 AND space_id = $2`,
    [id, spaceId],
  );
  if (!created) throw new Error("Failed to create URL request");
  return result(created);
}
