"use client";

// The two forms: one for an entry (the frequent action) and one for an
// investment.
//
// The entry drawer is the owner's approved mockup, in order: investment,
// type, date, amount, currency, exchange rate, note, document. The exchange
// rate appears only when the currency is not USD, and is required then --
// without it the USD totals could not be computed and the store and the schema
// both refuse the row.
//
// Keyboard: Enter saves (the form's own submit), and "Save and add another"
// returns focus to the amount, because the next entry is almost always the
// same investment on a different date for a different amount.
//
// What counts as a valid draft is decided by the very schemas the route will
// validate the request with, imported rather than restated. The hand-written
// copies they replace had already drifted: the amount pattern was unsigned,
// so a reduced commitment -- the one entry type that may be negative -- could
// be typed but never saved, with the Save button simply staying dead.

import type { admin } from "@repo/kith-store";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tag } from "@/components/ui/data-table";
import {
  type DocumentReference,
  DocumentViewer,
} from "@/components/ui/document-viewer";
import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { commitmentEntry } from "@/lib/kith/investment-commitment";
import {
  amountSchema,
  amountSchemaFor,
  isoDateSchema,
  rateSchema,
} from "@/lib/kith/investment-schemas";

export type EntryDraft = {
  investmentId: string;
  entryType: admin.InvestmentEntryType;
  entryDate: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  note: string;
  documentId: string | null;
  /** True when `entryDate` is an estimate rather than a stated date
   * (ADM-8b). No control renders it yet -- the pills and the tick box are
   * slice 4 -- but it is carried so the value round trips through an edit
   * instead of being dropped and re-defaulted to false. */
  dateIsEstimated: boolean;
};

const ENTRY_TYPE_LABELS: Record<admin.InvestmentEntryType, string> = {
  capital_call_paid: "Capital call paid",
  distribution: "Distribution received",
  commitment: "Commitment",
  commitment_change: "Commitment change",
  fee: "Fee or expense",
  write_off: "Write-off",
  other: "Other",
};

const CURRENCIES = ["USD", "GBP", "EUR"] as const;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyEntry(investmentId: string): EntryDraft {
  return {
    investmentId,
    entryType: "capital_call_paid",
    entryDate: today(),
    amount: "",
    currency: "USD",
    exchangeRate: "",
    note: "",
    documentId: null,
    dateIsEstimated: false,
  };
}

type Suggestion = admin.DocumentLinkSuggestion;

export function EntryDrawer({
  open,
  onOpenChange,
  investments,
  initial,
  editingEntryId,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  investments: readonly admin.InvestmentRow[];
  initial: EntryDraft;
  /** Null when adding. The drawer is otherwise identical. */
  editingEntryId: string | null;
  /** Resolves when the optimistic write has been applied. */
  onSave: (draft: EntryDraft, again: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState<EntryDraft>(initial);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [documentQuery, setDocumentQuery] = useState("");
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  // Suggestions follow the draft: the investment names the document, the
  // amount and date rank it. Recomputed on read, never stored.
  useEffect(() => {
    if (!open || draft.investmentId === "") {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/kith/investments/${draft.investmentId}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        // The magnitude, not the sign: a suggestion looks for the amount as a
        // document prints it, and a document prints a reduced commitment of
        // -250 as 250.
        body: JSON.stringify({
          ...(amountSchema.safeParse(draft.amount.replace(/^-/, "")).success
            ? { amount: draft.amount.replace(/^-/, "") }
            : {}),
          ...(draft.entryDate === "" ? {} : { entryDate: draft.entryDate }),
        }),
      })
        .then((response) =>
          response.ok ? response.json() : { suggestions: [] },
        )
        .then((body: { suggestions: Suggestion[] }) =>
          setSuggestions(body.suggestions ?? []),
        )
        .catch(() => setSuggestions([]));
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, draft.investmentId, draft.amount, draft.entryDate]);

  const needsRate = draft.currency !== "USD";
  const valid =
    draft.investmentId !== "" &&
    amountSchemaFor(draft.entryType).safeParse(draft.amount).success &&
    isoDateSchema.safeParse(draft.entryDate).success &&
    (!needsRate || rateSchema.safeParse(draft.exchangeRate).success);

  const visible = useMemo(
    () =>
      suggestions.filter((suggestion) =>
        suggestion.title.toLowerCase().includes(documentQuery.toLowerCase()),
      ),
    [suggestions, documentQuery],
  );

  const submit = async (again: boolean) => {
    if (!valid) return;
    await onSave(draft, again);
    if (again) {
      setDraft({ ...draft, amount: "", note: "", documentId: null });
      amountRef.current?.focus();
    } else {
      onOpenChange(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={editingEntryId === null ? "Add entry" : "Edit entry"}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <Field label="Investment">
          <input
            list="investment-options"
            className={inputClass}
            value={
              investments.find((item) => item.id === draft.investmentId)
                ?.name ?? ""
            }
            onChange={(event) => {
              const match = investments.find(
                (item) => item.name === event.target.value,
              );
              setDraft({ ...draft, investmentId: match?.id ?? "" });
            }}
          />
          <datalist id="investment-options">
            {investments.map((item) => (
              <option key={item.id} value={item.name} />
            ))}
          </datalist>
        </Field>

        <Field label="Type">
          <select
            className={inputClass}
            value={draft.entryType}
            onChange={(event) =>
              setDraft({
                ...draft,
                entryType: event.target.value as admin.InvestmentEntryType,
              })
            }
          >
            {Object.entries(ENTRY_TYPE_LABELS)
              .filter(
                // The commitment is edited on the investment itself.
                ([value]) =>
                  value !== "commitment" || initial.entryType === "commitment",
              )
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
        </Field>

        <Field label="Date">
          <input
            type="date"
            className={inputClass}
            value={draft.entryDate}
            onChange={(event) =>
              setDraft({ ...draft, entryDate: event.target.value })
            }
          />
        </Field>

        <Field label="Amount">
          <input
            ref={amountRef}
            inputMode="decimal"
            className={inputClass}
            value={draft.amount}
            onChange={(event) =>
              setDraft({ ...draft, amount: event.target.value.trim() })
            }
          />
        </Field>

        <Field label="Currency">
          <select
            className={inputClass}
            value={draft.currency}
            onChange={(event) =>
              setDraft({ ...draft, currency: event.target.value })
            }
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>

        {needsRate ? (
          <Field label={`Exchange rate to USD`}>
            <input
              inputMode="decimal"
              className={inputClass}
              value={draft.exchangeRate}
              onChange={(event) =>
                setDraft({ ...draft, exchangeRate: event.target.value.trim() })
              }
            />
          </Field>
        ) : null}

        <Field label="Note">
          <input
            className={inputClass}
            value={draft.note}
            onChange={(event) =>
              setDraft({ ...draft, note: event.target.value })
            }
          />
        </Field>

        <Field label="Document">
          <input
            className={inputClass}
            placeholder="Link existing"
            value={documentQuery}
            onChange={(event) => setDocumentQuery(event.target.value)}
          />
        </Field>
        <ul className="flex flex-col gap-0.5">
          {visible.slice(0, 6).map((suggestion) => (
            <li key={suggestion.documentId}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={draft.documentId === suggestion.documentId}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        documentId:
                          draft.documentId === suggestion.documentId
                            ? null
                            : suggestion.documentId,
                      })
                    }
                    className={`w-full truncate rounded-tag border px-1.5 py-0.5 text-left text-meta ${
                      draft.documentId === suggestion.documentId
                        ? "border-accent-600 bg-accent-50 text-accent-700"
                        : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300"
                    }`}
                  >
                    {suggestion.title}
                    <span className="ml-1 text-gray-400">
                      {suggestion.reasons.join(" ")}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {suggestion.reasons.join(", ") || suggestion.title}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label="Upload unavailable"
                className="inline-flex rounded-control outline-none focus-visible:ring-2 focus-visible:ring-kith-action"
              >
                <button type="button" disabled className={buttonClass}>
                  Upload
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Drop files in the watched Investing folder
            </TooltipContent>
          </Tooltip>
          <span className="flex-1" />
          <button
            type="button"
            className={buttonClass}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          {editingEntryId === null ? (
            <button
              type="button"
              disabled={!valid}
              className={buttonClass}
              onClick={() => void submit(true)}
            >
              Save and add another
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!valid}
            className={primaryButtonClass}
          >
            Save
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export type InvestmentDraft = {
  name: string;
  category: string;
  signedOn: string;
  status: admin.InvestmentStatus;
  notes: string;
  /** The base commitment's amount, in `commitmentCurrency`. Empty when none.
   * A property of the investment on this screen; stored as its `commitment`
   * entry (see `lib/kith/investment-commitment.ts`). */
  commitment: string;
};

export function emptyInvestment(): InvestmentDraft {
  return {
    name: "",
    category: "Investment Fund",
    signedOn: "",
    status: "active",
    notes: "",
    commitment: "",
  };
}

const CATEGORIES = ["Investment Fund", "Direct", "AngelList"] as const;

type InvestmentDocument = Omit<admin.InvestmentDocument, "uri">;

/** What the drawer read when it opened, passed back on save so the commitment
 * write is decided against the entries the owner was looking at. */
export type InvestmentDrawerContext = {
  entries: admin.InvestmentEntry[];
  commitmentCurrency: string;
};

const DOCUMENT_KIND_LABELS: Record<string, string> = {
  investment_agreement: "Agreement",
  capital_call_notice: "Capital call",
  distribution_notice: "Distribution",
  schedule_k1: "K-1",
  capital_account_statement: "Statement",
  wire_confirmation: "Wire",
  letter_or_notice: "Letter",
};

export function InvestmentDrawer({
  open,
  onOpenChange,
  initial,
  editingId,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: InvestmentDraft;
  editingId: string | null;
  onSave: (
    draft: InvestmentDraft,
    context: InvestmentDrawerContext,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InvestmentDraft>(initial);
  // The draft the owner started from, once the entries have said what the
  // commitment is. `dirty` compares against this, not against `initial`,
  // so the commitment arriving is not mistaken for an edit.
  const [baseline, setBaseline] = useState<InvestmentDraft>(initial);
  const [context, setContext] = useState<InvestmentDrawerContext>({
    entries: [],
    commitmentCurrency: "USD",
  });
  const [loaded, setLoaded] = useState(editingId === null);
  const [documents, setDocuments] = useState<InvestmentDocument[] | null>(null);
  const [uploads, setUploads] = useState<
    { name: string; state: "uploading" | "added" | "failed"; error?: string }[]
  >([]);
  const [viewing, setViewing] = useState<DocumentReference | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    if (editingId === null) return;
    const response = await fetch(
      `/api/kith/investments/${editingId}/documents`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    setDocuments(
      ((await response.json()) as { documents: InvestmentDocument[] })
        .documents,
    );
  }, [editingId]);

  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setBaseline(initial);
    setUploads([]);
    setDocuments(null);
    if (editingId === null) {
      setContext({ entries: [], commitmentCurrency: "USD" });
      setLoaded(true);
      return;
    }
    setLoaded(false);
    const controller = new AbortController();
    void fetch(`/api/kith/investments/${editingId}/entries`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ entries: admin.InvestmentEntry[] }>)
          : Promise.reject(new Error("entries fetch failed")),
      )
      .then(({ entries }) => {
        const entry = commitmentEntry(entries);
        const next = { ...initial, commitment: entry?.amount ?? "" };
        setContext({ entries, commitmentCurrency: entry?.currency ?? "USD" });
        setDraft(next);
        setBaseline(next);
        setLoaded(true);
      })
      .catch(() => undefined);
    void loadDocuments();
    return () => controller.abort();
  }, [open, initial, editingId, loadDocuments]);

  const commitmentEditable =
    loaded &&
    context.entries.filter((entry) => entry.entryType === "commitment")
      .length <= 1;
  const commitmentValid =
    draft.commitment.trim() === "" ||
    amountSchema.safeParse(draft.commitment.trim()).success;
  const valid = draft.name.trim() !== "" && loaded && commitmentValid;

  const act = async (linkId: string, action: "confirm" | "remove") => {
    if (editingId === null) return;
    setDocuments((current) =>
      action === "remove"
        ? (current ?? []).filter((document) => document.linkId !== linkId)
        : (current ?? []).map((document) =>
            document.linkId === linkId
              ? { ...document, state: "confirmed" }
              : document,
          ),
    );
    await fetch(`/api/kith/investments/${editingId}/documents`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkId, action }),
    }).catch(() => undefined);
    await loadDocuments();
  };

  const upload = async (files: FileList | null) => {
    if (editingId === null || files === null) return;
    for (const file of Array.from(files)) {
      setUploads((current) => [
        ...current,
        { name: file.name, state: "uploading" },
      ]);
      const finish = (state: "added" | "failed", error?: string) =>
        setUploads((current) =>
          current.map((item) =>
            item.name === file.name && item.state === "uploading"
              ? { name: item.name, state, ...(error ? { error } : {}) }
              : item,
          ),
        );
      try {
        const response = await fetch(
          `/api/kith/investments/${editingId}/documents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          uploadUrl?: string;
          error?: string;
        };
        if (!response.ok || !body.uploadUrl) {
          finish("failed", body.error ?? "Upload failed");
          continue;
        }
        const sent = await fetch(body.uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        finish(
          sent.ok ? "added" : "failed",
          sent.ok ? undefined : "Upload failed",
        );
      } catch {
        finish("failed", "Upload failed");
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={editingId === null ? "Add investment" : "Edit investment"}
      dirty={JSON.stringify(draft) !== JSON.stringify(baseline)}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          void onSave(draft, context).then(() => onOpenChange(false));
        }}
      >
        <Field label="Name">
          <input
            className={inputClass}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </Field>
        <Field label="Category">
          <select
            className={inputClass}
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value })
            }
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Signed">
          <input
            type="date"
            className={inputClass}
            value={draft.signedOn}
            onChange={(event) =>
              setDraft({ ...draft, signedOn: event.target.value })
            }
          />
        </Field>
        <Field label={`Commitment (${context.commitmentCurrency})`}>
          <input
            inputMode="decimal"
            className={inputClass}
            disabled={!commitmentEditable}
            aria-invalid={!commitmentValid}
            value={draft.commitment}
            onChange={(event) =>
              setDraft({
                ...draft,
                commitment: event.target.value.replace(/[,$\s]/g, ""),
              })
            }
          />
        </Field>
        <Field label="Status">
          <select
            className={inputClass}
            value={draft.status}
            onChange={(event) =>
              setDraft({
                ...draft,
                status: event.target.value as admin.InvestmentStatus,
              })
            }
          >
            <option value="active">active</option>
            <option value="closed">closed</option>
            <option value="written_off">written_off</option>
          </select>
        </Field>
        <Field label="Note">
          <input
            className={inputClass}
            value={draft.notes}
            onChange={(event) =>
              setDraft({ ...draft, notes: event.target.value })
            }
          />
        </Field>

        {editingId === null ? null : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-meta font-medium text-gray-700">
                Documents
              </span>
              <button
                type="button"
                className={buttonClass}
                onClick={() => fileRef.current?.click()}
              >
                Add document
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => void upload(event.target.files)}
              />
            </div>
            <ul className="flex flex-col divide-y divide-gray-100 rounded-control border border-gray-200">
              {documents === null ? (
                <li className="px-2 py-1.5 text-meta text-gray-400">Loading</li>
              ) : documents.length === 0 && uploads.length === 0 ? (
                <li className="px-2 py-1.5 text-meta text-gray-400">None</li>
              ) : null}
              {(documents ?? []).map((document) => (
                <li
                  key={document.linkId}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-meta text-gray-900 hover:text-accent-700 hover:underline"
                    onClick={() =>
                      setViewing({
                        sourceItemId: document.sourceItemId,
                        title: document.title,
                      })
                    }
                  >
                    {document.title ?? "Untitled"}
                  </button>
                  {document.kind && DOCUMENT_KIND_LABELS[document.kind] ? (
                    <Tag>{DOCUMENT_KIND_LABELS[document.kind]}</Tag>
                  ) : null}
                  {document.state === "suggested" ? (
                    <button
                      type="button"
                      className="rounded-tag border border-accent-200 bg-accent-50 px-1.5 py-0.5 text-xs leading-none text-accent-700 hover:border-accent-400"
                      onClick={() => void act(document.linkId, "confirm")}
                    >
                      Confirm
                    </button>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Remove"
                        className="rounded-control p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        onClick={() => void act(document.linkId, "remove")}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Not this investment</TooltipContent>
                  </Tooltip>
                </li>
              ))}
              {uploads.map((item, index) => (
                <li
                  key={`${item.name}:${index}`}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-meta text-gray-600">
                    {item.name}
                  </span>
                  {item.state === "failed" ? (
                    <Tag tone="warn" title={item.error}>
                      failed
                    </Tag>
                  ) : (
                    <Tag
                      tone="accent"
                      title={
                        item.state === "added"
                          ? "Saved to Dropbox. Listed here after the next hourly scan."
                          : undefined
                      }
                    >
                      {item.state === "added" ? "processing" : "uploading"}
                    </Tag>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className={buttonClass}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className={primaryButtonClass}
          >
            Save
          </button>
        </div>
      </form>
      <DocumentViewer
        document={viewing}
        open={viewing !== null}
        onOpenChange={(next) => {
          if (!next) setViewing(null);
        }}
      />
    </Drawer>
  );
}
