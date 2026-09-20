"use client";

// The right-side drawer every edit form lives in.
//
// Radix Dialog with the panel pinned to the right edge. Radix rather than a
// hand-rolled overlay because the accessibility is the whole point of the
// primitive: focus is trapped and restored, Escape closes, the rest of the
// page is `aria-hidden`, and the title is announced. Rewriting that correctly
// is more code than importing it, and rewriting it incorrectly is a form the
// keyboard cannot reach.
//
// Not a component library: one file, one shape, and a caller that needs a
// different width passes one.

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

export function Drawer({
  open,
  onOpenChange,
  title,
  dirty = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Announced to a screen reader and shown as the heading. Two or three
   * words, never a sentence: the owner asked for no explanatory prose. */
  title: string;
  /** True while the form has unsaved edits. Esc, an outside click, and the
   * close button then ask for confirmation (a Radix AlertDialog) instead of
   * closing outright. A caller that calls `onOpenChange(false)` itself --
   * after a successful save, or from its own Cancel button -- bypasses this;
   * there is nothing unsaved to lose at that point. */
  dirty?: boolean;
  children: React.ReactNode;
}) {
  const [confirmingClose, setConfirmingClose] = useState(false);

  const requestClose = () => {
    if (dirty) setConfirmingClose(true);
    else onOpenChange(false);
  };

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else requestClose();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-kith-overlay" />
          <Dialog.Content
            onEscapeKeyDown={(event) => {
              if (dirty) {
                event.preventDefault();
                requestClose();
              }
            }}
            onPointerDownOutside={(event) => {
              if (dirty) {
                event.preventDefault();
                requestClose();
              }
            }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]"
          >
            <div className="flex items-center justify-between">
              <Dialog.Title className="kith-section-title">
                {title}
              </Dialog.Title>
              <button
                type="button"
                aria-label="Close"
                onClick={requestClose}
                className="rounded-control px-2 py-1 text-kith-text-muted hover:bg-kith-surface-muted hover:text-kith-text"
              >
                ✕
              </button>
            </div>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root
        open={confirmingClose}
        onOpenChange={setConfirmingClose}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-kith-overlay" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
            <AlertDialog.Title className="kith-section-title">
              Discard changes?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-kith-text-secondary">
              Unsaved edits will be lost.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>
                Keep editing
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  setConfirmingClose(false);
                  onOpenChange(false);
                }}
                className="h-8 rounded-control border border-red-600 bg-red-600 px-3 text-sm text-white hover:bg-red-700"
              >
                Discard
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

/** A labelled field. The label is the only text in the form. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-kith-text-secondary">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-8 w-full rounded-control border border-kith-border-subtle px-2.5 text-sm text-kith-text outline-none focus:border-kith-action focus:ring-1 focus:ring-kith-action";

export const buttonClass =
  "h-8 rounded-control border border-kith-border-subtle px-3 text-sm text-kith-text-secondary hover:bg-kith-surface-muted disabled:text-kith-text-muted";

export const primaryButtonClass =
  "h-8 rounded-control border border-kith-action bg-kith-action px-3 text-sm text-white hover:bg-kith-action-hover disabled:border-gray-200 disabled:bg-gray-200";
