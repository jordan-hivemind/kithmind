"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

import { buttonClass } from "@/components/ui/controls";

type DocumentMetadata = {
  title: string | null;
  mimeType: string | null;
  contentAvailable: boolean;
  textAvailable: boolean;
};

export type DocumentReference = {
  sourceItemId: string;
  title?: string | null;
};

function documentUrl(sourceItemId: string, download = false): string {
  const path = `/api/kith/documents/${encodeURIComponent(sourceItemId)}/content`;
  return download ? `${path}?download=1` : path;
}

/**
 * The common, authenticated reader for a retained source document. The API
 * authorizes its source item on every request, so callers pass an identifier,
 * never a filesystem URI or a public URL.
 */
export function DocumentViewer({
  document,
  open,
  onOpenChange,
}: {
  document: DocumentReference | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [metadata, setMetadata] = useState<DocumentMetadata | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || document === null) return;

    const controller = new AbortController();
    setMetadata(null);
    setFailed(false);
    void fetch(
      `/api/kith/documents/${encodeURIComponent(document.sourceItemId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("document metadata fetch failed");
        return (await response.json()) as DocumentMetadata;
      })
      .then(setMetadata)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });

    return () => controller.abort();
  }, [document, open]);

  const title = metadata?.title ?? document?.title ?? "Document";
  const available = metadata?.contentAvailable || metadata?.textAvailable;
  const viewerUrl = document === null ? "" : documentUrl(document.sourceItemId);
  const downloadUrl =
    document === null ? "" : documentUrl(document.sourceItemId, true);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-kith-overlay" />
        <Dialog.Content className="fixed inset-x-4 top-4 bottom-4 z-50 flex max-w-none flex-col overflow-hidden rounded-panel border border-kith-border-subtle bg-kith-surface shadow-[var(--kith-shadow-lg)] sm:inset-x-8 lg:inset-x-16">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-kith-border-subtle px-4">
            <Dialog.Title className="min-w-0 truncate kith-section-title">
              {title}
            </Dialog.Title>
            <div className="flex shrink-0 items-center gap-2">
              {metadata?.contentAvailable ? (
                <a href={downloadUrl} className={buttonClass()}>
                  <Download className="mr-1.5 size-3.5" aria-hidden="true" />
                  Download
                </a>
              ) : null}
              <Dialog.Close
                aria-label="Close document"
                className="rounded-control p-2 text-kith-text-muted hover:bg-kith-surface-muted hover:text-kith-text focus-visible:outline-2 focus-visible:outline-accent-600"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 bg-kith-surface-muted p-3">
            {metadata === null && !failed ? (
              <div role="status" className="flex h-full items-center justify-center text-sm text-kith-text-muted">
                Loading document…
              </div>
            ) : failed || !available ? (
              <div role="status" className="flex h-full items-center justify-center text-sm text-kith-text-muted">
                Document content is unavailable.
              </div>
            ) : (
              <iframe
                key={viewerUrl}
                src={viewerUrl}
                title={title}
                className="h-full w-full rounded-control border border-kith-border-subtle bg-kith-surface"
                sandbox=""
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
