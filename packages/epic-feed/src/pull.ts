// `kith-epic-feed pull`: one round over every linked `kith.health_sources`
// row.
//
// For each source: refresh the access token when a refresh token is on
// file (an `invalid_grant` sets `needs_reauth_at` and reports -- never
// retried in this process); when none is on file, use the stored access
// token directly as long as it still has more than 60 seconds of life left
// (Epic's sandbox has been observed to issue a token with no refresh grant
// at all), otherwise mark `needs_reauth` as above. Then fetch `Patient` by
// id, then page through every `SEARCHABLE_RESOURCES` type's search by
// patient with `_count=200`, following `link[rel=next]`, retrying 429 and
// 5xx with backoff (`fetchRetry.ts`). `DocumentReference` also fetches its
// `Binary` attachment when the content type qualifies (`documents.ts`).
//
// Nothing here prints a value, a note's text or a diagnosis -- only counts --
// and the process exits non-zero when any source needed reauth, failed
// outright, or had a resource-type fetch error.

import { mkdir, writeFile } from "node:fs/promises";

import type { Pool } from "pg";

import {
  healthDataDir,
  loadClientId,
  loadClientSecretForOrg,
  loadDatabaseUrl,
  personSlug,
  SANDBOX_FHIR_BASE,
  SEARCHABLE_RESOURCES,
  type EpicEnv,
} from "./config.js";
import {
  type HealthSourceRow,
  listHealthSources,
  openPool,
  recordPullFailure,
  recordPullSuccess,
  upsertHealthDocument,
  upsertHealthRecord,
} from "./db.js";
import { extractText, isFetchableContentType, storageFileName } from "./documents.js";
import { fetchWithRetry } from "./fetchRetry.js";
import { mapResource } from "./mappers.js";
import {
  discoverSmartConfiguration,
  InvalidGrantError,
  refreshAccessToken,
  type ClientAuthMethod,
  type Fetch,
} from "./oauth.js";
import { keychainTokenStore, type TokenStore } from "./keychain.js";

export type StoredToken = {
  refreshToken: string | null;
  accessToken: string;
  expiresAt: string;
  patientFhirId: string;
  fhirBase: string;
  orgName: string;
  /** How this token was obtained (`"secret"` HTTP Basic, `"public"`
   * `client_id` in the body). Absent on a token written before this field
   * existed -- treated as `"secret"`, matching the exchange's previous,
   * only, behavior. */
  clientAuth?: ClientAuthMethod;
};

export type SourcePullResult = {
  orgName: string;
  status: "ok" | "needs_reauth" | "failed";
  counts: Record<string, number>;
  documents: number;
  error: string | null;
  resourceErrors: Record<string, string>;
  /** Set when this pull used the stored access token directly because no
   * refresh token is on file (e.g. Epic's sandbox issuing a token with no
   * refresh grant) -- `"access token only; expires in <n> minutes"`.
   * Printed in the summary line so an operator watching the daily log knows
   * this source will need `authorize` again once the access token expires.
   * `null` otherwise. */
  tokenNote: string | null;
};

export type PullDeps = {
  fetchImpl?: Fetch;
  /** Where a person's tokens are read and rewritten after a refresh.
   * Defaults to the real Keychain; a test passes an in-memory store. */
  tokenStore?: TokenStore;
  /** Overrides where a PDF/RTF attachment is written; see `pullSource`. */
  dataDirRoot?: (personSlugValue: string) => string;
};

function emptyResult(orgName: string): SourcePullResult {
  const counts: Record<string, number> = { Patient: 0 };
  for (const resource of SEARCHABLE_RESOURCES) counts[resource] = 0;
  return {
    orgName,
    status: "ok",
    counts,
    documents: 0,
    error: null,
    resourceErrors: {},
    tokenNote: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fhirEnvOf(fhirBase: string): EpicEnv {
  return fhirBase === SANDBOX_FHIR_BASE ? "sandbox" : "production";
}

async function fetchFhir(
  url: string,
  accessToken: string,
  fetchImpl: Fetch,
): Promise<Response> {
  return await fetchWithRetry(
    url,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/fhir+json",
      },
    },
    fetchImpl,
  );
}

/** One source's pull, given an already-refreshed access token. Exported so a
 * test can drive it against a mocked fetch and a fake pool.
 *
 * `dataDirRoot` overrides where a PDF/RTF attachment is written (default:
 * `healthDataDir`, under `$HOME`) -- a test points it at a throwaway
 * directory rather than ever touching the real one. */
export async function pullSource(
  pool: Pool,
  source: HealthSourceRow,
  accessToken: string,
  fetchImpl: Fetch,
  dataDirRoot?: (personSlugValue: string) => string,
): Promise<SourcePullResult> {
  const result = emptyResult(source.orgName);

  // Patient: required, matching Plaid's own balances-required shape. A
  // failure here ends this source's pull.
  let patient: Record<string, unknown>;
  try {
    const response = await fetchFhir(
      `${source.fhirBase}Patient/${source.patientFhirId}`,
      accessToken,
      fetchImpl,
    );
    if (!response.ok) {
      throw new Error(`Patient fetch failed (${response.status})`);
    }
    patient = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    result.status = "failed";
    result.error = errorMessage(error);
    await recordPullFailure(pool, source.id, result.error, false);
    return result;
  }
  const mappedPatient = mapResource({ ...patient, resourceType: "Patient" });
  await upsertHealthRecord(
    pool,
    source.id,
    source.personId,
    "Patient",
    mappedPatient,
    patient,
  );
  result.counts.Patient = 1;

  for (const resourceType of SEARCHABLE_RESOURCES) {
    try {
      let url: string | null =
        `${source.fhirBase}${resourceType}?patient=${encodeURIComponent(source.patientFhirId)}&_count=200`;
      while (url !== null) {
        const response = await fetchFhir(url, accessToken, fetchImpl);
        if (!response.ok) {
          throw new Error(`${resourceType} search failed (${response.status})`);
        }
        const bundle = (await response.json()) as {
          entry?: Array<{ resource?: Record<string, unknown> }>;
          link?: Array<{ relation?: string; url?: string }>;
        };
        for (const entry of bundle.entry ?? []) {
          const resource = entry.resource;
          if (!resource || resource.resourceType !== resourceType) continue;
          const mapped = mapResource(resource);
          const recordId = await upsertHealthRecord(
            pool,
            source.id,
            source.personId,
            resourceType,
            mapped,
            resource,
          );
          result.counts[resourceType] = (result.counts[resourceType] ?? 0) + 1;
          if (resourceType === "DocumentReference") {
            const documentStored = await pullDocumentAttachment(
              pool,
              source,
              recordId,
              mapped.fhirId,
              resource,
              accessToken,
              fetchImpl,
              dataDirRoot,
            );
            if (documentStored) result.documents += 1;
          }
        }
        const next = (bundle.link ?? []).find((link) => link.relation === "next");
        url = next?.url ?? null;
      }
    } catch (error) {
      result.resourceErrors[resourceType] = errorMessage(error);
    }
  }

  await recordPullSuccess(pool, source.id);
  return result;
}

async function pullDocumentAttachment(
  pool: Pool,
  source: HealthSourceRow,
  recordId: string,
  documentFhirId: string,
  resource: Record<string, unknown>,
  accessToken: string,
  fetchImpl: Fetch,
  dataDirRoot?: (personSlugValue: string) => string,
): Promise<boolean> {
  const contentEntries = Array.isArray(resource.content)
    ? (resource.content as Array<Record<string, unknown>>)
    : [];
  for (const entry of contentEntries) {
    const attachment = entry.attachment as Record<string, unknown> | undefined;
    const contentType =
      typeof attachment?.contentType === "string" ? attachment.contentType : null;
    if (contentType === null || !isFetchableContentType(contentType)) continue;

    let buffer: Buffer;
    const inlineData = typeof attachment?.data === "string" ? attachment.data : null;
    if (inlineData !== null) {
      buffer = Buffer.from(inlineData, "base64");
    } else {
      const url = typeof attachment?.url === "string" ? attachment.url : null;
      if (url === null) continue;
      const response = await fetchWithRetry(
        url,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: contentType,
          },
        },
        fetchImpl,
      );
      if (!response.ok) continue;
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const text = extractText(contentType, buffer);
    let storageNote: string | null = null;
    if (text === null) {
      const slug = personSlug(source.orgName + "-" + source.personId);
      const dir = dataDirRoot ? dataDirRoot(slug) : healthDataDir(slug);
      const fileName = storageFileName(documentFhirId, contentType);
      const filePath = `${dir}/${fileName}`;
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, buffer);
      storageNote = filePath;
    }

    await upsertHealthDocument(pool, {
      recordId,
      personId: source.personId,
      contentType,
      byteLength: buffer.byteLength,
      text,
      storageNote,
    });
    return true;
  }
  return false;
}

export type EpicCredentials = { clientId: string; clientSecret: string | null };

/** A stored access token is only used directly (no refresh) when it still
 * has more than this much life left -- matching the task's "expires more
 * than 60 seconds from now". */
const MIN_ACCESS_TOKEN_LIFETIME_MS = 60_000;

async function refreshAndStore(
  source: HealthSourceRow,
  token: StoredToken,
  refreshToken: string,
  fetchImpl: Fetch,
  tokenStore: TokenStore,
  credentials: EpicCredentials,
): Promise<string> {
  // A token stored before `clientAuth` existed was always obtained with
  // HTTP Basic (the exchange's only method at the time).
  const clientAuth: ClientAuthMethod = token.clientAuth ?? "secret";
  const discovery = await discoverSmartConfiguration(source.fhirBase, fetchImpl);
  const refreshed = await refreshAccessToken(
    {
      tokenEndpoint: discovery.tokenEndpoint,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken,
      clientAuth,
    },
    fetchImpl,
  );
  const updated: StoredToken = {
    refreshToken: refreshed.refreshToken ?? refreshToken,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    patientFhirId: token.patientFhirId,
    fhirBase: token.fhirBase,
    orgName: token.orgName,
    clientAuth,
  };
  await tokenStore.set(source.keychainService, JSON.stringify(updated));
  return refreshed.accessToken;
}

export type AccessTokenOutcome = {
  accessToken: string;
  /** See `SourcePullResult.tokenNote`. */
  note: string | null;
};

/**
 * Resolves the access token to pull with: refreshes as before when a
 * refresh token is on file; otherwise, when the stored access token itself
 * still has more than 60 seconds of life left, uses it directly rather than
 * refusing the whole source (Epic's sandbox has been observed to issue an
 * access token with no refresh token at all); otherwise throws
 * `InvalidGrantError` so the caller marks `needs_reauth_at`, same as an
 * `invalid_grant` refresh response.
 *
 * `expiresAt` is always present in `token` (computed from `expires_in` at
 * exchange time by `oauth.ts`'s `toTokenResponse`, for both `authorize` and
 * a prior refresh here) -- a missing or unparseable value is treated as
 * already expired rather than thrown on, so a malformed or pre-`expiresAt`
 * stored token safely falls through to `needs_reauth` instead of crashing
 * the whole pull.
 */
async function resolveAccessToken(
  source: HealthSourceRow,
  token: StoredToken,
  fetchImpl: Fetch,
  tokenStore: TokenStore,
  credentials: EpicCredentials,
): Promise<AccessTokenOutcome> {
  if (token.refreshToken !== null) {
    const accessToken = await refreshAndStore(
      source,
      token,
      token.refreshToken,
      fetchImpl,
      tokenStore,
      credentials,
    );
    return { accessToken, note: null };
  }

  const msRemaining = Date.parse(token.expiresAt) - Date.now();
  if (Number.isFinite(msRemaining) && msRemaining > MIN_ACCESS_TOKEN_LIFETIME_MS) {
    const minutes = Math.floor(msRemaining / 60_000);
    return {
      accessToken: token.accessToken,
      note: `access token only; expires in ${minutes} minutes`,
    };
  }
  throw new InvalidGrantError(
    "No refresh token stored and the access token has expired or is about " +
      "to; authorize again",
  );
}

export async function pullAll(deps: PullDeps = {}): Promise<{
  results: SourcePullResult[];
  anyFailed: boolean;
}> {
  const {
    fetchImpl = fetch,
    tokenStore = keychainTokenStore,
    dataDirRoot,
  } = deps;
  const databaseUrl = await loadDatabaseUrl();
  const pool = openPool(databaseUrl);
  try {
    const sources = await listHealthSources(pool);
    if (sources.length === 0) {
      process.stdout.write("epic pull: no linked sources\n");
      return { results: [], anyFailed: false };
    }
    const results: SourcePullResult[] = [];
    const clientIdByEnv = new Map<EpicEnv, string>();
    // Client secret is looked up per organization, not per environment --
    // Epic issues (and recommends) a distinct client secret, and thus a
    // distinct refresh-token grant, per organization. See
    // `loadClientSecretForOrg`.
    const clientSecretByOrg = new Map<string, string | null>();
    for (const source of sources) {
      const env = fhirEnvOf(source.fhirBase);
      let clientId = clientIdByEnv.get(env);
      if (clientId === undefined) {
        clientId = await loadClientId(env);
        clientIdByEnv.set(env, clientId);
      }
      let clientSecret = clientSecretByOrg.get(source.orgName);
      if (clientSecret === undefined) {
        clientSecret = (await loadClientSecretForOrg(source.orgName)).secret;
        clientSecretByOrg.set(source.orgName, clientSecret);
      }
      const credentials: EpicCredentials = { clientId, clientSecret };
      const result = await pullOneSource(
        pool,
        source,
        fetchImpl,
        tokenStore,
        credentials,
        dataDirRoot,
      );
      results.push(result);
      process.stdout.write(`${summaryLine(source, result)}\n`);
    }
    return {
      results,
      anyFailed: results.some(
        (result) =>
          result.status !== "ok" || Object.keys(result.resourceErrors).length > 0,
      ),
    };
  } finally {
    await pool.end();
  }
}

/** One source's pull end to end, starting from its stored token JSON:
 * refreshes the access token (handling `invalid_grant`), then delegates to
 * `pullSource`. Exported so a test can drive the refresh/reauth decision
 * against a fake pool, without a real database. */
export async function pullOneSource(
  pool: Pool,
  source: HealthSourceRow,
  fetchImpl: Fetch,
  tokenStore: TokenStore,
  credentials: EpicCredentials,
  dataDirRoot?: (personSlugValue: string) => string,
): Promise<SourcePullResult> {
  const raw = await tokenStore.get(source.keychainService);
  if (raw === null) {
    const result = emptyResult(source.orgName);
    result.status = "failed";
    result.error = `Keychain item "${source.keychainService}" not found`;
    await recordPullFailure(pool, source.id, result.error, false);
    return result;
  }
  const token = JSON.parse(raw) as StoredToken;
  let outcome: AccessTokenOutcome;
  try {
    outcome = await resolveAccessToken(source, token, fetchImpl, tokenStore, credentials);
  } catch (error) {
    const result = emptyResult(source.orgName);
    const invalidGrant = error instanceof InvalidGrantError;
    result.status = "needs_reauth";
    result.error = errorMessage(error);
    await recordPullFailure(pool, source.id, result.error, invalidGrant);
    return result;
  }
  const result = await pullSource(pool, source, outcome.accessToken, fetchImpl, dataDirRoot);
  result.tokenNote = outcome.note;
  return result;
}

function summaryLine(source: HealthSourceRow, result: SourcePullResult): string {
  const countParts = Object.entries(result.counts).map(
    ([type, count]) => `${type}=${count}`,
  );
  const parts = [
    `epic pull source=${source.id}`,
    `org="${result.orgName}"`,
    `status=${result.status}`,
    `documents=${result.documents}`,
    ...countParts,
  ];
  if (Object.keys(result.resourceErrors).length > 0) {
    parts.push(`resource_errors=${JSON.stringify(result.resourceErrors)}`);
  }
  if (result.tokenNote !== null) parts.push(`note=${JSON.stringify(result.tokenNote)}`);
  if (result.error !== null) parts.push(`error=${JSON.stringify(result.error)}`);
  return parts.join(" ");
}
