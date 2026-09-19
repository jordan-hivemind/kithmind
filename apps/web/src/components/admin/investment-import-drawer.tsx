"use client";

// The one-time spreadsheet import, as a drawer.
//
// The operator picks two CSV files (the `Summary` and `Ledger` tabs, exported
// from the sheet), sees exactly what will be created, flips any row whose type
// was read wrong, acknowledges anything that does not add up, and imports.
// Nothing leaves the browser until then: the parse, the reconciliation, the
// plan and the run all live in `lib/kith/investment-import.ts`, which is where
// their tests are.
//
// Two things this screen must never do, both of which it did once: import a
// row without saying what happened to it, and stop partway without saying it
// stopped. Every row ends up in the result list as created, already imported,
// or failed with a reason.

import { useMemo, useState } from "react";

import {
  buttonClass,
  Drawer,
  Field,
  inputClass,
  primaryButtonClass,
} from "@/components/ui/drawer";
import {
  buildPreview,
  IMPORT_REIMPORT_NOTE,
  IMPORT_RULE,
  type ImportOutcome,
  type ImportPreview,
  type LedgerDraft,
  planImport,
  roundToScale,
} from "@/lib/kith/investment-import";

export function ImportDrawer({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (preview: ImportPreview) => Promise<ImportOutcome>;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summaryCsv, setSummaryCsv] = useState("");
  const [ledgerCsv, setLedgerCsv] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  const rebuild = (summary: string, ledger: string) => {
    setSummaryCsv(summary);
    setLedgerCsv(ledger);
    setOutcome(null);
    setAcknowledged(false);
    setPreview(
      summary === "" && ledger === "" ? null : buildPreview(summary, ledger),
    );
  };

  const flip = (index: number) => {
    if (preview === null) return;
    setAcknowledged(false);
    setOutcome(null);
    setPreview({
      ...preview,
      ledger: preview.ledger.map((row, position) =>
        position !== index
          ? row
          : ({
              ...row,
              entryType:
                row.entryType === "capital_call_paid"
                  ? "distribution"
                  : "capital_call_paid",
            } satisfies LedgerDraft),
      ),
    });
  };

  // Recomputed from the preview the operator is looking at, so the counts
  // below are the counts of what will actually be sent.
  const plan = useMemo(
    () => (preview === null ? null : planImport(preview)),
    [preview],
  );

  // Anything that does not add up has to be acknowledged before Import is
  // enabled: not a warning to scroll past. These are the cases where the sheet
  // contradicts itself, and importing one silently is how a wrong total
  // becomes the system of record.
  const needsAcknowledgement =
    preview !== null &&
    (preview.reconciliation.length > 0 ||
      preview.suspectRates.length > 0 ||
      (plan?.invalid.length ?? 0) > 0);

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

        {preview === null || plan === null ? null : (
          <>
            {/* The rule the mapping applied, and what a re-import does. Shown
                because the operator is being asked to approve them, not merely
                told afterwards. */}
            <p className="rounded-tag border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-600">
              {IMPORT_RULE}
            </p>
            <p className="rounded-tag border border-gray-200 bg-gray-50 p-2 text-[11px] text-gray-600">
              {IMPORT_REIMPORT_NOTE}
            </p>

            <table className="w-full text-[11px]">
              <tbody>
                {(
                  [
                    ["Investments", preview.summary.length],
                    [
                      "Entries",
                      plan.operations.filter((row) => row.kind === "entry")
                        .length,
                    ],
                    ["Not read", preview.skipped.length],
                    ["Cannot import", plan.invalid.length],
                    ["Differences", preview.reconciliation.length],
                    ["Rate looks wrong", preview.suspectRates.length],
                  ] as const
                ).map(([label, count]) => (
                  <tr key={label} className="border-b border-gray-100">
                    <td className="h-row">{label}</td>
                    <td className="h-row text-right tabular-nums">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {preview.topLineCheck === null ? null : (
              <table className="w-full text-[11px]">
                <caption className="pb-1 text-left text-gray-500">
                  The sheet&apos;s own Total row, line {preview.topLineCheck.line}
                </caption>
                <tbody>
                  {(
                    ["committed", "sent", "received"] as const
                  ).map((field) => {
                    const check = preview.topLineCheck![field];
                    return (
                      <tr key={field} className="border-b border-gray-100">
                        <td className="h-row capitalize">{field}</td>
                        <td className="h-row text-right tabular-nums">
                          {check.totalRow ?? "—"}
                        </td>
                        <td className="h-row text-right tabular-nums text-gray-500">
                          rows sum to {check.summarySum}
                          {check.difference === null ? "" : ` (${check.difference})`}
                          {check.ledgerSum === null
                            ? ""
                            : `, Ledger sums to ${check.ledgerSum}` +
                              (check.ledgerDifference === null
                                ? ""
                                : ` (${check.ledgerDifference})`)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {preview.ledgerOnlyInvestments.length === 0 ? null : (
              <div className="flex flex-col gap-0.5">
                <p className="text-[11px] font-medium text-gray-700">
                  In the Ledger but not the Summary
                </p>
                {preview.ledgerOnlyInvestments.map((name) => (
                  <p
                    key={name}
                    className="rounded-tag border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500"
                  >
                    {name} — created with no commitment
                  </p>
                ))}
              </div>
            )}

            {preview.sentWithNoLedgerRows.length === 0 ? null : (
              <div className="flex flex-col gap-0.5">
                <p className="text-[11px] font-medium text-gray-700">
                  Sent amount has no Ledger rows
                </p>
                {preview.sentWithNoLedgerRows.map((row) => (
                  <p
                    key={row.investmentName}
                    className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
                  >
                    {row.line}: {row.investmentName} — sheet says sent{" "}
                    {row.amount} USD
                  </p>
                ))}
              </div>
            )}

            {preview.reconciliation.map((row) => (
              <p
                key={`${row.investmentName}:${row.field}`}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
              >
                {row.label}
              </p>
            ))}

            {preview.suspectRates.map((row) => (
              <p
                key={row.importKey}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
              >
                {row.line}: {row.investmentName} {row.amount} {row.currency} x{" "}
                {row.exchangeRate} = {row.rateCheck?.convertedUsd}, the sheet
                says {row.rateCheck?.sheetUsd} — rate looks inverted or wrong
              </p>
            ))}

            {plan.invalid.map((row) => (
              <p
                key={row.key}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800"
              >
                {row.label} — {row.reason}
              </p>
            ))}

            {preview.skipped.map((row) => (
              <p
                key={`${row.line}:${row.reason}`}
                className="truncate rounded-tag border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-500"
                title={row.raw}
              >
                {row.line} · {row.reason}
              </p>
            ))}

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
                    {row.occurrence > 1 ? ` (${row.occurrence})` : ""}
                  </span>
                  <span
                    className="tabular-nums"
                    title={
                      row.notes.length === 0 ? undefined : row.notes.join("; ")
                    }
                  >
                    {row.amount} {row.currency}
                    {/* Converted at this row's own rate, shown at cents. The
                        reconciliation adds the unrounded values, the way the
                        store does. */}
                    {row.currency === "USD"
                      ? ""
                      : ` → ${roundToScale(row.usdAmount, 2).value}`}
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

            {needsAcknowledgement ? (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-700">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                Import anyway
              </label>
            ) : null}
          </>
        )}

        {outcome === null ? null : (
          <div className="flex flex-col gap-0.5 text-[11px]">
            <p className="text-gray-700">
              {outcome.investmentsCreated} investments · {outcome.entriesCreated}{" "}
              entries · {outcome.entriesAlreadyImported} already imported ·{" "}
              {outcome.failed.length} failed
            </p>
            {outcome.failed.map((row) => (
              <p
                key={row.key}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-800"
              >
                {row.label} — {row.reason}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            className={buttonClass}
            onClick={() => onOpenChange(false)}
          >
            Close
          </button>
          <button
            type="button"
            disabled={
              preview === null || busy || (needsAcknowledgement && !acknowledged)
            }
            className={primaryButtonClass}
            onClick={async () => {
              if (preview === null) return;
              setBusy(true);
              try {
                setOutcome(await onImport(preview));
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
