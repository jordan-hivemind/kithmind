"use client";

// The edit panel for one account on the Institutions screen. What is saved is
// the owner's override, kept beside the archive (migration 033); a blank field
// goes back to whatever the archive says, shown as the placeholder.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorText } from "@/components/ui/controls";
import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  archiveDate,
  label,
  tableInteger,
  tableMoney,
} from "@/lib/kith/format";
import type { InstitutionRow } from "@/lib/kith/institutions";

const TYPES = [
  "brokerage",
  "retirement",
  "trust",
  "bank",
  "mortgage",
  "credit_line",
  "other",
];

type Draft = {
  displayName: string;
  accountLast4: string;
  accountType: string;
  closed: boolean;
};

function draftOf(row: InstitutionRow): Draft {
  return {
    displayName: row.override?.displayName ?? "",
    accountLast4: row.override?.accountLast4 ?? "",
    accountType: row.override?.accountType ?? "",
    closed: row.override?.closed ?? false,
  };
}

export function InstitutionAccountDrawer({
  row,
  onClose,
}: {
  row: InstitutionRow | null;
  onClose: () => void;
}) {
  return row === null ? null : (
    <AccountForm key={row.id} row={row} onClose={onClose} />
  );
}

function AccountForm({
  row,
  onClose,
}: {
  row: InstitutionRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const archive = row.archive!;
  const initial = draftOf(row);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const lastFourValid = /^([0-9]{4})?$/.test(draft.accountLast4);
  const types =
    TYPES.includes(draft.accountType) || draft.accountType === ""
      ? TYPES
      : [...TYPES, draft.accountType];

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(
        `/api/kith/finance-accounts/${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: draft.displayName.trim() || null,
            accountLast4: draft.accountLast4 || null,
            accountType: draft.accountType || null,
            closed: draft.closed,
          }),
        },
      );
      if (!response.ok) throw new Error("save failed");
      await queryClient.invalidateQueries({ queryKey: ["institutions"] });
      onClose();
    } catch {
      setError("Could not save");
      setSaving(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={archive.name}
      dirty={dirty}
    >
      <div className="grid grid-cols-2 gap-2 rounded-control border border-kith-border-subtle bg-kith-surface-muted p-3 text-sm">
        <span className="text-kith-text-muted">Statements</span>
        <span className="text-right tabular-nums">
          {tableInteger(row.statements)}
        </span>
        <span className="text-kith-text-muted">Records</span>
        <span className="text-right tabular-nums">
          {tableInteger(row.records)}
        </span>
        <span className="text-kith-text-muted">Value as of</span>
        <span className="text-right tabular-nums">
          {archiveDate(row.currentValueAsOf)}
        </span>
        <span className="text-kith-text-muted">Latest snapshot</span>
        <span className="text-right tabular-nums">
          {archiveDate(row.latestSnapshotAsOf)}
        </span>
        <span className="text-kith-text-muted">Status</span>
        <span className="text-right">{label(row.status)}</span>
        {row.currentValueStale ? (
          <span className="col-span-2 text-kith-text-muted">
            Current value is stale and may not reflect the latest activity.
          </span>
        ) : null}
        {row.statusDetail ? (
          <span className="col-span-2 text-kith-text-muted">
            {row.statusDetail}
          </span>
        ) : null}
        {row.currentValue !== null && row.currentValueCurrency !== null ? (
          <>
            <span className="text-kith-text-muted">Current value</span>
            <span className="text-right tabular-nums">
              {tableMoney(row.currentValue, row.currentValueCurrency)}
            </span>
          </>
        ) : null}
      </div>
      <Field label="Name">
        <input
          className={inputClass}
          value={draft.displayName}
          placeholder={archive.name}
          onChange={(event) =>
            setDraft({ ...draft, displayName: event.target.value })
          }
        />
      </Field>
      <Field label="Last four">
        <input
          className={inputClass}
          inputMode="numeric"
          maxLength={4}
          value={draft.accountLast4}
          placeholder={archive.accountLast4 ?? ""}
          onChange={(event) =>
            setDraft({
              ...draft,
              accountLast4: event.target.value.replace(/\D/g, ""),
            })
          }
        />
      </Field>
      <Field label="Type">
        <select
          className={inputClass}
          value={draft.accountType}
          onChange={(event) =>
            setDraft({ ...draft, accountType: event.target.value })
          }
        >
          <option value="">
            {archive.accountType === null ? "" : label(archive.accountType)}
          </option>
          {types.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-center gap-2 text-sm text-kith-text-secondary">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent-600"
          checked={draft.closed}
          onChange={(event) =>
            setDraft({ ...draft, closed: event.target.checked })
          }
        />
        Closed
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-between gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={saving}
          onClick={() =>
            setDraft({
              displayName: "",
              accountLast4: "",
              accountType: "",
              closed: false,
            })
          }
        >
          Reset
        </button>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!dirty || !lastFourValid || saving}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </Drawer>
  );
}
