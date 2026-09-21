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
  originalUnavailableReason?: string | null;
  pages?: Array<{ pageNumber: number; text: string }>;
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
  const [view, setView] = useState<"original" | "text">("original");

  useEffect(() => {
    if (!open || document === null) return;

    const controller = new AbortController();
    setMetadata(null);
    setFailed(false);
    setView("original");
    void fetch(
      `/api/kith/documents/${encodeURIComponent(document.sourceItemId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("document metadata fetch failed");
        return (await response.json()) as DocumentMetadata;
      })
      .then((next) => {
        setMetadata(next);
        setView(
          next.contentAvailable && next.mimeType === "application/pdf"
            ? "original"
            : "text",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setFailed(true);
      });

    return () => controller.abort();
  }, [document, open]);

  const title = metadata?.title ?? document?.title ?? "Document";
  const viewerUrl = document === null ? "" : documentUrl(document.sourceItemId);
  const downloadUrl =
    document === null ? "" : documentUrl(document.sourceItemId, true);
  const canViewOriginal =
    metadata?.contentAvailable === true &&
    metadata.mimeType === "application/pdf";
  const pages = metadata?.pages ?? [];
  const canViewText = metadata?.textAvailable === true && pages.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-kith-overlay" />
        <Dialog.Content className="fixed inset-x-4 top-4 bottom-4 z-50 flex max-w-none flex-col overflow-hidden rounded-panel border border-kith-border-subtle bg-kith-surface shadow-[var(--kith-shadow-lg)] sm:inset-x-8 lg:inset-x-16">
          <div className="flex min-h-12 flex-wrap items-center gap-3 border-b border-kith-border-subtle px-4 py-2 sm:flex-nowrap">
            <Dialog.Title className="basis-full truncate kith-section-title sm:min-w-0 sm:flex-1 sm:basis-auto">
              {title}
            </Dialog.Title>
            <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
              {canViewOriginal && canViewText ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={view === "original"}
                    onClick={() => setView("original")}
                    className={buttonClass(
                      view === "original" ? "primary" : "secondary",
                    )}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "text"}
                    onClick={() => setView("text")}
                    className={buttonClass(
                      view === "text" ? "primary" : "secondary",
                    )}
                  >
                    Retained text
                  </button>
                </div>
              ) : null}
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
              <div
                role="status"
                className="flex h-full items-center justify-center text-sm text-kith-text-muted"
              >
                Loading document…
              </div>
            ) : failed ? (
              <div
                role="status"
                className="flex h-full items-center justify-center text-sm text-kith-text-muted"
              >
                Document content is unavailable.
              </div>
            ) : view === "original" && canViewOriginal ? (
              <iframe
                key={viewerUrl}
                src={viewerUrl}
                title={title}
                className="h-full w-full rounded-control border border-kith-border-subtle bg-kith-surface"
              />
            ) : canViewText ? (
              <div className="h-full overflow-y-auto rounded-control border border-kith-border-subtle bg-kith-surface p-5 text-[15px] leading-6 text-kith-text">
                {pages.map((page, index) => (
                  <section
                    key={page.pageNumber}
                    aria-label={`Page ${page.pageNumber}`}
                    className={
                      index === pages.length - 1
                        ? ""
                        : "mb-6 border-b border-kith-border-subtle pb-6"
                    }
                  >
                    <h2 className="mb-3 text-meta font-medium text-kith-text-muted">
                      Page {page.pageNumber}
                    </h2>
                    <pre className="font-sans whitespace-pre-wrap break-words">
                      {page.text}
                    </pre>
                  </section>
                ))}
              </div>
            ) : (
              <div
                role="status"
                className="flex h-full items-center justify-center text-sm text-kith-text-muted"
              >
                {metadata?.originalUnavailableReason ??
                  "Document content is unavailable."}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
