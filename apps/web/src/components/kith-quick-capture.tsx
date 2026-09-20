"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Plus } from "lucide-react";
import { useState } from "react";

import { Button, inputClass } from "@/components/ui/controls";
import type { CaptureResponse } from "@/lib/kith/capture-client";

export function KithQuickCapture({
  onCapture,
}: {
  onCapture: (content: string) => Promise<CaptureResponse>;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;
    setLoading(true);
    setStatus(null);
    try {
      await onCapture(trimmed);
      setContent("");
      setOpen(false);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Failed to capture thought. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setStatus(null);
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="primary" className="gap-1.5">
          <Plus className="size-4" aria-hidden="true" />
          New Thought
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgb(20_32_30_/_48%)]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-panel border border-kith-border-subtle bg-kith-surface p-5 shadow-[var(--kith-shadow-lg)]">
          <Dialog.Title className="kith-section-title">
            New thought
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Capture a thought, decision, note, or idea.
          </Dialog.Description>
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="mt-4 space-y-3"
          >
            <label htmlFor="quick-capture" className="sr-only">
              Thought
            </label>
            <textarea
              id="quick-capture"
              autoFocus
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Thought, decision, note or idea"
              rows={5}
              className={`${inputClass} h-auto min-h-32 w-full resize-y py-2`}
            />
            {status ? (
              <p role="alert" className="text-sm text-kith-danger">
                {status}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button disabled={loading}>Cancel</Button>
              </Dialog.Close>
              <Button
                type="submit"
                variant="primary"
                disabled={loading || !content.trim()}
              >
                {loading ? "Saving..." : "Save thought"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
