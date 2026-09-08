"use client";

import { api } from "@repo/db/convex/_generated/api";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import {
  useConvexAuth,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import Link from "next/link";
import { Component, useEffect, useMemo, useState } from "react";

import {
  type KeyCapability,
  SpaceGrantPicker,
} from "@/components/space-grant-picker";
import { WorkerHeartbeatStatus } from "@/components/worker-heartbeat-status";
import { sourceAccountGrantsForCapabilities } from "@/lib/api-key-scopes";

const settingsCapabilities: readonly KeyCapability[] = [
  "read",
  "write",
  "ingest",
];

const sourceKinds = {
  "mcp-client": "MCP client",
  fs: "Filesystem",
} as const;

function sourceKindLabel(connector: string) {
  return sourceKinds[connector as keyof typeof sourceKinds] ?? connector;
}

function errorMessage(caught: unknown, fallback: string) {
  if (!(caught instanceof Error)) return fallback;
  const data = (caught as Error & { data?: unknown }).data;
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }
  return fallback;
}

class ApiKeyListErrorBoundary extends Component<
  { children: React.ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section aria-label="API key list" style={{ marginTop: 24 }}>
          <p role="alert">Could not load API keys.</p>
          <button
            type="button"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onRetry();
            }}
          >
            Retry
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

function ApiKeyList({ onHasKeys }: { onHasKeys: (hasKeys: boolean) => void }) {
  const {
    results: apiKeys,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.models.apiKeys.public.listPage,
    {},
    { initialNumItems: 25 },
  );
  const revokeKey = useMutation(api.models.apiKeys.public.revoke);
  const [error, setError] = useState("");
  const [revokingKeyId, setRevokingKeyId] = useState<Id<"apiKeys"> | null>(
    null,
  );

  useEffect(() => onHasKeys(apiKeys.length > 0), [apiKeys.length, onHasKeys]);

  return (
    <section aria-label="API key list" style={{ marginTop: 24 }}>
      {error && <p role="alert">{error}</p>}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginBottom: 16,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid #eee", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Key</th>
            <th style={{ padding: 8 }}>Last Used</th>
            <th style={{ padding: 8 }}>Created</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {status === "LoadingFirstPage" ? (
            <tr>
              <td colSpan={5} style={{ padding: 8 }}>
                Loading API keys...
              </td>
            </tr>
          ) : apiKeys.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ padding: 8, color: "#666" }}>
                No API keys yet.
              </td>
            </tr>
          ) : (
            apiKeys.map((key) => (
              <tr key={key._id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>
                  {key.name}
                  <br />
                  <small>
                    {key.capabilities.join(", ")} · {key.spaceIds.length}{" "}
                    space(s)
                  </small>
                </td>
                <td style={{ padding: 8 }}>
                  <code>{key.keyPrefix}...</code>
                </td>
                <td style={{ padding: 8, color: "#666" }}>
                  {key.lastUsedAt
                    ? new Date(key.lastUsedAt).toLocaleDateString()
                    : "Never"}
                </td>
                <td style={{ padding: 8, color: "#666" }}>
                  {new Date(key._creationTime).toLocaleDateString()}
                </td>
                <td style={{ padding: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setError("");
                      setRevokingKeyId(key._id);
                      void revokeKey({ id: key._id })
                        .catch((caught: unknown) =>
                          setError(
                            errorMessage(caught, "Could not revoke key."),
                          ),
                        )
                        .finally(() => setRevokingKeyId(null));
                    }}
                    disabled={revokingKeyId === key._id}
                    style={{
                      color: "red",
                      cursor: "pointer",
                      background: "none",
                      border: "none",
                    }}
                  >
                    {revokingKeyId === key._id ? "Revoking..." : "Revoke"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {status === "CanLoadMore" || status === "LoadingMore" ? (
        <button
          type="button"
          onClick={() => loadMore(25)}
          disabled={status === "LoadingMore"}
        >
          {status === "LoadingMore" ? "Loading..." : "Load more"}
        </button>
      ) : null}
    </section>
  );
}

export default function SettingsPage() {
  const { isAuthenticated } = useConvexAuth();
  const ensurePersonal = useMutation(api.models.spaces.public.ensurePersonal);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsSetupError, setSettingsSetupError] = useState("");
  const settings = useQuery(
    api.models.spaces.public.getSettings,
    settingsReady ? {} : "skip",
  );
  const spaces = useQuery(
    api.models.spaces.public.list,
    settingsReady ? {} : "skip",
  );
  const sourceAccounts = useQuery(
    api.models.sourceAccounts.public.list,
    settingsReady ? {} : "skip",
  );
  const setDefaultWriteSpace = useMutation(
    api.models.spaces.public.setDefaultWriteSpace,
  );
  const createSourceAccount = useMutation(
    api.models.sourceAccounts.public.create,
  );
  const updateSourceAccount = useMutation(
    api.models.sourceAccounts.public.update,
  );
  const createKey = useMutation(api.models.apiKeys.public.create);

  const [spaceIds, setSpaceIds] = useState<Id<"spaces">[]>([]);
  const [capabilities, setCapabilities] = useState<KeyCapability[]>(["read"]);
  const [sourceAccountIds, setSourceAccountIds] = useState<
    Id<"sourceAccounts">[]
  >([]);
  const [error, setError] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [defaultError, setDefaultError] = useState("");
  const [savingDefault, setSavingDefault] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const [sourceConnector, setSourceConnector] =
    useState<keyof typeof sourceKinds>("mcp-client");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [sourceFreshnessMinutes, setSourceFreshnessMinutes] = useState("1440");
  const [sourceSpaceId, setSourceSpaceId] = useState<Id<"spaces"> | "">("");
  const [sourceError, setSourceError] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [updatingSourceAccountId, setUpdatingSourceAccountId] =
    useState<Id<"sourceAccounts"> | null>(null);
  const [editingSourceAccountId, setEditingSourceAccountId] =
    useState<Id<"sourceAccounts"> | null>(null);
  const [editedSourceName, setEditedSourceName] = useState("");
  const [editedFreshnessMinutes, setEditedFreshnessMinutes] = useState("");
  const [hasKeys, setHasKeys] = useState(false);
  const [keyListRetry, setKeyListRetry] = useState(0);

  const writableSpaces = useMemo(
    () => spaces?.filter((space) => space.role !== "reader") ?? [],
    [spaces],
  );
  const scopedSourceAccounts = useMemo(
    () =>
      sourceAccounts?.filter((account) => spaceIds.includes(account.spaceId)) ??
      [],
    [sourceAccounts, spaceIds],
  );
  const enabledScopedSourceAccounts = useMemo(
    () => scopedSourceAccounts.filter((account) => account.enabled),
    [scopedSourceAccounts],
  );
  const configuredDefaultIsUnavailable =
    settings?.defaultWriteSpaceId !== undefined &&
    spaces !== undefined &&
    !writableSpaces.some(
      (space) => space.spaceId === settings.defaultWriteSpaceId,
    );

  useEffect(() => {
    if (!isAuthenticated) {
      setSettingsReady(false);
      setSettingsSetupError("");
      return;
    }
    let active = true;
    void ensurePersonal().then(
      () => {
        if (active) setSettingsReady(true);
      },
      () => {
        if (active)
          setSettingsSetupError(
            "Could not load settings. Reload and try again.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [ensurePersonal, isAuthenticated]);

  useEffect(() => {
    setSourceAccountIds((selected) => {
      const remaining = selected.filter((id) =>
        enabledScopedSourceAccounts.some((account) => account._id === id),
      );
      return remaining.length === selected.length ? selected : remaining;
    });
  }, [enabledScopedSourceAccounts]);

  useEffect(() => {
    if (!capabilities.includes("ingest")) setSourceAccountIds([]);
  }, [capabilities]);

  useEffect(() => {
    if (sourceSpaceId || writableSpaces.length !== 1) return;
    setSourceSpaceId(writableSpaces[0]!.spaceId);
  }, [sourceSpaceId, writableSpaces]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim() || !spaceIds.length || !capabilities.length) return;
    if (capabilities.includes("ingest") && !sourceAccountIds.length) {
      setError("Choose at least one source account for an ingest key.");
      return;
    }
    setError("");

    setCreating(true);
    try {
      const result = await createKey({
        name: newKeyName.trim(),
        spaceIds,
        capabilities,
        sourceAccountIds: sourceAccountGrantsForCapabilities(
          capabilities,
          sourceAccountIds,
        ),
      });
      setNewRawKey(result.rawKey);
      setNewKeyName("");
      setSourceAccountIds([]);
    } catch (error) {
      setError(errorMessage(error, "Could not create key."));
    } finally {
      setCreating(false);
    }
  };

  const handleDefaultChange = async (value: string) => {
    setDefaultError("");
    setSavingDefault(true);
    try {
      await setDefaultWriteSpace({
        spaceId: value ? (value as Id<"spaces">) : undefined,
      });
    } catch (caught) {
      setDefaultError(errorMessage(caught, "Could not save destination."));
    } finally {
      setSavingDefault(false);
    }
  };

  const handleCreateSource = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sourceSpaceId || !sourceName.trim() || !sourceAccountId.trim()) return;
    const freshnessMinutes = Number(sourceFreshnessMinutes);
    if (
      !Number.isSafeInteger(freshnessMinutes) ||
      freshnessMinutes < 1 ||
      freshnessMinutes > 525_600
    ) {
      setSourceError("Freshness must be between one minute and one year.");
      return;
    }
    setSourceError("");
    setSavingSource(true);
    try {
      await createSourceAccount({
        spaceId: sourceSpaceId,
        connector: sourceConnector,
        accountId: sourceAccountId.trim(),
        name: sourceName.trim(),
        freshnessMs: freshnessMinutes * 60_000,
      });
      setSourceName("");
      setSourceAccountId("");
    } catch (caught) {
      setSourceError(errorMessage(caught, "Could not add source account."));
    } finally {
      setSavingSource(false);
    }
  };

  const saveSourceDetails = (sourceAccountId: Id<"sourceAccounts">) => {
    const freshnessMinutes = Number(editedFreshnessMinutes);
    if (
      !editedSourceName.trim() ||
      !Number.isSafeInteger(freshnessMinutes) ||
      freshnessMinutes < 1 ||
      freshnessMinutes > 525_600
    ) {
      setSourceError(
        "Enter a source name and freshness between one minute and one year.",
      );
      return;
    }
    setSourceError("");
    setUpdatingSourceAccountId(sourceAccountId);
    void updateSourceAccount({
      sourceAccountId,
      name: editedSourceName.trim(),
      freshnessMs: freshnessMinutes * 60_000,
    })
      .then(
        () => setEditingSourceAccountId(null),
        (caught: unknown) =>
          setSourceError(errorMessage(caught, "Could not update source.")),
      )
      .finally(() => setUpdatingSourceAccountId(null));
  };

  const handleCopy = async () => {
    if (newRawKey) {
      await navigator.clipboard.writeText(newRawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const showKeyForm = hasKeys || showCreateForm;

  return (
    <div>
      <h1>Settings</h1>
      {settingsSetupError && <p role="alert">{settingsSetupError}</p>}

      <section aria-labelledby="destination-heading">
        <h2 id="destination-heading">Default write destination</h2>
        <p style={{ color: "#666" }}>
          Destination-less writes use this space. No explicit default always
          falls back to your Personal space.
        </p>
        {configuredDefaultIsUnavailable && (
          <div role="alert" style={{ color: "#b45309" }}>
            <p>
              Your configured destination is no longer writable. Reset it before
              creating destination-less content.
            </p>
            <button
              type="button"
              onClick={() => void handleDefaultChange("")}
              disabled={savingDefault}
            >
              Reset to Personal
            </button>
          </div>
        )}
        <label htmlFor="default-write-space">Default destination</label>
        <select
          id="default-write-space"
          value={
            configuredDefaultIsUnavailable
              ? "unavailable"
              : (settings?.defaultWriteSpaceId ?? "")
          }
          onChange={(event) => void handleDefaultChange(event.target.value)}
          disabled={
            settings === undefined || spaces === undefined || savingDefault
          }
          style={{ display: "block", marginTop: 6, padding: 8 }}
        >
          {configuredDefaultIsUnavailable && (
            <option value="unavailable" disabled>
              Previous destination unavailable
            </option>
          )}
          <option value="">No explicit default (Personal)</option>
          {writableSpaces.map((space) => (
            <option key={space.spaceId} value={space.spaceId}>
              {space.name} {space.kind === "personal" ? "(Personal)" : ""}
            </option>
          ))}
        </select>
        {defaultError && <p role="alert">{defaultError}</p>}
      </section>

      <section aria-labelledby="sources-heading" style={{ marginTop: 32 }}>
        <h2 id="sources-heading">Source accounts</h2>
        <p style={{ color: "#666" }}>
          Add each source account a client may ingest from. This only configures
          its identity and access scope; it does not fetch, poll, or scan a
          source.
        </p>
        <p style={{ color: "#666" }}>
          Filesystem configuration does not scan files until a worker is
          configured.
        </p>
        <form onSubmit={handleCreateSource}>
          <label htmlFor="source-kind">Source kind</label>
          <select
            id="source-kind"
            value={sourceConnector}
            onChange={(event) =>
              setSourceConnector(event.target.value as keyof typeof sourceKinds)
            }
            disabled={savingSource}
            style={{ display: "block", margin: "6px 0 12px", padding: 8 }}
          >
            {Object.entries(sourceKinds).map(([connector, label]) => (
              <option key={connector} value={connector}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="source-space">Space</label>
          <select
            id="source-space"
            value={sourceSpaceId}
            onChange={(event) =>
              setSourceSpaceId(event.target.value as Id<"spaces">)
            }
            disabled={
              !settingsReady || writableSpaces.length === 0 || savingSource
            }
            style={{ display: "block", margin: "6px 0 12px", padding: 8 }}
          >
            <option value="">Choose a writable space</option>
            {writableSpaces.map((space) => (
              <option key={space.spaceId} value={space.spaceId}>
                {space.name}
              </option>
            ))}
          </select>
          <label htmlFor="source-name">Source name</label>
          <input
            id="source-name"
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value)}
            placeholder="Cursor desktop"
            required
            maxLength={200}
            style={{ display: "block", margin: "6px 0 12px", padding: 8 }}
          />
          <label htmlFor="source-account-id">Source account ID</label>
          <input
            id="source-account-id"
            value={sourceAccountId}
            onChange={(event) => setSourceAccountId(event.target.value)}
            placeholder="desktop-capture"
            required
            maxLength={512}
            aria-describedby="source-account-help"
            style={{ display: "block", margin: "6px 0", padding: 8 }}
          />
          <p id="source-account-help" style={{ color: "#666", fontSize: 13 }}>
            A stable identifier you choose for this source in this space.
          </p>
          <label htmlFor="source-freshness">Freshness (minutes)</label>
          <input
            id="source-freshness"
            type="number"
            min={1}
            max={525_600}
            step={1}
            value={sourceFreshnessMinutes}
            onChange={(event) => setSourceFreshnessMinutes(event.target.value)}
            required
            style={{ display: "block", margin: "6px 0 12px", padding: 8 }}
          />
          {sourceError && <p role="alert">{sourceError}</p>}
          <button
            type="submit"
            disabled={
              savingSource ||
              !sourceSpaceId ||
              !sourceName.trim() ||
              !sourceAccountId.trim()
            }
          >
            {savingSource ? "Adding..." : "Add source account"}
          </button>
        </form>
        {sourceAccounts === undefined ? (
          <p>Loading sources...</p>
        ) : sourceAccounts.length === 0 ? (
          <p style={{ color: "#666" }}>No source accounts configured.</p>
        ) : (
          <ul>
            {sourceAccounts.map((account) => (
              <li key={account._id} style={{ marginBottom: 8 }}>
                {editingSourceAccountId === account._id ? (
                  <div>
                    <label htmlFor={`source-name-${account._id}`}>
                      Source name
                    </label>
                    <input
                      id={`source-name-${account._id}`}
                      value={editedSourceName}
                      onChange={(event) =>
                        setEditedSourceName(event.target.value)
                      }
                    />
                    <label htmlFor={`source-freshness-${account._id}`}>
                      Freshness (minutes)
                    </label>
                    <input
                      id={`source-freshness-${account._id}`}
                      type="number"
                      min={1}
                      max={525_600}
                      step={1}
                      value={editedFreshnessMinutes}
                      onChange={(event) =>
                        setEditedFreshnessMinutes(event.target.value)
                      }
                    />
                    <button
                      type="button"
                      onClick={() => saveSourceDetails(account._id)}
                      disabled={updatingSourceAccountId === account._id}
                      style={{ marginLeft: 8 }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSourceAccountId(null)}
                      disabled={updatingSourceAccountId === account._id}
                      style={{ marginLeft: 8 }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <strong>{account.name}</strong> (
                    {sourceKindLabel(account.connector)}){" · account ID: "}
                    <code>{account.accountId}</code>
                    {" · refreshes at most every "}
                    {account.freshnessMs / 60_000} minute(s)
                    {" · "}
                    {account.enabled ? "enabled" : "disabled"}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSourceAccountId(account._id);
                        setEditedSourceName(account.name);
                        setEditedFreshnessMinutes(
                          String(account.freshnessMs / 60_000),
                        );
                      }}
                      disabled={updatingSourceAccountId === account._id}
                      style={{ marginLeft: 8 }}
                    >
                      Edit
                    </button>
                    {account.connector === "fs" && (
                      <details style={{ marginTop: 8 }}>
                        <summary>Worker identifiers</summary>
                        <dl style={{ margin: "8px 0 0" }}>
                          <dt>Source row ID</dt>
                          <dd style={{ margin: "2px 0 8px" }}>
                            <code>{account._id}</code>
                          </dd>
                          <dt>Space ID</dt>
                          <dd style={{ margin: "2px 0" }}>
                            <code>{account.spaceId}</code>
                          </dd>
                        </dl>
                        <WorkerHeartbeatStatus sourceAccountId={account._id} />
                      </details>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSourceError("");
                    setUpdatingSourceAccountId(account._id);
                    void updateSourceAccount({
                      sourceAccountId: account._id,
                      enabled: !account.enabled,
                    })
                      .then(
                        () => undefined,
                        (caught: unknown) =>
                          setSourceError(
                            errorMessage(caught, "Could not update source."),
                          ),
                      )
                      .finally(() => setUpdatingSourceAccountId(null));
                  }}
                  disabled={updatingSourceAccountId === account._id}
                  style={{ marginLeft: 8 }}
                >
                  {updatingSourceAccountId === account._id
                    ? "Saving..."
                    : account.enabled
                      ? "Disable"
                      : "Enable"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="keys-heading" style={{ marginTop: 32 }}>
        <h2 id="keys-heading">API Keys</h2>
        <p style={{ color: "#666" }}>
          Clients can connect through OAuth or an API key. Both methods let you
          choose spaces and permissions; OAuth creates a revocable client
          credential. See the{" "}
          <Link href="/getting-started" style={{ color: "#111" }}>
            Getting Started
          </Link>{" "}
          guide for setup instructions.
        </p>

        {!showKeyForm && (
          <button
            onClick={() => setShowCreateForm(true)}
            style={{
              padding: "8px 16px",
              cursor: "pointer",
              borderRadius: 4,
              border: "1px solid #ddd",
              background: "white",
              marginBottom: 24,
            }}
          >
            Generate API Key
          </button>
        )}

        {showKeyForm && (
          <>
            <form onSubmit={handleCreate} style={{ marginBottom: 24 }}>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder='Key name (e.g., "Cursor")'
                style={{
                  flex: 1,
                  padding: 8,
                  borderRadius: 4,
                  border: "1px solid #ddd",
                }}
              />
              <SpaceGrantPicker
                spaceIds={spaceIds}
                onSpaceIdsChange={setSpaceIds}
                capabilities={capabilities}
                onCapabilitiesChange={setCapabilities}
                allowedCapabilities={settingsCapabilities}
              />
              {capabilities.includes("ingest") && (
                <fieldset
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    padding: 12,
                    margin: "12px 0",
                  }}
                >
                  <legend>Ingest source accounts</legend>
                  <p style={{ marginTop: 0 }}>
                    An ingest key can use only the selected enabled source
                    accounts in its granted spaces.
                  </p>
                  {enabledScopedSourceAccounts.length === 0 ? (
                    <p role="alert">
                      Add and enable a source account in a selected space before
                      issuing this key.
                    </p>
                  ) : (
                    enabledScopedSourceAccounts.map((account) => (
                      <label
                        key={account._id}
                        style={{ display: "block", marginBottom: 8 }}
                      >
                        <input
                          type="checkbox"
                          checked={sourceAccountIds.includes(account._id)}
                          onChange={(event) =>
                            setSourceAccountIds((selected) =>
                              event.target.checked
                                ? [...selected, account._id]
                                : selected.filter((id) => id !== account._id),
                            )
                          }
                        />{" "}
                        {account.name} ({sourceKindLabel(account.connector)})
                      </label>
                    ))
                  )}
                </fieldset>
              )}
              {error && <p role="alert">{error}</p>}
              <button
                type="submit"
                disabled={
                  creating ||
                  !newKeyName.trim() ||
                  !spaceIds.length ||
                  !capabilities.length ||
                  (capabilities.includes("ingest") && !sourceAccountIds.length)
                }
                style={{
                  padding: "8px 16px",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                {creating ? "Creating..." : "Generate Key"}
              </button>
            </form>

            {newRawKey && (
              <div
                style={{
                  padding: 16,
                  marginBottom: 24,
                  backgroundColor: "#fff3cd",
                  border: "1px solid #ffc107",
                  borderRadius: 8,
                }}
              >
                <strong>
                  Save this key now — it won&apos;t be shown again!
                </strong>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  <code
                    style={{
                      flex: 1,
                      padding: 8,
                      backgroundColor: "#f5f5f5",
                      borderRadius: 4,
                      fontSize: 13,
                      wordBreak: "break-all",
                    }}
                  >
                    {newRawKey}
                  </code>
                  <button
                    onClick={handleCopy}
                    style={{
                      padding: "8px 16px",
                      cursor: "pointer",
                      borderRadius: 4,
                    }}
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <button
                  onClick={() => setNewRawKey(null)}
                  style={{
                    marginTop: 8,
                    padding: "4px 12px",
                    cursor: "pointer",
                    borderRadius: 4,
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </>
        )}
        <ApiKeyListErrorBoundary
          key={keyListRetry}
          onRetry={() => setKeyListRetry((attempt) => attempt + 1)}
        >
          <ApiKeyList onHasKeys={setHasKeys} />
        </ApiKeyListErrorBoundary>
      </section>
    </div>
  );
}
