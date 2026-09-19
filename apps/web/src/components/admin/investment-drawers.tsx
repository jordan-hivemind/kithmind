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
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
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
        .then((response) => (response.ok ? response.json() : { suggestions: [] }))
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
              investments.find((item) => item.id === draft.investmentId)?.name ??
              ""
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
            {Object.entries(ENTRY_TYPE_LABELS).map(([value, label]) => (
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
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
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
              <button
                type="button"
                aria-pressed={draft.documentId === suggestion.documentId}
                title={suggestion.reasons.join(", ")}
                onClick={() =>
                  setDraft({
                    ...draft,
                    documentId:
                      draft.documentId === suggestion.documentId
                        ? null
                        : suggestion.documentId,
                  })
                }
                className={`w-full truncate rounded-tag border px-1.5 py-0.5 text-left text-[11px] ${
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
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled
            title="Drop files in the watched Investing folder"
            className={buttonClass}
          >
            Upload
          </button>
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
          <button type="submit" disabled={!valid} className={primaryButtonClass}>
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
};

export function emptyInvestment(): InvestmentDraft {
  return {
    name: "",
    category: "Investment Fund",
    signedOn: "",
    status: "active",
    notes: "",
  };
}

const CATEGORIES = ["Investment Fund", "Direct", "AngelList"] as const;

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
  onSave: (draft: InvestmentDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InvestmentDraft>(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={editingId === null ? "Add investment" : "Edit investment"}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim() === "") return;
          void onSave(draft).then(() => onOpenChange(false));
        }}
      >
        <Field label="Name">
          <input
            className={inputClass}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
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
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          />
        </Field>
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
            disabled={draft.name.trim() === ""}
            className={primaryButtonClass}
          >
            Save
          </button>
        </div>
      </form>
    </Drawer>
  );
}
