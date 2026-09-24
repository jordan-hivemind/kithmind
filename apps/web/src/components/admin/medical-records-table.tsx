"use client";

// Epic MyChart feed's screen (migration 053_health_feed.sql): a person
// selector, then one compact table per section, following docs/ui-style.md.
// Named `medical-records-table.tsx` and served at `/admin/medical` rather
// than reusing "health" -- `admin/health.ts`, the "System Health" screen and
// `/admin/health` already own that name for watcher/processing state, not
// patient data.
//
// Not on the change feed: `kith.health_*` carries no `kith.changes` triggers,
// the same reason the Balances screen is not (the Plaid/Epic feed tables are
// owner-global feed state, not entity/fact rows). Refetches on mount and
// window refocus, TanStack Query's default -- the right cadence for a feed a
// daily `pull` changes at most once a day.

import type { admin } from "@repo/kith-store";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { inputClass, PageHeader, Section } from "@/components/ui/controls";
import { DataTable, Tag } from "@/components/ui/data-table";
import type { MedicalPageData } from "@/lib/kith/admin-data";
import { archiveDate } from "@/lib/kith/format";

type HealthRecordSummary = admin.HealthRecordSummary;
type HealthOverviewPerson = admin.HealthOverviewPerson;

function date(value: string | null) {
  return <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>;
}

function flagTag(flag: string | null) {
  if (flag === null || flag === "") return null;
  const abnormal = flag.toUpperCase() !== "N";
  return (
    <Tag tone={abnormal ? "warn" : "neutral"} title={`Reference range flag: ${flag}`}>
      {flag}
    </Tag>
  );
}

const NAME_COLUMN: ColumnDef<HealthRecordSummary, unknown> = {
  id: "name",
  accessorFn: (row) => row.name ?? "",
  header: "Name",
  size: 220,
};

const STATUS_COLUMN: ColumnDef<HealthRecordSummary, unknown> = {
  id: "status",
  accessorFn: (row) => row.status ?? "",
  header: "Status",
  size: 110,
};

const DATE_COLUMN: ColumnDef<HealthRecordSummary, unknown> = {
  id: "date",
  accessorFn: (row) => row.date ?? "",
  header: "Date",
  size: 110,
  meta: { nowrap: true, align: "right" },
  cell: ({ row }) => date(row.original.date),
};

function labResultColumns(): ColumnDef<HealthRecordSummary, unknown>[] {
  return [
    NAME_COLUMN,
    {
      id: "value",
      accessorFn: (row) => row.value ?? "",
      header: "Value",
      size: 100,
      meta: { nowrap: true, align: "right" },
    },
    {
      id: "unit",
      accessorFn: (row) => row.unit ?? "",
      header: "Unit",
      size: 90,
    },
    {
      id: "flag",
      accessorFn: (row) => row.flag ?? "",
      header: "Flag",
      size: 80,
      cell: ({ row }) => flagTag(row.original.flag),
    },
    DATE_COLUMN,
  ];
}

function simpleColumns(): ColumnDef<HealthRecordSummary, unknown>[] {
  return [NAME_COLUMN, STATUS_COLUMN, DATE_COLUMN];
}

function immunizationColumns(): ColumnDef<HealthRecordSummary, unknown>[] {
  return [NAME_COLUMN, DATE_COLUMN];
}

async function fetchMedical(): Promise<MedicalPageData> {
  const response = await fetch("/api/kith/admin/medical", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("medical fetch failed");
  return (await response.json()) as MedicalPageData;
}

function PersonSection({ person }: { person: HealthOverviewPerson }) {
  const counts = Object.entries(person.countsByType).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {counts.map(([type, count]) => (
          <Tag key={type} title={`${count} ${type} record${count === 1 ? "" : "s"}`}>
            {type} {count}
          </Tag>
        ))}
        <Tag title={`${person.documentsCount} document${person.documentsCount === 1 ? "" : "s"}`}>
          Documents {person.documentsCount}
        </Tag>
      </div>
      <Section id="lab-results" title="Lab Results">
        <DataTable
          id="admin-medical-labs"
          data={person.labResults}
          columns={labResultColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search lab results"
          empty="No lab results"
          showSearch={false}
        />
      </Section>
      <Section id="medications" title="Active Medications">
        <DataTable
          id="admin-medical-medications"
          data={person.activeMedications}
          columns={simpleColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          empty="No active medications"
          showSearch={false}
        />
      </Section>
      <Section id="conditions" title="Conditions">
        <DataTable
          id="admin-medical-conditions"
          data={person.conditions}
          columns={simpleColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          empty="No conditions"
          showSearch={false}
        />
      </Section>
      <Section id="immunizations" title="Immunizations">
        <DataTable
          id="admin-medical-immunizations"
          data={person.immunizations}
          columns={immunizationColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          empty="No immunizations"
          showSearch={false}
        />
      </Section>
      <Section id="encounters" title="Recent Encounters">
        <DataTable
          id="admin-medical-encounters"
          data={person.encounters}
          columns={simpleColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          empty="No encounters"
          showSearch={false}
        />
      </Section>
    </>
  );
}

export function MedicalRecordsTable({ initial }: { initial: MedicalPageData }) {
  const { data } = useQuery({
    queryKey: ["medical"],
    queryFn: fetchMedical,
    initialData: initial,
  });

  const people = data.overview.people;
  const [selectedId, setSelectedId] = useState<string | null>(
    people[0]?.personId ?? null,
  );
  const selected = useMemo(
    () => people.find((person) => person.personId === selectedId) ?? people[0] ?? null,
    [people, selectedId],
  );

  return (
    <>
      <PageHeader title="Health Records">
        {people.length > 0 ? (
          <select
            className={inputClass}
            value={selected?.personId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {people.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.personName}
              </option>
            ))}
          </select>
        ) : null}
      </PageHeader>
      {selected === null ? (
        <p className="text-sm text-kith-text-muted">No linked Epic sources</p>
      ) : (
        <PersonSection key={selected.personId} person={selected} />
      )}
    </>
  );
}
