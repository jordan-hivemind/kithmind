"use client";

// The right-side drawer the entry form lives in.
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

import * as Dialog from "@radix-ui/react-dialog";

export function Drawer({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Announced to a screen reader and shown as the heading. Two or three
   * words, never a sentence: the owner asked for no explanatory prose. */
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-gray-900/20" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-3 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-xl">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-medium text-gray-900">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-tag px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              ✕
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
