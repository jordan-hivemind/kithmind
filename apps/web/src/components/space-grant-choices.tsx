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
    <fieldset
      style={{
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: 12,
        margin: "12px 0",
      }}
    >
      <legend>Client access</legend>
      <p style={{ marginTop: 0 }}>
        Choose the spaces and operations this client may use.
      </p>
      {error && <p role="alert">{error}</p>}
      {!spaces && !error && <p>Loading spaces...</p>}
      {spaces?.map((space) => (
        <label key={space.spaceId} style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={spaceIds.includes(space.spaceId)}
            onChange={(event) =>
              onSpaceIdsChange(
                event.target.checked
                  ? [...spaceIds, space.spaceId]
                  : spaceIds.filter((id) => id !== space.spaceId),
              )
            }
          />{" "}
          {space.name} ({space.kind === "personal" ? "Personal" : space.role})
          {space.role === "reader" && " · read only"}
        </label>
      ))}
      {allowedCapabilities.map((capability) => (
        <label key={capability} style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={capabilities.includes(capability)}
            onChange={(event) =>
              onCapabilitiesChange(
                event.target.checked
                  ? [...capabilities, capability]
                  : capabilities.filter((value) => value !== capability),
              )
            }
          />{" "}
          {capabilityCopy[capability]}
        </label>
      ))}
      <p style={{ color: "#666", fontSize: 13, marginBottom: 0 }}>
        Access follows your current membership. Removing access to a space also
        removes this client’s access. Narrative memory capture needs both read
        and write access to check existing memories.
      </p>
    </fieldset>
  );
}
