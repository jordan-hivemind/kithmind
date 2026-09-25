"use client";

// The Taxes screen (TAXES-1): tax_return/k1/tax_support documents by tax
// year, K-1s by issuer, and the existing manual tax payments, following
// docs/ui-style.md the same way `medical-records-table.tsx` does for the
// Health Records screen.
//
// Not on the change feed, for the same reason `medical-records-table.tsx`
// isn't: `kith.documents`, `kith.document_targeted_extractions` and
// `kith.tax_payments` carry no `kith.changes` triggers. Refetches on mount
// and window refocus, TanStack Query's default -- the right cadence for
// documents a daily ingest changes at most once a day and payments the owner
// records by hand.

import type { admin } from "@repo/kith-store";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { PageHeader, Section } from "@/components/ui/controls";
import { DataTable, Tag } from "@/components/ui/data-table";
import {
  type DocumentReference,
  DocumentViewer,
} from "@/components/ui/document-viewer";
import { Drawer } from "@/components/ui/drawer";
import type { TaxesPageData } from "@/lib/kith/admin-data";
import {
  archiveDate,
  label,
  tableAccountingMoney,
  tableInteger,
} from "@/lib/kith/format";

type TaxYearRow = admin.TaxYearRow;
type TaxDocumentRow = admin.TaxDocumentRow;
type TaxPayment = admin.TaxPayment;
type TaxPaymentStatusEvent = admin.TaxPaymentStatusEvent;

/** `null` is the "Unknown year" bucket -- every document in it has neither
 * an extracted nor a title-derived tax year. */
function yearLabel(taxYear: number | null): string {
  return taxYear === null ? "Unknown year" : String(taxYear);
}

function stateTag(active: boolean) {
  return (
    <Tag tone={active ? "accent" : "neutral"} title={active ? "Active document" : "Historical document"}>
      {active ? "active" : "historical"}
    </Tag>
  );
}

function docTypeTag(docType: TaxDocumentRow["docType"]) {
  const text = docType === "tax_return" ? "Return" : docType === "k1" ? "K-1" : "Support";
  return <Tag>{text}</Tag>;
}

async function fetchTaxes(): Promise<TaxesPageData> {
  const response = await fetch("/api/kith/admin/taxes", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("taxes fetch failed");
  return (await response.json()) as TaxesPageData;
}

function DocumentTitleButton({
  document,
  onOpen,
}: {
  document: TaxDocumentRow;
  onOpen: (document: DocumentReference) => void;
}) {
  return (
    <button
      type="button"
      data-row-click-ignore
      onClick={(event) => {
        event.stopPropagation();
        onOpen({ sourceItemId: document.sourceItemId, title: document.title });
      }}
      className="block w-full truncate text-left text-accent-700 underline-offset-2 hover:underline"
      title={document.title}
    >
      {document.title}
    </button>
  );
}

function DocumentGroup({
  title,
  documents,
  onOpen,
}: {
  title: string;
  documents: readonly TaxDocumentRow[];
  onOpen: (document: DocumentReference) => void;
}) {
  if (documents.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="mb-1.5 text-xs font-medium text-kith-text-secondary">
        {title} ({documents.length})
      </h3>
      <ul className="flex flex-col gap-1.5">
        {documents.map((document) => (
          <li
            key={document.id}
            className="flex items-center gap-2 rounded-control border border-kith-border-subtle px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <DocumentTitleButton document={document} onOpen={onOpen} />
            </div>
            {docTypeTag(document.docType)}
            {document.formType ? <Tag>{document.formType}</Tag> : null}
            <span className="whitespace-nowrap text-xs tabular-nums text-kith-text-secondary">
              {archiveDate(document.capturedAt)}
            </span>
            {stateTag(document.active)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusEventRow(event: TaxPaymentStatusEvent) {
  return (
    <li key={event.id} className="flex flex-wrap items-center gap-2 border-b border-kith-border-subtle py-1.5 last:border-b-0">
      <Tag tone={event.status === "settled" ? "accent" : event.status === "rejected" ? "warn" : "neutral"}>
        {label(event.status)}
      </Tag>
      <span className="tabular-nums text-xs text-kith-text-secondary">{archiveDate(event.effectiveOn)}</span>
      {event.correction ? <Tag tone="warn">correction</Tag> : null}
      <span className="text-xs text-kith-text-secondary">{event.reason}</span>
    </li>
  );
}

function YearDrawerContent({
  year,
  documents,
  onOpen,
}: {
  year: TaxYearRow;
  documents: readonly TaxDocumentRow[];
  onOpen: (document: DocumentReference) => void;
}) {
  const inYear = documents.filter((document) => document.taxYear === year.taxYear);
  const returns = inYear.filter((document) => document.docType === "tax_return");
  const k1s = inYear.filter((document) => document.docType === "k1");
  const support = inYear.filter((document) => document.docType === "tax_support");
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Tag title={`${year.paymentCount} tax payment${year.paymentCount === 1 ? "" : "s"}`}>
          Payments {tableInteger(year.paymentCount)}
        </Tag>
        {year.paymentTotals.map((total) => (
          <span key={total.currency} className="text-xs tabular-nums text-kith-text-secondary">
            {tableAccountingMoney(total.amount, total.currency)}
          </span>
        ))}
      </div>
      <DocumentGroup title="Returns" documents={returns} onOpen={onOpen} />
      <DocumentGroup title="K-1s" documents={k1s} onOpen={onOpen} />
      <DocumentGroup title="Supporting documents" documents={support} onOpen={onOpen} />
      {inYear.length === 0 ? (
        <p className="text-sm text-kith-text-muted">No documents for this year</p>
      ) : null}
    </>
  );
}

function PaymentDrawerContent({ payment }: { payment: TaxPayment }) {
  return (
    <>
      <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-kith-text-secondary">Payer</dt>
        <dd className="text-right">{payment.payer.name}</dd>
        <dt className="text-kith-text-secondary">Tax year</dt>
        <dd className="text-right tabular-nums">{payment.taxYear}</dd>
        <dt className="text-kith-text-secondary">Authority</dt>
        <dd className="text-right">{label(payment.authority)}</dd>
        <dt className="text-kith-text-secondary">Kind</dt>
        <dd className="text-right">{label(payment.paymentKind)}</dd>
        <dt className="text-kith-text-secondary">Amount</dt>
        <dd className="text-right tabular-nums">
          {tableAccountingMoney(payment.amount, payment.currency)}
        </dd>
        <dt className="text-kith-text-secondary">Submitted</dt>
        <dd className="text-right tabular-nums">{archiveDate(payment.submittedOn)}</dd>
        <dt className="text-kith-text-secondary">Status</dt>
        <dd className="text-right">
          <Tag>{label(payment.status)}</Tag>
        </dd>
        {payment.settledOn ? (
          <>
            <dt className="text-kith-text-secondary">Settled</dt>
            <dd className="text-right tabular-nums">{archiveDate(payment.settledOn)}</dd>
          </>
        ) : null}
        {payment.confirmationNumber ? (
          <>
            <dt className="text-kith-text-secondary">Confirmation</dt>
            <dd className="text-right">{payment.confirmationNumber}</dd>
          </>
        ) : null}
        {payment.eftTrace ? (
          <>
            <dt className="text-kith-text-secondary">EFT trace</dt>
            <dd className="text-right">{payment.eftTrace}</dd>
          </>
        ) : null}
      </dl>
      <h3 className="mb-1.5 text-xs font-medium text-kith-text-secondary">Status history</h3>
      <ul>{payment.statusHistory.map(statusEventRow)}</ul>
    </>
  );
}

function yearColumns(): ColumnDef<TaxYearRow, unknown>[] {
  return [
    {
      id: "year",
      header: "Year",
      size: 90,
      accessorFn: (row) => row.taxYear ?? -1,
      cell: ({ row }) => (
        <span className="tabular-nums">{yearLabel(row.original.taxYear)}</span>
      ),
    },
    {
      id: "returns",
      header: "Returns",
      size: 180,
      accessorFn: (row) => row.returnCount,
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <span className="tabular-nums">{tableInteger(row.original.returnCount)}</span>
          {row.original.returnFormTypes.map((formType) => (
            <Tag key={formType}>{formType}</Tag>
          ))}
        </div>
      ),
    },
    {
      id: "k1s",
      header: "K-1s",
      size: 80,
      accessorFn: (row) => row.k1Count,
      meta: { align: "right" },
      cell: ({ row }) => <span className="tabular-nums">{tableInteger(row.original.k1Count)}</span>,
    },
    {
      id: "support",
      header: "Supporting",
      size: 100,
      accessorFn: (row) => row.supportCount,
      meta: { align: "right" },
      cell: ({ row }) => <span className="tabular-nums">{tableInteger(row.original.supportCount)}</span>,
    },
    {
      id: "payments",
      header: "Tax Payments",
      size: 200,
      accessorFn: (row) => row.paymentCount,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <span className="tabular-nums">{tableInteger(row.original.paymentCount)}</span>
          {row.original.paymentTotals.map((total) => (
            <span key={total.currency} className="tabular-nums text-xs text-kith-text-secondary">
              {tableAccountingMoney(total.amount, total.currency)}
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "latest",
      header: "Latest Captured",
      size: 130,
      meta: { nowrap: true, align: "right" },
      accessorFn: (row) => row.latestCapturedAt ?? "",
      cell: ({ row }) => (
        <span className="tabular-nums">{archiveDate(row.original.latestCapturedAt)}</span>
      ),
    },
  ];
}

function k1Columns(): ColumnDef<TaxDocumentRow, unknown>[] {
  return [
    {
      id: "year",
      header: "Year",
      size: 70,
      accessorFn: (row) => row.taxYear ?? -1,
      cell: ({ row }) => <span className="tabular-nums">{yearLabel(row.original.taxYear)}</span>,
    },
    {
      id: "issuer",
      header: "Issuer",
      size: 240,
      accessorFn: (row) => row.issuer ?? "",
      cell: ({ row }) =>
        row.original.issuer ?? <span className="text-kith-text-muted">Unknown</span>,
    },
    {
      id: "title",
      header: "Title",
      size: 320,
      accessorFn: (row) => row.title,
    },
    {
      id: "captured",
      header: "Captured",
      size: 110,
      meta: { nowrap: true, align: "right" },
      accessorFn: (row) => row.capturedAt,
      cell: ({ row }) => (
        <span className="tabular-nums">{archiveDate(row.original.capturedAt)}</span>
      ),
    },
    {
      id: "state",
      header: "State",
      size: 100,
      accessorFn: (row) => (row.active ? "active" : "historical"),
      cell: ({ row }) => stateTag(row.original.active),
    },
  ];
}

function paymentColumns(): ColumnDef<TaxPayment, unknown>[] {
  return [
    { id: "year", header: "Year", size: 70, accessorFn: (row) => row.taxYear },
    {
      id: "authority",
      header: "Authority",
      size: 110,
      accessorFn: (row) => row.authority,
      cell: ({ row }) => label(row.original.authority),
    },
    {
      id: "kind",
      header: "Kind",
      size: 150,
      accessorFn: (row) => row.paymentKind,
      cell: ({ row }) => label(row.original.paymentKind),
    },
    {
      id: "amount",
      header: "Amount",
      size: 130,
      meta: { nowrap: true, align: "right" },
      accessorFn: (row) => row.amount,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {tableAccountingMoney(row.original.amount, row.original.currency)}
        </span>
      ),
    },
    {
      id: "submitted",
      header: "Submitted",
      size: 110,
      meta: { nowrap: true, align: "right" },
      accessorFn: (row) => row.submittedOn,
      cell: ({ row }) => (
        <span className="tabular-nums">{archiveDate(row.original.submittedOn)}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 120,
      accessorFn: (row) => row.status,
      cell: ({ row }) => <Tag>{label(row.original.status)}</Tag>,
    },
    {
      id: "confirmation",
      header: "Confirmation",
      size: 180,
      accessorFn: (row) => row.confirmationNumber ?? row.eftTrace ?? "",
    },
  ];
}

export function TaxesTable({ initial }: { initial: TaxesPageData }) {
  const { data } = useQuery({
    queryKey: ["taxes"],
    queryFn: fetchTaxes,
    initialData: initial,
  });

  const overview = data.overview;
  const [selectedYear, setSelectedYear] = useState<TaxYearRow | null>(null);
  const [selectedPayment, setSelectedPayment] = useState<TaxPayment | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentReference | null>(null);

  const k1s = useMemo(
    () => overview.documents.filter((document) => document.docType === "k1"),
    [overview.documents],
  );

  return (
    <>
      <PageHeader title="Taxes" />
      <Section id="tax-years" title="By Tax Year">
        <DataTable
          id="admin-taxes-years"
          data={overview.years}
          columns={yearColumns()}
          initialSorting={[{ id: "year", desc: true }]}
          searchPlaceholder="Search tax years"
          empty="No tax documents or payments"
          onRowClick={setSelectedYear}
        />
      </Section>
      <Section id="tax-k1s" title="K-1s">
        <DataTable
          id="admin-taxes-k1s"
          data={k1s}
          columns={k1Columns()}
          initialSorting={[{ id: "captured", desc: true }]}
          searchPlaceholder="Search K-1s"
          empty="No K-1s"
          onRowClick={(document) =>
            setSelectedDocument({ sourceItemId: document.sourceItemId, title: document.title })
          }
        />
      </Section>
      <Section id="tax-payments" title="Tax Payments">
        <DataTable
          id="admin-taxes-payments"
          data={overview.payments}
          columns={paymentColumns()}
          initialSorting={[{ id: "submitted", desc: true }]}
          searchPlaceholder="Search tax payments"
          empty="No tax payments"
          onRowClick={setSelectedPayment}
        />
      </Section>

      <Drawer
        open={selectedYear !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedYear(null);
        }}
        title={selectedYear === null ? "Tax year" : yearLabel(selectedYear.taxYear)}
      >
        {selectedYear === null ? null : (
          <YearDrawerContent
            year={selectedYear}
            documents={overview.documents}
            onOpen={setSelectedDocument}
          />
        )}
      </Drawer>

      <Drawer
        open={selectedPayment !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPayment(null);
        }}
        title="Tax Payment"
      >
        {selectedPayment === null ? null : <PaymentDrawerContent payment={selectedPayment} />}
      </Drawer>

      <DocumentViewer
        document={selectedDocument}
        open={selectedDocument !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedDocument(null);
        }}
      />
    </>
  );
}
