"use client";

// The settings page: default write destination, API keys, source accounts,
// and the Connect list that replaced the getting-started page.
//
// `app/(authenticated)/settings/page.tsx` loads the first paint in one
// read-only transaction. Every mutation is a `fetch` to the same
// `/api/kith/*` route as before, each of which reloads the session and
// authorizes for itself; what changed is only that the table shows the result
// at once and rolls back with a toast if the route refuses
// (`useOptimisticMutation`), then resyncs from the server render.
//
// API keys are not in the change feed (migration 024 says why), so a key made
// on another device shows up on the next visit rather than live.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { WorkerHeartbeatStatus } from "@/components/kith-worker-heartbeat-status";
import {
  type GrantableSpace,
  type KeyCapability,
  type SensitivityChoice,
  SensitivityControl,
  SpaceGrantChoices,
} from "@/components/space-grant-choices";
import {
  Button,
  buttonClass,
  ErrorText,
  Field,
  inputClass,
  PageHeader,
  Panel,
  Section,
} from "@/components/ui/controls";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DataTable,
  Detail,
  type RowAction,
  Tag,
} from "@/components/ui/data-table";
import { useToast } from "@/components/ui/toast";
import { sourceAccountGrantsForCapabilities } from "@/lib/api-key-scopes";
import { AI_CONNECTION_HELP, mcpEndpoint } from "@/lib/kith/connect-guide";
import { shortDate, tableInteger } from "@/lib/kith/format";
import {
  isPendingId,
  mutateJson,
  pendingId,
  requestJson,
} from "@/lib/kith/optimistic";
import type { SettingsData } from "@/lib/kith/settings-data";
import {
  useOptimisticMutation,
  useServerData,
} from "@/lib/kith/use-server-data";

const KEY = ["settings"] as const;
const LIVE_TABLES = ["source_accounts"] as const;

const settingsCapabilities: readonly KeyCapability[] = [
  "read",
  "write",
  "ingest",
];

const sourceKinds = { "mcp-client": "MCP client", fs: "Filesystem" } as const;

function sourceKindLabel(connector: string) {
  return sourceKinds[connector as keyof typeof sourceKinds] ?? connector;
}

const MAX_FRESHNESS_MINUTES = 525_600;

function validFreshness(minutes: number): boolean {
  return (
    Number.isSafeInteger(minutes) &&
    minutes >= 1 &&
    minutes <= MAX_FRESHNESS_MINUTES
  );
}

type ApiKeyRow = SettingsData["apiKeys"]["page"][number];
type SourceAccountRow = SettingsData["sourceAccounts"][number];
/** A source account with the derived columns chips and search read by name. */
type SourceView = SourceAccountRow & {
  kind: string;
  status: "enabled" | "disabled";
};

export function KithSettings({ initial }: { initial: SettingsData }) {
  const data = useServerData<SettingsData>(KEY, initial, LIVE_TABLES);

  const writableSpaces = useMemo(
    () => data.spaces.filter((space) => space.role !== "reader"),
    [data.spaces],
  );

  return (
    <div>
      <PageHeader title="Settings" />
      <AccountSection
        enabled={data.googleAuth.enabled}
        linked={data.googleAuth.linked}
      />
      <DestinationSection data={data} writableSpaces={writableSpaces} />
      <ConnectionsSection />
      <ApiKeysSection data={data} />
      <ConnectSection />
      <SharingSection />
      <OperationsSection />
    </div>
  );
}

function AccountSection({
  enabled,
  linked,
}: {
  enabled: boolean;
  linked: boolean;
}) {
  return (
    <Section id="account" title="Account">
      {enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-kith-text">Google sign-in</p>
            <p className="mt-1 text-xs text-kith-text-muted">
              {linked
                ? "Google sign-in is connected to this Kith account."
                : "Connect a Google account after signing in with your password."}
            </p>
          </div>
          {!linked && (
            <a href="/api/auth/google?action=link" className={buttonClass()}>
              Connect Google
            </a>
          )}
        </div>
      ) : (
        <p className="text-sm text-kith-text-secondary">Password sign-in</p>
      )}
    </Section>
  );
}

function SettingsLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-sm font-medium text-accent-700 hover:text-accent-800"
    >
      {label}
    </Link>
  );
}

function ConnectionsSection() {
  return (
    <Section id="connections" title="Connections & Sources">
      <SettingsLink href="/admin/sources" label="Data Sources" />
    </Section>
  );
}

function SharingSection() {
  return (
    <Section id="sharing" title="Sharing & Access">
      <SettingsLink href="/spaces" label="Spaces" />
    </Section>
  );
}

function OperationsSection() {
  return (
    <Section id="operations" title="System & Operations">
      <div className="flex flex-wrap gap-4">
        <SettingsLink href="/admin/attention" label="Needs Attention" />
        <SettingsLink href="/admin/health" label="System Health" />
      </div>
    </Section>
  );
}

function DestinationSection({
  data,
  writableSpaces,
}: {
  data: SettingsData;
  writableSpaces: SettingsData["spaces"];
}) {
  const defaultWriteSpaceId = data.settings.defaultWriteSpaceId;
  const unavailable =
    defaultWriteSpaceId !== null &&
    !writableSpaces.some((space) => space.spaceId === defaultWriteSpaceId);

  const change = useOptimisticMutation<SettingsData, string | null>({
    queryKey: KEY,
    mutationFn: (spaceId) =>
      mutateJson("/api/kith/settings/default-write-space", {
        method: "POST",
        body: JSON.stringify({ spaceId }),
      }),
    apply: (current, spaceId) => ({
      ...current,
      settings: { ...current.settings, defaultWriteSpaceId: spaceId },
    }),
  });
  // A revoked default still needs an explicit reset before captures can resume.
  if (writableSpaces.length <= 1 && !unavailable) return null;

  return (
    <Section id="destination" title="Where new items are saved">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Destination" htmlFor="default-write-space">
          <select
            id="default-write-space"
            value={unavailable ? "unavailable" : (defaultWriteSpaceId ?? "")}
            onChange={(event) => change.mutate(event.target.value || null)}
            className={`${inputClass} min-w-64`}
          >
            {unavailable && (
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
        </Field>
        <p className="text-xs text-kith-text-muted">
          New captures use this space unless another is selected.
        </p>
        {unavailable && (
          <div role="alert" className="flex items-center gap-2">
            <Tag tone="warn">no longer writable</Tag>
            <Button onClick={() => change.mutate(null)}>
              Reset to Personal
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

type NewKey = {
  row: ApiKeyRow;
  body: {
    name: string;
    spaceIds: string[];
    capabilities: KeyCapability[];
    sourceAccountIds: string[];
    maxSensitivity: SensitivityChoice;
  };
};

function ApiKeysSection({ data }: { data: SettingsData }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const spaceNames = useMemo(
    () => new Map(data.spaces.map((space) => [space.spaceId, space.name])),
    [data.spaces],
  );

  const create = useOptimisticMutation<SettingsData, NewKey>({
    queryKey: KEY,
    mutationFn: ({ body }) =>
      mutateJson("/api/kith/api-keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    apply: (current, { row }) => ({
      ...current,
      apiKeys: { ...current.apiKeys, page: [row, ...current.apiKeys.page] },
    }),
    onSuccess: (result) => setNewRawKey((result as { rawKey: string }).rawKey),
  });

  const revoke = useOptimisticMutation<SettingsData, string>({
    queryKey: KEY,
    mutationFn: (id) =>
      mutateJson(`/api/kith/api-keys/${id}`, { method: "DELETE" }),
    apply: (current, id) => ({
      ...current,
      apiKeys: {
        ...current.apiKeys,
        page: current.apiKeys.page.filter((key) => key.id !== id),
      },
    }),
  });

  // SENS-1. Narrowing a key that already exists, without deleting it and
  // re-authorizing every client that uses it.
  const setCeiling = useOptimisticMutation<
    SettingsData,
    { id: string; maxSensitivity: SensitivityChoice }
  >({
    queryKey: KEY,
    mutationFn: ({ id, maxSensitivity }) =>
      mutateJson(`/api/kith/api-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ maxSensitivity }),
      }),
    apply: (current, { id, maxSensitivity }) => ({
      ...current,
      apiKeys: {
        ...current.apiKeys,
        page: current.apiKeys.page.map((key) =>
          key.id === id ? { ...key, maxSensitivity } : key,
        ),
      },
    }),
  });
  const [editing, setEditing] = useState<ApiKeyRow | null>(null);

  // ponytail: a resync from the server render collapses loaded pages back to
  // the first 25 keys. Keep extra pages across resyncs if anyone has more.
  async function loadMore() {
    setLoadingMore(true);
    const url = new URL("/api/kith/api-keys", window.location.origin);
    url.searchParams.set("numItems", "25");
    if (data.apiKeys.continueCursor) {
      url.searchParams.set("cursor", data.apiKeys.continueCursor);
    }
    const result = await requestJson(url.toString(), { method: "GET" });
    if (result.ok) {
      const next = result.body as SettingsData["apiKeys"];
      queryClient.setQueryData<SettingsData>(KEY, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              apiKeys: {
                page: [...current.apiKeys.page, ...next.page],
                isDone: next.isDone,
                continueCursor: next.continueCursor,
              },
            },
      );
    } else {
      toast(result.message);
    }
    setLoadingMore(false);
  }

  const columns = useMemo<ColumnDef<ApiKeyRow, unknown>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "Purpose" },
      {
        id: "keyPrefix",
        accessorKey: "keyPrefix",
        header: "Key prefix",
        cell: ({ row }) => (
          <code className="font-mono text-data text-gray-700">
            {isPendingId(row.original.id)
              ? "creating"
              : `${row.original.keyPrefix}...`}
          </code>
        ),
      },
      {
        id: "capabilities",
        accessorFn: (row) => row.capabilities.join(" "),
        header: "Access",
        cell: ({ row }) => (
          <span className="flex gap-1">
            {row.original.capabilities.map((capability) => (
              <Tag key={capability}>{capability}</Tag>
            ))}
          </span>
        ),
      },
      {
        id: "spaces",
        accessorFn: (row) => row.spaceIds.length,
        header: "Data access",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <Detail
            label={
              <span className="tabular-nums">
                {tableInteger(row.original.spaceIds.length)}
              </span>
            }
            detail={row.original.spaceIds
              .map((id) => spaceNames.get(id) ?? id)
              .join(", ")}
          />
        ),
      },
      {
        id: "status",
        accessorFn: (row) =>
          row.lastUsedAt === null ? "Never used" : "Active",
        header: "Status",
        cell: ({ row }) => (
          <Tag tone={row.original.lastUsedAt === null ? "neutral" : "accent"}>
            {row.original.lastUsedAt === null ? "Never used" : "Active"}
          </Tag>
        ),
      },
      {
        id: "lastUsedAt",
        accessorKey: "lastUsedAt",
        header: "Last used",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {row.original.lastUsedAt
              ? shortDate(row.original.lastUsedAt)
              : "never"}
          </span>
        ),
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: "Created",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <span className="text-gray-600 tabular-nums">
            {shortDate(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [spaceNames],
  );

  const actions = useMemo<RowAction<ApiKeyRow>[]>(
    () => [
      {
        label: "Copy ID",
        onSelect: (key) => void navigator.clipboard.writeText(key.id),
        disabled: (key) => isPendingId(key.id),
      },
      {
        label: "Edit",
        onSelect: (key) => setEditing(key),
        disabled: (key) => isPendingId(key.id),
      },
      {
        label: "Revoke",
        danger: true,
        onSelect: (key) => setRevokeTarget(key),
        disabled: (key) => isPendingId(key.id),
      },
    ],
    [],
  );

  return (
    <Section
      id="api-keys"
      title="AI Access"
      actions={
        <Button variant="primary" onClick={() => setCreating((open) => !open)}>
          {creating ? "Close" : "New key"}
        </Button>
      }
    >
      {creating && (
        <NewKeyForm
          spaces={data.spaces}
          sourceAccounts={data.sourceAccounts}
          onSubmit={(key) => {
            setNewRawKey(null);
            create.mutate(key);
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <Panel>
          <Field label="Access level" htmlFor="api-key-ceiling">
            <SensitivityControl
              value={editing.maxSensitivity}
              onChange={(value) => {
                setCeiling.mutate({ id: editing.id, maxSensitivity: value });
                setEditing(null);
              }}
            />
          </Field>
        </Panel>
      )}
      {newRawKey && (
        <Panel tone="accent">
          <div className="mb-2 text-xs font-medium text-gray-900">
            Save this key now. It won&apos;t be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-tag border border-accent-200 bg-white px-2 py-1 font-mono text-data break-all">
              {newRawKey}
            </code>
            <CopyButton text={newRawKey} />
            <Button onClick={() => setNewRawKey(null)}>Dismiss</Button>
          </div>
        </Panel>
      )}
      <DataTable
        id="settings-api-keys"
        data={data.apiKeys.page}
        columns={columns}
        actions={actions}
        filterColumns={[]}
        initialSorting={[{ id: "createdAt", desc: true }]}
        searchPlaceholder="Search keys"
        empty="No API keys"
      />
      {!data.apiKeys.isDone && (
        <Button
          className="mt-2"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </Button>
      )}
      <AlertDialog.Root
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              Revoke this API key?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              Clients using this key will immediately stop working.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass()}>
                Cancel
              </AlertDialog.Cancel>
              <AlertDialog.Action
                className={buttonClass("primary")}
                onClick={() => {
                  if (revokeTarget) revoke.mutate(revokeTarget.id);
                  setRevokeTarget(null);
                }}
              >
                Revoke key
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Section>
  );
}

function NewKeyForm({
  spaces,
  sourceAccounts,
  onSubmit,
}: {
  spaces: SettingsData["spaces"];
  sourceAccounts: SourceAccountRow[];
  onSubmit: (key: NewKey) => void;
}) {
  const [name, setName] = useState("");
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<KeyCapability[]>(["read"]);
  const [sourceAccountIds, setSourceAccountIds] = useState<string[]>([]);
  // SENS-1. Defaults to the full-access option; see the consent screen.
  const [maxSensitivity, setMaxSensitivity] =
    useState<SensitivityChoice>("restricted");
  const [error, setError] = useState("");

  const grantableSpaces: GrantableSpace[] = spaces.map((space) => ({
    spaceId: space.spaceId,
    name: space.name,
    kind: space.kind,
    role: space.role,
  }));
  const scopedSourceAccounts = sourceAccounts.filter(
    (account) =>
      spaceIds.includes(account.spaceId) &&
      account.enabled &&
      !isPendingId(account.id),
  );
  const needsSource = capabilities.includes("ingest");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !spaceIds.length || !capabilities.length) return;
    if (needsSource && !sourceAccountIds.length) {
      setError("Choose at least one source account for an ingest key.");
      return;
    }
    const grantedSources = sourceAccountGrantsForCapabilities(
      capabilities,
      sourceAccountIds,
    );
    onSubmit({
      row: {
        id: pendingId(),
        createdAt: Date.now(),
        keyPrefix: "",
        name: trimmed,
        lastUsedAt: null,
        capabilities,
        spaceIds,
        sourceAccountIds: grantedSources,
        maxSensitivity,
      },
      body: {
        name: trimmed,
        spaceIds,
        capabilities,
        sourceAccountIds: grantedSources,
        maxSensitivity,
      },
    });
  }

  return (
    <Panel>
      <form onSubmit={submit}>
        <Field label="Key name" htmlFor="api-key-name">
          <input
            id="api-key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Cursor"
            className={`${inputClass} w-64`}
          />
        </Field>
        <SpaceGrantChoices
          spaces={grantableSpaces}
          error=""
          spaceIds={spaceIds}
          onSpaceIdsChange={setSpaceIds}
          capabilities={capabilities}
          onCapabilitiesChange={setCapabilities}
          allowedCapabilities={settingsCapabilities}
          maxSensitivity={maxSensitivity}
          onMaxSensitivityChange={setMaxSensitivity}
        />
        {needsSource && (
          <fieldset className="my-3 rounded-tag border border-gray-200 p-3 text-xs">
            <legend className="px-1 text-sm font-medium text-gray-600">
              Ingest source accounts
            </legend>
            {scopedSourceAccounts.length === 0 ? (
              <p role="alert" className="text-red-700">
                No enabled source account in the selected spaces.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {scopedSourceAccounts.map((account) => (
                  <label key={account.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-accent-600"
                      checked={sourceAccountIds.includes(account.id)}
                      onChange={(event) =>
                        setSourceAccountIds((selected) =>
                          event.target.checked
                            ? [...selected, account.id]
                            : selected.filter((id) => id !== account.id),
                        )
                      }
                    />
                    {account.name} ({sourceKindLabel(account.connector)})
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <ErrorText>{error}</ErrorText>
        <Button
          type="submit"
          variant="primary"
          className="mt-2"
          disabled={
            !name.trim() ||
            !spaceIds.length ||
            !capabilities.length ||
            (needsSource && !sourceAccountIds.length)
          }
        >
          Generate key
        </Button>
      </form>
    </Panel>
  );
}

type SourceDraft = {
  id: string | null;
  name: string;
  connector: keyof typeof sourceKinds;
  accountId: string;
  spaceId: string;
  freshnessMinutes: string;
};

const EMPTY_DRAFT: SourceDraft = {
  id: null,
  name: "",
  connector: "mcp-client",
  accountId: "",
  spaceId: "",
  freshnessMinutes: "1440",
};

// Connection management moved to Data Sources. Kept private while API-key
// creation still shares its source-account types above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function SourceAccountsSection({
  sourceAccounts,
  spaces,
}: {
  sourceAccounts: SourceAccountRow[];
  spaces: SettingsData["spaces"];
}) {
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [error, setError] = useState("");

  const patchRow = (
    current: SettingsData,
    id: string,
    patch: Partial<SourceAccountRow>,
  ) => ({
    ...current,
    sourceAccounts: current.sourceAccounts.map((account) =>
      account.id === id ? { ...account, ...patch } : account,
    ),
  });

  const create = useOptimisticMutation<SettingsData, SourceAccountRow>({
    queryKey: KEY,
    mutationFn: (row) =>
      mutateJson("/api/kith/source-accounts", {
        method: "POST",
        body: JSON.stringify({
          spaceId: row.spaceId,
          connector: row.connector,
          accountId: row.accountId,
          name: row.name,
          freshnessMs: row.freshnessMs,
        }),
      }),
    apply: (current, row) => ({
      ...current,
      sourceAccounts: [...current.sourceAccounts, row],
    }),
  });

  const update = useOptimisticMutation<
    SettingsData,
    { id: string; patch: Partial<SourceAccountRow> }
  >({
    queryKey: KEY,
    mutationFn: ({ id, patch }) =>
      mutateJson(`/api/kith/source-accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    apply: (current, { id, patch }) => patchRow(current, id, patch),
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (draft === null) return;
    const minutes = Number(draft.freshnessMinutes);
    const name = draft.name.trim();
    if (!name || !validFreshness(minutes)) {
      setError(
        "Enter a source name and freshness between one minute and one year.",
      );
      return;
    }
    setError("");
    if (draft.id === null) {
      const accountId = draft.accountId.trim();
      if (!draft.spaceId || !accountId) return;
      create.mutate({
        id: pendingId(),
        spaceId: draft.spaceId,
        name,
        connector: draft.connector,
        accountId,
        freshnessMs: minutes * 60_000,
        enabled: true,
      });
    } else {
      update.mutate({
        id: draft.id,
        patch: { name, freshnessMs: minutes * 60_000 },
      });
    }
    setDraft(null);
  }

  const columns = useMemo<ColumnDef<SourceView, unknown>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "Name" },
      {
        id: "kind",
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <Tag>{row.original.kind}</Tag>,
      },
      {
        id: "accountId",
        accessorKey: "accountId",
        header: "Account ID",
        cell: ({ row }) => (
          <code className="font-mono text-data text-gray-700">
            {row.original.accountId}
          </code>
        ),
      },
      {
        id: "freshness",
        accessorFn: (row) => row.freshnessMs / 60_000,
        header: "Freshness (min)",
        meta: { nowrap: true },
        cell: ({ getValue }) => (
          <span className="tabular-nums">
            {tableInteger(getValue() as number)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        meta: { nowrap: true },
        cell: ({ row }) => (
          <Tag tone={row.original.enabled ? "accent" : "neutral"}>
            {row.original.status}
          </Tag>
        ),
      },
      {
        id: "heartbeat",
        header: "Worker",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.connector === "fs" && !isPendingId(row.original.id) ? (
            <WorkerHeartbeatStatus sourceAccountId={row.original.id} />
          ) : null,
      },
    ],
    [],
  );

  const rows = useMemo<SourceView[]>(
    () =>
      sourceAccounts.map((account) => ({
        ...account,
        kind: sourceKindLabel(account.connector),
        status: account.enabled ? "enabled" : "disabled",
      })),
    [sourceAccounts],
  );

  // Shared by the kebab's Edit item and clicking the row.
  const openEdit = useCallback((account: SourceView) => {
    if (isPendingId(account.id)) return;
    setError("");
    setDraft({
      id: account.id,
      name: account.name,
      connector: account.connector as keyof typeof sourceKinds,
      accountId: account.accountId,
      spaceId: account.spaceId,
      freshnessMinutes: String(account.freshnessMs / 60_000),
    });
  }, []);

  const actions = useMemo<RowAction<SourceView>[]>(
    () => [
      {
        label: "Edit",
        disabled: (account) => isPendingId(account.id),
        onSelect: openEdit,
      },
      {
        label: "Enable or disable",
        disabled: (account) => isPendingId(account.id),
        onSelect: (account) =>
          update.mutate({
            id: account.id,
            patch: { enabled: !account.enabled },
          }),
      },
    ],
    [openEdit, update],
  );

  return (
    <Section
      id="source-accounts"
      title="Source accounts"
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setError("");
            setDraft(draft === null ? EMPTY_DRAFT : null);
          }}
        >
          {draft === null ? "New source" : "Close"}
        </Button>
      }
    >
      {draft !== null && (
        <Panel>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            {draft.id === null && (
              <>
                <Field label="Source kind" htmlFor="source-kind">
                  <select
                    id="source-kind"
                    value={draft.connector}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        connector: event.target
                          .value as keyof typeof sourceKinds,
                      })
                    }
                    className={inputClass}
                  >
                    {Object.entries(sourceKinds).map(([connector, name]) => (
                      <option key={connector} value={connector}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Space" htmlFor="source-space">
                  <select
                    id="source-space"
                    value={draft.spaceId}
                    onChange={(event) =>
                      setDraft({ ...draft, spaceId: event.target.value })
                    }
                    disabled={spaces.length === 0}
                    className={inputClass}
                  >
                    <option value="">Choose a writable space</option>
                    {spaces.map((space) => (
                      <option key={space.spaceId} value={space.spaceId}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Source name" htmlFor="source-name">
              <input
                id="source-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="Cursor desktop"
                required
                maxLength={200}
                className={inputClass}
              />
            </Field>
            {draft.id === null && (
              <Field label="Source account ID" htmlFor="source-account-id">
                <input
                  id="source-account-id"
                  value={draft.accountId}
                  onChange={(event) =>
                    setDraft({ ...draft, accountId: event.target.value })
                  }
                  placeholder="desktop-capture"
                  required
                  maxLength={512}
                  className={inputClass}
                />
              </Field>
            )}
            <Field label="Freshness (minutes)" htmlFor="source-freshness">
              <input
                id="source-freshness"
                type="number"
                min={1}
                max={MAX_FRESHNESS_MINUTES}
                step={1}
                value={draft.freshnessMinutes}
                onChange={(event) =>
                  setDraft({ ...draft, freshnessMinutes: event.target.value })
                }
                required
                className={`${inputClass} w-28`}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={
                !draft.name.trim() ||
                (draft.id === null &&
                  (!draft.spaceId || !draft.accountId.trim()))
              }
            >
              {draft.id === null ? "Add source account" : "Save"}
            </Button>
          </form>
          <ErrorText>{error}</ErrorText>
        </Panel>
      )}
      <DataTable
        id="settings-source-accounts"
        data={rows}
        columns={columns}
        actions={actions}
        onRowClick={openEdit}
        filterColumns={["kind", "status"]}
        initialSorting={[{ id: "name", desc: false }]}
        searchPlaceholder="Search sources"
        empty="No source accounts"
      />
    </Section>
  );
}

type ConnectRow = { id: string; name: string; value: string; detail: string };

function ConnectSection() {
  // The page's own origin, read after mount so the server render and the
  // first client render agree. No host is written down anywhere.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const rows = useMemo<ConnectRow[]>(
    () => [
      {
        id: "mcp-url",
        name: "MCP URL",
        value: origin ? mcpEndpoint(origin) : "",
        detail: AI_CONNECTION_HELP,
      },
    ],
    [origin],
  );

  const columns = useMemo<ColumnDef<ConnectRow, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Item",
        cell: ({ row }) => (
          <Detail label={row.original.name} detail={row.original.detail} />
        ),
      },
      {
        id: "value",
        accessorKey: "value",
        header: "Value",
        enableSorting: false,
        cell: ({ row }) => (
          <code className="line-clamp-1 max-w-xl font-mono text-data text-gray-700">
            {row.original.value}
          </code>
        ),
      },
    ],
    [],
  );

  const actions = useMemo<RowAction<ConnectRow>[]>(
    () => [
      {
        label: "Copy",
        disabled: (row) => row.value === "",
        onSelect: (row) => void navigator.clipboard.writeText(row.value),
      },
    ],
    [],
  );

  return (
    <Section id="connect" title="AI Connections">
      <DataTable
        id="settings-connect"
        data={rows}
        columns={columns}
        actions={actions}
        showSearch={false}
        empty="Nothing to connect"
      />
    </Section>
  );
}
