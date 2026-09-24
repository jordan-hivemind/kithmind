// Production health-system lookup against Epic's public R4 endpoint
// directory (`https://open.epic.com/Endpoints/R4`), fetched fresh at
// authorize time rather than vendored -- the task is explicit that this list
// is not to be copied into the repository, since Epic adds and retires
// health systems on its own schedule.

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
