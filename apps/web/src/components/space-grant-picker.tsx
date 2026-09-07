"use client";

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

export type KeyCapability = "read" | "write" | "ingest";

const defaultCapabilities: readonly KeyCapability[] = ["read", "write"];

const capabilityCopy: Record<KeyCapability, string> = {
  read: "Read records",
  write: "Create and change records where your role permits",
  ingest: "Admit content from the selected source accounts",
};

export function SpaceGrantPicker({
  spaceIds,
  onSpaceIdsChange,
  capabilities,
  onCapabilitiesChange,
  allowedCapabilities = defaultCapabilities,
}: {
  spaceIds: Id<"spaces">[];
  onSpaceIdsChange: (ids: Id<"spaces">[]) => void;
  capabilities: KeyCapability[];
  onCapabilitiesChange: (values: KeyCapability[]) => void;
  /** OAuth callers use the read/write default. Settings may also grant ingest. */
  allowedCapabilities?: readonly KeyCapability[];
}) {
  const { isAuthenticated } = useConvexAuth();
  const ensurePersonal = useMutation(api.models.spaces.public.ensurePersonal);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const spaces = useQuery(
    api.models.spaces.public.list,
    ready && isAuthenticated ? {} : "skip",
  );

  useEffect(() => {
    if (!isAuthenticated) {
      setReady(false);
      setError("");
      onSpaceIdsChange([]);
      return;
    }
    let active = true;
    void ensurePersonal().then(
      () => {
        if (active) setReady(true);
      },
      () => {
        if (active) setError("Could not load spaces. Reload and try again.");
      },
    );
    return () => {
      active = false;
    };
  }, [isAuthenticated, ensurePersonal, onSpaceIdsChange]);

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
    if (permitted.length !== capabilities.length) onCapabilitiesChange(permitted);
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
        <label
          key={space.spaceId}
          style={{ display: "block", marginBottom: 8 }}
        >
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
