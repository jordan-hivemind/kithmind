"use client";

// The one-time spreadsheet import, as a drawer.
//
// The operator picks two CSV files (the `Summary` and `Ledger` tabs, exported
// from the sheet), sees exactly what will be created, flips any row whose type
// was read wrong, and imports. Nothing leaves the browser until then: the
// parse and the reconciliation are pure functions in
// `lib/kith/investment-import.ts`, which is where their tests are.
//
// Idempotent by row key: a second import of the same file creates nothing.
// The keys are computed here and stored on the entry, and the unique index in
// migration 024 is what enforces it, so a double click or a retried network
// call cannot double the owner's capital calls either.

import { useState } from "react";

import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  buildPreview,
  IMPORT_RULE,
  type ImportPreview,
  type LedgerDraft,
} from "@/lib/kith/investment-import";

export type ImportResult = { investments: number; entries: number };

export function ImportDrawer({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (preview: ImportPreview) => Promise<ImportResult>;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summaryCsv, setSummaryCsv] = useState("");
  const [ledgerCsv, setLedgerCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportResult | null>(null);

  const rebuild = (summary: string, ledger: string) => {
    setSummaryCsv(summary);
    setLedgerCsv(ledger);
    setDone(null);
    setPreview(
      summary === "" && ledger === "" ? null : buildPreview(summary, ledger),
    );
  };

  const flip = (index: number) => {
    if (preview === null) return;
    const ledger = preview.ledger.map((row, position) =>
      position !== index
        ? row
        : ({
            ...row,
            entryType:
              row.entryType === "capital_call_paid"
                ? "distribution"
                : "capital_call_paid",
          } satisfies LedgerDraft),
    );
    setPreview({ ...preview, ledger });
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Import">
      <div className="flex flex-col gap-3">
        <Field label="Summary CSV">
          <input
            type="file"
            accept=".csv,text/csv"
            className={inputClass}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              rebuild(file === undefined ? "" : await file.text(), ledgerCsv);
            }}
          />
        </Field>
        <Field label="Ledger CSV">
          <input
            type="file"
            accept=".csv,text/csv"
            className={inputClass}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              rebuild(summaryCsv, file === undefined ? "" : await file.text());
            }}
          />
        </Field>

        {preview === null ? null : (
          <>
            {/* The rule the mapping applied, shown because the operator is
                being asked to approve it, not merely told it happened. */}
            <p className="rounded-tag border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-600">
              {IMPORT_RULE}
            </p>

            <table className="w-full text-[11px]">
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="h-row">Investments</td>
                  <td className="h-row text-right tabular-nums">
                    {preview.summary.length}
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="h-row">Entries</td>
                  <td className="h-row text-right tabular-nums">
                    {preview.ledger.length}
                  </td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="h-row">Not read</td>
                  <td className="h-row text-right tabular-nums">
                    {preview.skipped.length}
                  </td>
                </tr>
                <tr>
                  <td className="h-row">Differences</td>
                  <td className="h-row text-right tabular-nums">
                    {preview.reconciliation.length}
                  </td>
                </tr>
              </tbody>
            </table>

            {preview.reconciliation.length === 0 ? null : (
              <ul className="flex flex-col gap-0.5">
                {preview.reconciliation.map((row) => (
                  <li
                    key={`${row.investmentName}:${row.field}`}
                    className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
                  >
                    {row.investmentName} · {row.field} · sheet {row.stated} ·
                    entries {row.imported} · {row.difference}
                  </li>
                ))}
              </ul>
            )}

            {preview.skipped.length === 0 ? null : (
              <ul className="flex flex-col gap-0.5">
                {preview.skipped.map((row) => (
                  <li
                    key={`${row.line}:${row.reason}`}
                    className="truncate rounded-tag border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500"
                    title={row.raw}
                  >
                    {row.line} · {row.reason}
                  </li>
                ))}
              </ul>
            )}

            <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {preview.ledger.map((row, index) => (
                <li
                  key={row.importKey}
                  className="flex items-center gap-1 text-[11px]"
                >
                  <span className="w-20 shrink-0 tabular-nums text-gray-500">
                    {row.entryDate}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {row.investmentName}
                  </span>
                  <span className="tabular-nums">
                    {row.amount} {row.currency}
                  </span>
                  <button
                    type="button"
                    title={row.why}
                    onClick={() => flip(index)}
                    className="rounded-tag border border-gray-200 bg-gray-50 px-1.5 py-0.5 hover:border-gray-300"
                  >
                    {row.entryType}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {done === null ? null : (
            <span className="mr-auto text-[11px] text-gray-500">
              {done.investments} · {done.entries}
            </span>
          )}
          <button
            type="button"
            className={buttonClass}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={preview === null || busy}
            className={primaryButtonClass}
            onClick={async () => {
              if (preview === null) return;
              setBusy(true);
              try {
                setDone(await onImport(preview));
              } finally {
                setBusy(false);
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
    </Drawer>
  );
}
