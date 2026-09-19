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
          <Dialog.Overlay className="fixed inset-0 z-40 bg-gray-900/20" />
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
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-sm font-medium text-gray-900">
                {title}
              </Dialog.Title>
              <button
                type="button"
                aria-label="Close"
                onClick={requestClose}
                className="rounded-tag px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root open={confirmingClose} onOpenChange={setConfirmingClose}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-gray-900/20" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] w-full max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-tag border border-gray-200 bg-white p-4 shadow-xl">
            <AlertDialog.Title className="text-sm font-medium text-gray-900">
              Discard changes?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-xs text-gray-600">
              Unsaved edits will be lost.
            </AlertDialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <AlertDialog.Cancel className={buttonClass}>Keep editing</AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  setConfirmingClose(false);
                  onOpenChange(false);
                }}
                className="h-7 rounded-tag border border-red-600 bg-red-600 px-2 text-xs text-white hover:bg-red-700"
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
    <label className="flex flex-col gap-1 text-xs text-gray-600">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-7 w-full rounded-tag border border-gray-300 px-2 text-xs text-gray-900 outline-none focus:border-accent-500";

export const buttonClass =
  "h-7 rounded-tag border border-gray-300 px-2 text-xs text-gray-700 hover:border-gray-400 disabled:text-gray-300";

export const primaryButtonClass =
  "h-7 rounded-tag border border-accent-600 bg-accent-600 px-2 text-xs text-white hover:bg-accent-700 disabled:border-gray-200 disabled:bg-gray-200";
