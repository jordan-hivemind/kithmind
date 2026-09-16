"use client";

// The PostgreSQL settings page.
//
// The server component (`app/(authenticated)/settings/page.tsx`) loads the
// first paint -- destination settings, spaces, source accounts, and the first
// API key page -- from one read-only transaction and passes it in as
// `initial`. Every mutation below is a `fetch` to `/api/kith/*`, and every one
// of those routes reloads the session and opens its own transaction, the same
// shape `app/api/auth/*` already uses. This component holds no query of its
// own and imports nothing from Convex.

import { useMemo, useState } from "react";

import {
  type GrantableSpace,
  type KeyCapability,
  SpaceGrantChoices,
} from "@/components/space-grant-choices";
import { sourceAccountGrantsForCapabilities } from "@/lib/api-key-scopes";
import type { SettingsData } from "@/lib/kith/settings-data";

const settingsCapabilities: readonly KeyCapability[] = ["read", "write", "ingest"];

const sourceKinds = { "mcp-client": "MCP client", fs: "Filesystem" } as const;

function sourceKindLabel(connector: string) {
  return sourceKinds[connector as keyof typeof sourceKinds] ?? connector;
}

async function requestJson(
  input: string,
  init: RequestInit,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const response = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (response.status === 204) return { ok: true, body: undefined };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "Request failed.";
    return { ok: false, message };
  }
  return { ok: true, body };
}

type ApiKeyRow = SettingsData["apiKeys"]["page"][number];
type SourceAccountRow = SettingsData["sourceAccounts"][number];

export function KithSettings({ initial }: { initial: SettingsData }) {
  const [spaces] = useState(initial.spaces);
  const [defaultWriteSpaceId, setDefaultWriteSpaceId] = useState(
    initial.settings.defaultWriteSpaceId,
  );
  const [defaultError, setDefaultError] = useState("");
  const [savingDefault, setSavingDefault] = useState(false);

  const [sourceAccounts, setSourceAccounts] = useState(initial.sourceAccounts);
  const [apiKeys, setApiKeys] = useState(initial.apiKeys.page);
  const [cursor, setCursor] = useState(initial.apiKeys.continueCursor);
  const [isDone, setIsDone] = useState(initial.apiKeys.isDone);
  const [loadingMore, setLoadingMore] = useState(false);

  const writableSpaces = useMemo(
    () => spaces.filter((space) => space.role !== "reader"),
    [spaces],
  );
  const grantableSpaces: GrantableSpace[] = spaces.map((space) => ({
    spaceId: space.spaceId,
    name: space.name,
    kind: space.kind,
    role: space.role,
  }));
  const configuredDefaultIsUnavailable =
    defaultWriteSpaceId !== null &&
    !writableSpaces.some((space) => space.spaceId === defaultWriteSpaceId);

  async function handleDefaultChange(value: string) {
    setDefaultError("");
    setSavingDefault(true);
    const result = await requestJson("/api/kith/settings/default-write-space", {
      method: "POST",
      body: JSON.stringify({ spaceId: value || null }),
    });
    if (result.ok) setDefaultWriteSpaceId(value || null);
    else setDefaultError(result.message);
    setSavingDefault(false);
  }

  async function loadMoreKeys() {
    setLoadingMore(true);
    const url = new URL("/api/kith/api-keys", window.location.origin);
    url.searchParams.set("numItems", "25");
    if (cursor) url.searchParams.set("cursor", cursor);
    const result = await requestJson(url.toString(), { method: "GET" });
    if (result.ok) {
      const page = result.body as {
        page: ApiKeyRow[];
        isDone: boolean;
        continueCursor: string | null;
      };
      setApiKeys((existing) => [...existing, ...page.page]);
      setCursor(page.continueCursor);
      setIsDone(page.isDone);
    }
    setLoadingMore(false);
  }

  return (
    <div>
      <h1>Settings</h1>

      <section aria-labelledby="destination-heading">
        <h2 id="destination-heading">Default write destination</h2>
        <p style={{ color: "#666" }}>
          Destination-less writes use this space. No explicit default always
          falls back to your Personal space.
        </p>
        {configuredDefaultIsUnavailable && (
          <div role="alert" style={{ color: "#b45309" }}>
            <p>
              Your configured destination is no longer writable. Reset it
              before creating destination-less content.
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
          value={configuredDefaultIsUnavailable ? "unavailable" : (defaultWriteSpaceId ?? "")}
          onChange={(event) => void handleDefaultChange(event.target.value)}
          disabled={savingDefault}
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

      <SourceAccountsSection
        spaces={writableSpaces}
        sourceAccounts={sourceAccounts}
        onCreated={(account) =>
          setSourceAccounts((existing) => [...existing, account])
        }
        onUpdated={(id, patch) =>
          setSourceAccounts((existing) =>
            existing.map((account) =>
              account.id === id ? { ...account, ...patch } : account,
            ),
          )
        }
      />

      <ApiKeysSection
        grantableSpaces={grantableSpaces}
        sourceAccounts={sourceAccounts}
        apiKeys={apiKeys}
        isDone={isDone}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMoreKeys()}
        onCreated={(key) => setApiKeys((existing) => [key, ...existing])}
        onRevoked={(id) =>
          setApiKeys((existing) => existing.filter((key) => key.id !== id))
        }
      />
    </div>
  );
}

function SourceAccountsSection({
  spaces,
  sourceAccounts,
  onCreated,
  onUpdated,
}: {
  spaces: SettingsData["spaces"];
  sourceAccounts: SourceAccountRow[];
  onCreated: (account: SourceAccountRow) => void;
  onUpdated: (id: string, patch: Partial<SourceAccountRow>) => void;
}) {
  const [sourceName, setSourceName] = useState("");
  const [sourceConnector, setSourceConnector] =
    useState<keyof typeof sourceKinds>("mcp-client");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [sourceFreshnessMinutes, setSourceFreshnessMinutes] = useState("1440");
  const [sourceSpaceId, setSourceSpaceId] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const [editedFreshness, setEditedFreshness] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  async function handleCreateSource(event: React.FormEvent) {
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
    const result = await requestJson("/api/kith/source-accounts", {
      method: "POST",
      body: JSON.stringify({
        spaceId: sourceSpaceId,
        connector: sourceConnector,
        accountId: sourceAccountId.trim(),
        name: sourceName.trim(),
        freshnessMs: freshnessMinutes * 60_000,
      }),
    });
    if (result.ok) {
      const { id } = result.body as { id: string };
      onCreated({
        id,
        spaceId: sourceSpaceId,
        name: sourceName.trim(),
        connector: sourceConnector,
        accountId: sourceAccountId.trim(),
        freshnessMs: freshnessMinutes * 60_000,
        enabled: true,
      });
      setSourceName("");
      setSourceAccountId("");
    } else {
      setSourceError(result.message);
    }
    setSavingSource(false);
  }

  async function toggleEnabled(account: SourceAccountRow) {
    setUpdatingId(account.id);
    const result = await requestJson(`/api/kith/source-accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !account.enabled }),
    });
    if (result.ok) onUpdated(account.id, { enabled: !account.enabled });
    else setSourceError(result.message);
    setUpdatingId(null);
  }

  async function saveEdit(id: string) {
    const freshnessMinutes = Number(editedFreshness);
    if (
      !editedName.trim() ||
      !Number.isSafeInteger(freshnessMinutes) ||
      freshnessMinutes < 1 ||
      freshnessMinutes > 525_600
    ) {
      setSourceError(
        "Enter a source name and freshness between one minute and one year.",
      );
      return;
    }
    setUpdatingId(id);
    const result = await requestJson(`/api/kith/source-accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: editedName.trim(),
        freshnessMs: freshnessMinutes * 60_000,
      }),
    });
    if (result.ok) {
      onUpdated(id, {
        name: editedName.trim(),
        freshnessMs: freshnessMinutes * 60_000,
      });
      setEditingId(null);
    } else {
      setSourceError(result.message);
    }
    setUpdatingId(null);
  }

  return (
    <section aria-labelledby="sources-heading" style={{ marginTop: 32 }}>
      <h2 id="sources-heading">Source accounts</h2>
      <p style={{ color: "#666" }}>
        Add each source account a client may ingest from. This only
        configures its identity and access scope; it does not fetch, poll, or
        scan a source.
      </p>
      <form onSubmit={(event) => void handleCreateSource(event)}>
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
          onChange={(event) => setSourceSpaceId(event.target.value)}
          disabled={spaces.length === 0 || savingSource}
          style={{ display: "block", margin: "6px 0 12px", padding: 8 }}
        >
          <option value="">Choose a writable space</option>
          {spaces.map((space) => (
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
          style={{ display: "block", margin: "6px 0", padding: 8 }}
        />
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
      {sourceAccounts.length === 0 ? (
        <p style={{ color: "#666" }}>No source accounts configured.</p>
      ) : (
        <ul>
          {sourceAccounts.map((account) => (
            <li key={account.id} style={{ marginBottom: 8 }}>
              {editingId === account.id ? (
                <div>
                  <label htmlFor={`source-name-${account.id}`}>Source name</label>
                  <input
                    id={`source-name-${account.id}`}
                    value={editedName}
                    onChange={(event) => setEditedName(event.target.value)}
                  />
                  <label htmlFor={`source-freshness-${account.id}`}>
                    Freshness (minutes)
                  </label>
                  <input
                    id={`source-freshness-${account.id}`}
                    type="number"
                    min={1}
                    max={525_600}
                    step={1}
                    value={editedFreshness}
                    onChange={(event) => setEditedFreshness(event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void saveEdit(account.id)}
                    disabled={updatingId === account.id}
                    style={{ marginLeft: 8 }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={updatingId === account.id}
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
                      setEditingId(account.id);
                      setEditedName(account.name);
                      setEditedFreshness(String(account.freshnessMs / 60_000));
                    }}
                    disabled={updatingId === account.id}
                    style={{ marginLeft: 8 }}
                  >
                    Edit
                  </button>
                  {account.connector === "fs" && (
                    <p style={{ color: "#666", fontSize: 13 }}>
                      Worker heartbeat status is not available on this surface
                      yet.
                    </p>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => void toggleEnabled(account)}
                disabled={updatingId === account.id}
                style={{ marginLeft: 8 }}
              >
                {updatingId === account.id
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
  );
}

function ApiKeysSection({
  grantableSpaces,
  sourceAccounts,
  apiKeys,
  isDone,
  loadingMore,
  onLoadMore,
  onCreated,
  onRevoked,
}: {
  grantableSpaces: GrantableSpace[];
  sourceAccounts: SourceAccountRow[];
  apiKeys: ApiKeyRow[];
  isDone: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onCreated: (key: ApiKeyRow) => void;
  onRevoked: (id: string) => void;
}) {
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<KeyCapability[]>(["read"]);
  const [sourceAccountIds, setSourceAccountIds] = useState<string[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const scopedSourceAccounts = sourceAccounts.filter(
    (account) => spaceIds.includes(account.spaceId) && account.enabled,
  );

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!newKeyName.trim() || !spaceIds.length || !capabilities.length) return;
    if (capabilities.includes("ingest") && !sourceAccountIds.length) {
      setError("Choose at least one source account for an ingest key.");
      return;
    }
    setError("");
    setCreating(true);
    const result = await requestJson("/api/kith/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: newKeyName.trim(),
        spaceIds,
        capabilities,
        sourceAccountIds: sourceAccountGrantsForCapabilities(
          capabilities,
          sourceAccountIds,
        ),
      }),
    });
    if (result.ok) {
      const created = result.body as { id: string; rawKey: string };
      setNewRawKey(created.rawKey);
      setNewKeyName("");
      setSourceAccountIds([]);
      onCreated({
        id: created.id,
        createdAt: Date.now(),
        keyPrefix: created.rawKey.slice(0, 11),
        name: newKeyName.trim(),
        lastUsedAt: null,
        capabilities,
        spaceIds,
        sourceAccountIds,
      });
    } else {
      setError(result.message);
    }
    setCreating(false);
  }

  async function handleRevoke(id: string) {
    setRevokingId(id);
    const result = await requestJson(`/api/kith/api-keys/${id}`, {
      method: "DELETE",
    });
    if (result.ok) onRevoked(id);
    else setError(result.message);
    setRevokingId(null);
  }

  async function handleCopy() {
    if (newRawKey) {
      await navigator.clipboard.writeText(newRawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const showKeyForm = apiKeys.length > 0 || showCreateForm;

  return (
    <section aria-labelledby="keys-heading" style={{ marginTop: 32 }}>
      <h2 id="keys-heading">API Keys</h2>
      <p style={{ color: "#666" }}>
        Clients connect with an API key. Choose spaces and permissions when you
        create one.
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
          <form onSubmit={(event) => void handleCreate(event)} style={{ marginBottom: 24 }}>
            <input
              type="text"
              value={newKeyName}
              onChange={(event) => setNewKeyName(event.target.value)}
              placeholder='Key name (e.g., "Cursor")'
              style={{ flex: 1, padding: 8, borderRadius: 4, border: "1px solid #ddd" }}
            />
            <SpaceGrantChoices
              spaces={grantableSpaces}
              error=""
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
                {scopedSourceAccounts.length === 0 ? (
                  <p role="alert">
                    Add and enable a source account in a selected space before
                    issuing this key.
                  </p>
                ) : (
                  scopedSourceAccounts.map((account) => (
                    <label key={account.id} style={{ display: "block", marginBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={sourceAccountIds.includes(account.id)}
                        onChange={(event) =>
                          setSourceAccountIds((selected) =>
                            event.target.checked
                              ? [...selected, account.id]
                              : selected.filter((id) => id !== account.id),
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
              style={{ padding: "8px 16px", cursor: "pointer", borderRadius: 4 }}
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
              <strong>Save this key now — it won&apos;t be shown again!</strong>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
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
                <button onClick={() => void handleCopy()} style={{ padding: "8px 16px", cursor: "pointer", borderRadius: 4 }}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <button
                onClick={() => setNewRawKey(null)}
                style={{ marginTop: 8, padding: "4px 12px", cursor: "pointer", borderRadius: 4 }}
              >
                Dismiss
              </button>
            </div>
          )}
        </>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
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
          {apiKeys.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ padding: 8, color: "#666" }}>
                No API keys yet.
              </td>
            </tr>
          ) : (
            apiKeys.map((key) => (
              <tr key={key.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>
                  {key.name}
                  <br />
                  <small>
                    {key.capabilities.join(", ")} · {key.spaceIds.length} space(s)
                  </small>
                </td>
                <td style={{ padding: 8 }}>
                  <code>{key.keyPrefix}...</code>
                </td>
                <td style={{ padding: 8, color: "#666" }}>
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}
                </td>
                <td style={{ padding: 8, color: "#666" }}>
                  {new Date(key.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: 8 }}>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(key.id)}
                    disabled={revokingId === key.id}
                    style={{ color: "red", cursor: "pointer", background: "none", border: "none" }}
                  >
                    {revokingId === key.id ? "Revoking..." : "Revoke"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {!isDone && (
        <button type="button" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      )}
    </section>
  );
}
