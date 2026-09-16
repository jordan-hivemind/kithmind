"use client";

// The Convex-backed consent picker. Unchanged behavior; i7 deletes it.
//
// It now renders `SpaceGrantChoices` instead of owning the markup, because the
// PostgreSQL authorize page shows the same choices from `identity.listSpaces`
// and the two must not drift. What stays here is exactly the part that is
// Convex: the auth gate, the `ensurePersonal` mutation and the `list` query.
//
// The settings page is the other caller and still runs on Convex until i5, which
// is why this component keeps its signature rather than being folded into the
// page that no longer needs it.

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";

import {
  type KeyCapability,
  SpaceGrantChoices,
} from "@/components/space-grant-choices";

export type { KeyCapability };

const defaultCapabilities: readonly KeyCapability[] = ["read", "write"];

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

  // The ids are Convex ids on the way in and out; the choices component only
  // ever sees strings, which is what the PostgreSQL surface hands it.
  const setSpaceIds = useCallback(
    (ids: string[]) => onSpaceIdsChange(ids as Id<"spaces">[]),
    [onSpaceIdsChange],
  );

  return (
    <SpaceGrantChoices
      spaces={spaces ?? null}
      error={error}
      spaceIds={spaceIds}
      onSpaceIdsChange={setSpaceIds}
      capabilities={capabilities}
      onCapabilitiesChange={onCapabilitiesChange}
      allowedCapabilities={allowedCapabilities}
    />
  );
}
