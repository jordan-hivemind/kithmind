"use client";

// FIN-5: the compact "Rename" affordance shared by the Institutions and
// Balances screens' account rows.
//
// A small centered dialog rather than the full right-hand `Drawer` the
// account edit panel uses (`institution-account-drawer.tsx`): renaming is one
// field, not a form. Blank clears the owner's name and falls back to the
// placeholder -- the underlying feed or archive name -- the same "blank
// restores the underlying value" rule every override in this app follows.
//
// This component only renders the field and calls `onSave`; it does not know
// which backing store a rename writes to. An archive-linked account's Rename
// writes `kith.finance_account_overrides` (the same override the account's
// own Edit panel already uses), and a feed-only account's writes
// `kith.fin_accounts.display_name` -- the caller decides which by building
// the right `onSave` for the row it opened this for, so there is one Rename
// affordance rather than two different edit surfaces.

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { ErrorText } from "@/components/ui/controls";
import { buttonClass, inputClass, primaryButtonClass } from "@/components/ui/drawer";

export type RenameTarget = {
  /** A stable key so switching which row is being renamed resets the form's
   * local state. Never sent anywhere. */
  id: string;
  /** The account's current shown name, for the dialog's title. */
  label: string;
  /** What the field starts with -- empty when there is no owner name yet. */
  initialValue: string;
  /** The underlying name, shown once the field is blank. */
  placeholder: string;
};

export function RenameAccountDialog({
  target,
  onClose,
  onSave,
}: {
  target: RenameTarget | null;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  return target === null ? null : (
    <RenameForm key={target.id} target={target} onClose={onClose} onSave={onSave} />
  );
}

function RenameForm({
  target,
  onClose,
  onSave,
}: {
  target: RenameTarget;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(target.initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = value !== target.initialValue;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(value.trim() || null);
      onClose();
    } catch {
      setError("Could not save");
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-kith-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
          <Dialog.Title className="kith-section-title">
            Rename {target.label}
          </Dialog.Title>
          <input
            autoFocus
            className={inputClass}
            value={value}
            placeholder={target.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={!dirty || saving}
              onClick={save}
            >
              Save
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
