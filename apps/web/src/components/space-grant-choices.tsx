"use client";

// What the consent screen shows: the spaces and the operations, and nothing that
// knows where either came from.
//
// The Convex picker and the PostgreSQL authorize page render the same choices
// from two different sources -- `spaces.mcpQueries.list` through a hook, and
// `identity.listSpaces` through a server component -- so the markup, the
// pruning rules and the copy live here, once. A consent screen that differs
// between the two surfaces is a consent screen the user cannot be shown the same
// way twice, and the whole point of the dark deploy is that they match.
//
// This component fetches nothing and imports nothing from Convex. The space list
// arrives as a prop, already authorized by whoever loaded it.

import { useEffect } from "react";

export type KeyCapability = "read" | "write" | "ingest";

/** One space the caller may grant. The shape both sources already return. */
export type GrantableSpace = {
  spaceId: string;
  name: string;
  kind: "personal" | "shared";
  role: string;
};

const capabilityCopy: Record<KeyCapability, string> = {
  read: "Read records",
  write: "Create and change records where your role permits",
  ingest: "Admit content from the selected source accounts",
};

export function SpaceGrantChoices({
  spaces,
  error,
  spaceIds,
  onSpaceIdsChange,
  capabilities,
  onCapabilitiesChange,
  allowedCapabilities,
}: {
  /** `null` while the list is still loading. */
  spaces: readonly GrantableSpace[] | null;
  error: string;
  spaceIds: readonly string[];
  onSpaceIdsChange: (ids: string[]) => void;
  capabilities: readonly KeyCapability[];
  onCapabilitiesChange: (values: KeyCapability[]) => void;
  allowedCapabilities: readonly KeyCapability[];
}) {
  // A space that is no longer listed is a space the user has lost access to
  // between opening this screen and now. Dropping it here keeps the request
  // narrow; the server refuses it either way.
  useEffect(() => {
    if (!spaces) return;
    const available = new Set(spaces.map((space) => space.spaceId));
    const remaining = spaceIds.filter((id) => available.has(id));
    if (remaining.length !== spaceIds.length) onSpaceIdsChange(remaining);
  }, [spaces, spaceIds, onSpaceIdsChange]);

  useEffect(() => {
    const permitted = capabilities.filter((capability) =>
      allowedCapabilities.includes(capability),
    );
    if (permitted.length !== capabilities.length) {
      onCapabilitiesChange(permitted);
    }
  }, [allowedCapabilities, capabilities, onCapabilitiesChange]);

  return (
    <fieldset className="my-3 rounded-tag border border-gray-200 p-3 text-xs">
      <legend className="px-1 text-sm font-medium text-gray-600">
        Client access
      </legend>
      <p className="mb-2 text-gray-700">
        Choose the spaces and operations this client may use.
      </p>
      {error && (
        <p role="alert" className="mb-2 text-red-700">
          {error}
        </p>
      )}
      {!spaces && !error && <p className="text-gray-600">Loading spaces...</p>}
      <div className="flex flex-col gap-1.5">
        {spaces?.map((space) => (
          <label key={space.spaceId} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-accent-600"
              checked={spaceIds.includes(space.spaceId)}
              onChange={(event) =>
                onSpaceIdsChange(
                  event.target.checked
                    ? [...spaceIds, space.spaceId]
                    : spaceIds.filter((id) => id !== space.spaceId),
                )
              }
            />
            <span>
              {space.name} (
              {space.kind === "personal" ? "Personal" : space.role})
              {space.role === "reader" && " · read only"}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-1.5 border-t border-gray-100 pt-3">
        {allowedCapabilities.map((capability) => (
          <label key={capability} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-accent-600"
              checked={capabilities.includes(capability)}
              onChange={(event) =>
                onCapabilitiesChange(
                  event.target.checked
                    ? [...capabilities, capability]
                    : capabilities.filter((value) => value !== capability),
                )
              }
            />
            <span>{capabilityCopy[capability]}</span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-sm text-gray-600">
        Access follows your current membership. Removing access to a space also
        removes this client’s access. Narrative memory capture needs both read
        and write access to check existing memories.
      </p>
    </fieldset>
  );
}
