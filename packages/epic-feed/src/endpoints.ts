// Production health-system lookup against Epic's public R4 endpoint
// directory (`https://open.epic.com/Endpoints/R4`), fetched fresh at
// authorize time rather than vendored -- the task is explicit that this list
// is not to be copied into the repository, since Epic adds and retires
// health systems on its own schedule.

import { SANDBOX_FHIR_BASE, type EpicEnv } from "./config.js";
import type { Fetch } from "./oauth.js";

export type EndpointMatch = {
  orgName: string;
  fhirBase: string;
};

type EndpointEntry = {
  resource?: {
    resourceType?: string;
    name?: string;
    address?: string;
    // Epic's directory nests the organization's display name under
    // `managingOrganization` in some listings and as a top-level `name`
    // (the endpoint's own name, often the org name) in others; both are
    // matched.
  };
};

/**
 * Fetches Epic's public R4 endpoint directory and returns every entry whose
 * name contains `query` (case-insensitive). Empty when the directory has no
 * match; the caller decides what to do with zero, one, or several results.
 */
export async function findEndpointsByName(
  query: string,
  fetchImpl: Fetch = fetch,
  directoryUrl = "https://open.epic.com/Endpoints/R4",
): Promise<EndpointMatch[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const response = await fetchImpl(directoryUrl, {
    headers: { accept: "application/fhir+json" },
  });
  if (!response.ok) {
    throw new Error(
      `Epic endpoint directory lookup failed (${response.status})`,
    );
  }
  const bundle = (await response.json()) as { entry?: EndpointEntry[] };
  const needle = trimmed.toLowerCase();
  const matches: EndpointMatch[] = [];
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource || resource.resourceType !== "Endpoint") continue;
    const name = resource.name;
    const address = resource.address;
    if (!name || !address) continue;
    if (name.toLowerCase().includes(needle)) {
      matches.push({ orgName: name, fhirBase: address });
    }
  }
  return matches;
}

/**
 * Resolves an `--org` selector to one organization's FHIR base, the same
 * way for `authorize` and `check`: in sandbox, `org` is optional and
 * defaults to Epic's own public sandbox FHIR base (`SANDBOX_FHIR_BASE`); in
 * production, `org` is required and looked up by name against Epic's public
 * R4 endpoint directory, throwing when it matches zero or more than one
 * health system (in which case the matches are listed so the caller can be
 * more specific).
 */
export async function resolveOrgForEnv(
  env: EpicEnv,
  org: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<EndpointMatch> {
  if (env === "sandbox") {
    return { orgName: org ?? "Epic Sandbox", fhirBase: SANDBOX_FHIR_BASE };
  }
  if (org === undefined || org.trim() === "") {
    throw new Error('--org "<health system name>" is required in production');
  }
  const matches = await findEndpointsByName(org, fetchImpl);
  if (matches.length === 0) {
    throw new Error(`No health system in Epic's endpoint directory matches "${org}"`);
  }
  if (matches.length > 1) {
    const names = matches
      .slice(0, 20)
      .map((match) => `  - ${match.orgName}`)
      .join("\n");
    throw new Error(
      `"${org}" matches more than one health system; use a more specific name:\n${names}`,
    );
  }
  return matches[0]!;
}
