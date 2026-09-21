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

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { DataTable, Detail } from "@/components/ui/data-table";
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
import {
  archiveDate,
  label,
  tableDecimal,
  tableInteger,
} from "@/lib/kith/format";
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

type ImportSummaryRow = { id: string; metric: string; count: number };
type TopLineRow = {
  id: string;
  metric: string;
  totalRow: string | null;
  comparison: string;
};

const IMPORT_SUMMARY_COLUMNS: ColumnDef<ImportSummaryRow, unknown>[] = [
  { id: "metric", accessorKey: "metric", header: "Import" },
  {
    id: "count",
    accessorKey: "count",
    header: "Count",
    meta: { nowrap: true },
    cell: ({ row }) => (
      <span className="tabular-nums">{tableInteger(row.original.count)}</span>
    ),
  },
];

const TOP_LINE_COLUMNS: ColumnDef<TopLineRow, unknown>[] = [
  { id: "metric", accessorKey: "metric", header: "Total" },
  {
    id: "totalRow",
    accessorKey: "totalRow",
    header: "Sheet",
    meta: { nowrap: true },
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.totalRow === null
          ? "—"
          : tableDecimal(row.original.totalRow)}
      </span>
    ),
  },
  { id: "comparison", accessorKey: "comparison", header: "Comparison" },
];

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

  const importSummaryRows: ImportSummaryRow[] =
    preview === null || plan === null
      ? []
      : [
          {
            id: "investments",
            metric: "Investments",
            count: preview.summary.length,
          },
          {
            id: "entries",
            metric: "Entries",
            count: plan.operations.filter((row) => row.kind === "entry").length,
          },
          { id: "skipped", metric: "Not read", count: preview.skipped.length },
          {
            id: "invalid",
            metric: "Cannot import",
            count: plan.invalid.length,
          },
          {
            id: "differences",
            metric: "Differences",
            count: preview.reconciliation.length,
          },
          {
            id: "rates",
            metric: "Rate looks wrong",
            count: preview.suspectRates.length,
          },
        ];

  const topLineRows: TopLineRow[] =
    preview?.topLineCheck === null || preview === null
      ? []
      : (["committed", "sent", "received"] as const).map((field) => {
          const check = preview.topLineCheck![field];
          const comparison = [
            `Rows sum to ${tableDecimal(check.summarySum)}`,
            check.difference === null
              ? null
              : `difference ${tableDecimal(check.difference)}`,
            check.ledgerSum === null
              ? null
              : `Ledger sums to ${tableDecimal(check.ledgerSum)}`,
            check.ledgerDifference === null
              ? null
              : `Ledger difference ${tableDecimal(check.ledgerDifference)}`,
          ]
            .filter((value): value is string => value !== null)
            .join(" · ");
          return {
            id: field,
            metric: label(field),
            totalRow: check.totalRow,
            comparison,
          };
        });

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
            <p className="rounded-tag border border-gray-200 bg-gray-50 p-2 text-data text-gray-600">
              {IMPORT_RULE}
            </p>
            <p className="rounded-tag border border-gray-200 bg-gray-50 p-2 text-data text-gray-600">
              {IMPORT_REIMPORT_NOTE}
            </p>

            <DataTable
              id="investment-import-summary"
              data={importSummaryRows}
              columns={IMPORT_SUMMARY_COLUMNS}
              showSearch={false}
              empty="No import rows"
            />

            {preview.topLineCheck === null ? null : (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-kith-text-muted">
                  The sheet&apos;s own Total row, line{" "}
                  {tableInteger(preview.topLineCheck.line)}
                </p>
                <DataTable
                  id="investment-import-top-line"
                  data={topLineRows}
                  columns={TOP_LINE_COLUMNS}
                  showSearch={false}
                  empty="No totals"
                />
              </div>
            )}

            {preview.ledgerOnlyInvestments.length === 0 ? null : (
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-gray-700">
                  In the Ledger but not the Summary
                </p>
                {preview.ledgerOnlyInvestments.map((name) => (
                  <p
                    key={name}
                    className="rounded-tag border border-gray-200 px-1.5 py-0.5 text-meta text-gray-500"
                  >
                    {name} — created with no commitment
                  </p>
                ))}
              </div>
            )}

            {preview.sentWithNoLedgerRows.length === 0 ? null : (
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-gray-700">
                  Sent amount has no Ledger rows
                </p>
                {preview.sentWithNoLedgerRows.map((row) => (
                  <p
                    key={row.investmentName}
                    className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta text-amber-800"
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
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta text-amber-800"
              >
                {row.label}
              </p>
            ))}

            {preview.suspectRates.map((row) => (
              <p
                key={row.importKey}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta text-amber-800"
              >
                {row.line}: {row.investmentName} {row.amount} {row.currency} x{" "}
                {row.exchangeRate} = {row.rateCheck?.convertedUsd}, the sheet
                says {row.rateCheck?.sheetUsd} — rate looks inverted or wrong
              </p>
            ))}

            {plan.invalid.map((row) => (
              <p
                key={row.key}
                className="rounded-tag border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-meta text-amber-800"
              >
                {row.label} — {row.reason}
              </p>
            ))}

            {preview.skipped.map((row) => (
              <Detail
                key={`${row.line}:${row.reason}`}
                label={
                  <span className="block truncate rounded-tag border border-gray-200 px-1.5 py-0.5 text-meta text-gray-500">
                    {row.line} · {row.reason}
                  </span>
                }
                detail={row.raw}
              />
            ))}

            <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
              {preview.ledger.map((row, index) => (
                <li
                  key={row.importKey}
                  className="flex items-center gap-1 text-data"
                >
                  <span className="w-20 shrink-0 tabular-nums text-gray-500">
                    {archiveDate(row.entryDate)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {row.investmentName}
                    {row.occurrence > 1 ? ` (${row.occurrence})` : ""}
                  </span>
                  <Detail
                    label={
                      <span className="tabular-nums">
                        {tableDecimal(row.amount)} {row.currency}
                        {/* Converted at this row's own rate, shown at cents. The
                        reconciliation adds the unrounded values, the way the
                        store does. */}
                        {row.currency === "USD"
                          ? ""
                          : ` → ${tableDecimal(roundToScale(row.usdAmount, 2).value)}`}
                      </span>
                    }
                    detail={row.notes.join("; ")}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => flip(index)}
                        className="rounded-tag border border-gray-200 bg-gray-50 px-1.5 py-0.5 hover:border-gray-300"
                      >
                        {label(row.entryType)}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {row.why || label(row.entryType)}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>

            {needsAcknowledgement ? (
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
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
          <div className="flex flex-col gap-0.5 text-data">
            <p className="text-gray-700">
              {outcome.investmentsCreated} investments ·{" "}
              {outcome.entriesCreated} entries ·{" "}
              {outcome.entriesAlreadyImported} already imported ·{" "}
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
              preview === null ||
              busy ||
              (needsAcknowledgement && !acknowledged)
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
