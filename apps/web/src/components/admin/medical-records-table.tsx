"use client";

// `/admin/medical`. The Epic MyChart feed's overview, one person at a time,
// read through the same session check every admin page repeats for itself.
//
// Not `/admin/health`: that path already belongs to ADM-2's "System Health"
// screen (see `apps/web/src/lib/kith/admin-data.ts`'s `loadHealth`).
//
// Rebuilt from first principles around what a person actually looks for: a
// "Current" section leads with active problems, active medications,
// allergies, the most recent lab report and the last encounter, and every
// history section below it is clickable into the same drawer
// (`medical-drawers.tsx`), including a lab result's own test-history drill
// down. Every table's free-text search is TanStack's global filter
// (`DataTable`'s own default), which already searches every field a row
// carries -- a lab report's `testsFull` and a condition's `occurrences`
// included -- so no per-screen search wiring lives here.
//
// Not on the change feed: `kith.health_*` carries no `kith.changes`
// triggers, the same reason the Balances screen is not (the Plaid/Epic feed
// tables are owner-global feed state, not entity/fact rows). Refetches on
// mount and window refocus, TanStack Query's default -- the right cadence
// for a feed a daily `pull` changes at most once a day.

import type { admin } from "@repo/kith-store";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { Button, inputClass, PageHeader, Section } from "@/components/ui/controls";
import { DataTable, Detail, Tag } from "@/components/ui/data-table";
import type { MedicalPageData } from "@/lib/kith/admin-data";
import { archiveDate } from "@/lib/kith/format";

import { type DrawerView, MedicalDrawer } from "./medical-drawers";
import { pulledStatusText, truncatedDetail } from "./medical-format";

type HealthOverviewPerson = admin.HealthOverviewPerson;
type LabReportGroup = admin.LabReportGroup;
type ConditionGroup = admin.ConditionGroup;
type MedicationRow = admin.MedicationRow;
type AllergyRow = admin.AllergyRow;
type EncounterRow = admin.EncounterRow;
type ImmunizationRow = admin.ImmunizationRow;
type VitalsDayGroup = admin.VitalsDayGroup;
type ClinicalNoteRow = admin.ClinicalNoteRow;

function date(value: string | null) {
  return <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>;
}

function statusTag(status: string | null) {
  if (status === null || status === "") return null;
  return <Tag>{status}</Tag>;
}

const DATE_COLUMN_META = { nowrap: true, align: "right" as const };

function labReportColumns(): ColumnDef<LabReportGroup, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name, header: "Report", size: 220 },
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
    {
      id: "results",
      accessorFn: (row) => row.resultCount,
      header: "Results",
      size: 80,
      meta: DATE_COLUMN_META,
    },
    {
      id: "tests",
      accessorFn: (row) => row.testsSummary,
      header: "Tests",
      size: 320,
      cell: ({ row }) => (
        <Detail
          label={row.original.testsSummary}
          detail={truncatedDetail(row.original.testsSummary, row.original.testsFull)}
        />
      ),
    },
    {
      id: "category",
      accessorFn: (row) => row.category ?? "",
      header: "Category",
      size: 100,
      cell: ({ row }) => statusTag(row.original.category),
    },
  ];
}

function conditionColumns(): ColumnDef<ConditionGroup, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name, header: "Condition", size: 220 },
    {
      id: "problemList",
      accessorFn: (row) => row.onProblemList,
      header: "List",
      size: 100,
      cell: ({ row }) =>
        row.original.onProblemList ? <Tag tone="accent">Problem list</Tag> : null,
    },
    {
      id: "status",
      accessorFn: (row) => row.status ?? "",
      header: "Status",
      size: 100,
      cell: ({ row }) => statusTag(row.original.status),
    },
    {
      id: "firstSeen",
      accessorFn: (row) => row.firstSeen ?? "",
      header: "First seen",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.firstSeen),
    },
    {
      id: "lastSeen",
      accessorFn: (row) => row.lastSeen ?? "",
      header: "Last seen",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.lastSeen),
    },
    {
      id: "occurrences",
      accessorFn: (row) => row.occurrenceCount,
      header: "Occurrences",
      size: 100,
      meta: DATE_COLUMN_META,
    },
  ];
}

function medicationColumns(): ColumnDef<MedicationRow, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Medication", size: 240 },
    {
      id: "status",
      accessorFn: (row) => row.status ?? "",
      header: "Status",
      size: 110,
      cell: ({ row }) => statusTag(row.original.status),
    },
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
  ];
}

function allergyColumns(): ColumnDef<AllergyRow, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Allergy", size: 220 },
    {
      id: "category",
      accessorFn: (row) => row.category ?? "",
      header: "Category",
      size: 120,
      cell: ({ row }) => statusTag(row.original.category),
    },
    {
      id: "criticality",
      accessorFn: (row) => row.criticality ?? "",
      header: "Criticality",
      size: 110,
      cell: ({ row }) => statusTag(row.original.criticality),
    },
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
  ];
}

function encounterColumns(): ColumnDef<EncounterRow, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Encounter", size: 220 },
    {
      id: "status",
      accessorFn: (row) => row.status ?? "",
      header: "Status",
      size: 110,
      cell: ({ row }) => statusTag(row.original.status),
    },
    {
      id: "category",
      accessorFn: (row) => row.category ?? "",
      header: "Category",
      size: 120,
      cell: ({ row }) => statusTag(row.original.category),
    },
    {
      id: "start",
      accessorFn: (row) => row.start ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.start),
    },
  ];
}

function immunizationColumns(): ColumnDef<ImmunizationRow, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Immunization", size: 240 },
    {
      id: "status",
      accessorFn: (row) => row.status ?? "",
      header: "Status",
      size: 110,
      cell: ({ row }) => statusTag(row.original.status),
    },
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
  ];
}

function vitalsColumns(): ColumnDef<VitalsDayGroup, unknown>[] {
  return [
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
    {
      id: "readings",
      accessorFn: (row) =>
        row.readings
          .map((reading) => reading.name)
          .filter((name): name is string => name !== null)
          .join(", "),
      header: "Readings",
      size: 320,
    },
    {
      id: "count",
      accessorFn: (row) => row.readings.length,
      header: "Count",
      size: 80,
      meta: DATE_COLUMN_META,
    },
  ];
}

function clinicalNoteColumns(): ColumnDef<ClinicalNoteRow, unknown>[] {
  return [
    { id: "title", accessorFn: (row) => row.title ?? "", header: "Note", size: 260 },
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: DATE_COLUMN_META,
      cell: ({ row }) => date(row.original.date),
    },
    {
      id: "type",
      accessorFn: (row) => row.type ?? "",
      header: "Type",
      size: 140,
      cell: ({ row }) => statusTag(row.original.type),
    },
  ];
}

async function fetchMedical(): Promise<MedicalPageData> {
  const response = await fetch("/api/kith/admin/medical", {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("medical fetch failed");
  return (await response.json()) as MedicalPageData;
}

function SourceLine({ sources }: { sources: readonly admin.HealthSourceSummary[] }) {
  if (sources.length === 0) {
    return <p className="mb-4 text-sm text-kith-text-muted">No linked source</p>;
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
      {sources.map((source, index) => (
        <div key={index} className="flex items-center gap-2">
          <span className="font-medium text-kith-text">{source.orgName}</span>
          <span className="text-kith-text-muted">{pulledStatusText(source.lastPulledAt)}</span>
          {source.needsReauthAt === null ? null : (
            <Tag tone="warn" title="A pull failed and only a new authorization can clear it">
              Needs reauthorization
            </Tag>
          )}
        </div>
      ))}
    </div>
  );
}

function CurrentList<T>({
  title,
  data,
  columns,
  empty,
  onRowClick,
}: {
  title: string;
  data: T[];
  columns: ColumnDef<T, unknown>[];
  empty: string;
  onRowClick: (row: T) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium tracking-wide text-kith-text-muted uppercase">
        {title}
      </h3>
      <DataTable
        id={`admin-medical-current-${title.toLowerCase().replace(/\s+/g, "-")}`}
        data={data}
        columns={columns}
        showSearch={false}
        empty={empty}
        onRowClick={onRowClick}
      />
    </div>
  );
}

function SummaryCard({
  title,
  primary,
  secondary,
  onClick,
}: {
  title: string;
  primary: string | null;
  secondary: React.ReactNode;
  onClick: (() => void) | null;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium tracking-wide text-kith-text-muted uppercase">
        {title}
      </h3>
      {primary === null || onClick === null ? (
        <p className="text-sm text-kith-text-muted">None</p>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full flex-col gap-0.5 rounded-control border border-kith-border-subtle bg-kith-surface p-3 text-left hover:bg-accent-50/60"
        >
          <span className="text-sm font-medium text-kith-text">{primary}</span>
          <span className="text-xs text-kith-text-muted">{secondary}</span>
        </button>
      )}
    </div>
  );
}

function PersonSection({ person }: { person: HealthOverviewPerson }) {
  const [view, setView] = useState<DrawerView | null>(null);
  const [showAllMedications, setShowAllMedications] = useState(false);

  const medicationRows = showAllMedications ? person.medications : person.current.activeMedications;
  const mostRecentLab = person.current.mostRecentLabReport;
  const lastEncounter = person.current.lastEncounter;

  return (
    <>
      <SourceLine sources={person.sources} />

      <Section id="current" title="Current">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <CurrentList
            title="Active problems"
            data={person.current.activeProblems}
            columns={conditionColumns()}
            empty="No active problems"
            onRowClick={(condition) => setView({ kind: "condition", condition })}
          />
          <CurrentList
            title="Active medications"
            data={person.current.activeMedications}
            columns={medicationColumns()}
            empty="No active medications"
            onRowClick={(medication) => setView({ kind: "medication", medication })}
          />
          <CurrentList
            title="Allergies"
            data={person.current.allergies}
            columns={allergyColumns()}
            empty="No known allergies"
            onRowClick={(allergy) => setView({ kind: "allergy", allergy })}
          />
          <SummaryCard
            title="Most recent lab report"
            primary={mostRecentLab?.name ?? null}
            secondary={mostRecentLab === null ? null : archiveDate(mostRecentLab.date)}
            onClick={
              mostRecentLab === null ? null : () => setView({ kind: "labReport", report: mostRecentLab })
            }
          />
          <SummaryCard
            title="Last encounter"
            primary={lastEncounter?.name ?? null}
            secondary={lastEncounter === null ? null : archiveDate(lastEncounter.start)}
            onClick={
              lastEncounter === null ? null : () => setView({ kind: "encounter", encounter: lastEncounter })
            }
          />
        </div>
      </Section>

      <Section id="lab-reports" title="Lab Results">
        <DataTable
          id="admin-medical-lab-reports"
          data={person.labReports}
          columns={labReportColumns()}
          filterColumns={["category"]}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search reports or tests"
          empty="No lab results"
          onRowClick={(report) => setView({ kind: "labReport", report })}
        />
      </Section>

      <Section id="conditions" title="Conditions">
        <DataTable
          id="admin-medical-conditions"
          data={person.conditions}
          columns={conditionColumns()}
          initialSorting={[
            { id: "problemList", desc: true },
            { id: "lastSeen", desc: true },
          ]}
          searchPlaceholder="Search conditions"
          empty="No conditions"
          onRowClick={(condition) => setView({ kind: "condition", condition })}
        />
      </Section>

      <Section
        id="medications"
        title="Medications"
        actions={
          <Button
            variant="secondary"
            onClick={() => setShowAllMedications((current) => !current)}
          >
            {showAllMedications ? "Active only" : "Show all"}
          </Button>
        }
      >
        <DataTable
          id="admin-medical-medications"
          data={medicationRows}
          columns={medicationColumns()}
          filterColumns={["status"]}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search medications"
          empty={showAllMedications ? "No medications" : "No active medications"}
          onRowClick={(medication) => setView({ kind: "medication", medication })}
        />
      </Section>

      <Section id="allergies" title="Allergies">
        <DataTable
          id="admin-medical-allergies"
          data={person.allergies}
          columns={allergyColumns()}
          searchPlaceholder="Search allergies"
          empty="No known allergies"
          onRowClick={(allergy) => setView({ kind: "allergy", allergy })}
        />
      </Section>

      <Section id="vitals" title="Vitals">
        <DataTable
          id="admin-medical-vitals"
          data={person.vitals}
          columns={vitalsColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search vitals"
          empty="No vitals"
          onRowClick={(day) => setView({ kind: "vitalsDay", day })}
        />
      </Section>

      <Section id="immunizations" title="Immunizations">
        <DataTable
          id="admin-medical-immunizations"
          data={person.immunizations}
          columns={immunizationColumns()}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search immunizations"
          empty="No immunizations"
          onRowClick={(immunization) => setView({ kind: "immunization", immunization })}
        />
      </Section>

      <Section id="encounters" title="Encounters">
        <DataTable
          id="admin-medical-encounters"
          data={person.encounters}
          columns={encounterColumns()}
          filterColumns={["category"]}
          initialSorting={[{ id: "start", desc: true }]}
          searchPlaceholder="Search encounters"
          empty="No encounters"
          onRowClick={(encounter) => setView({ kind: "encounter", encounter })}
        />
      </Section>

      <Section id="clinical-notes" title="Clinical Notes">
        <DataTable
          id="admin-medical-clinical-notes"
          data={person.clinicalNotes}
          columns={clinicalNoteColumns()}
          filterColumns={["type"]}
          initialSorting={[{ id: "date", desc: true }]}
          searchPlaceholder="Search notes"
          empty="No clinical notes"
          onRowClick={(note) => setView({ kind: "note", note })}
        />
      </Section>

      <MedicalDrawer
        view={view}
        labTests={person.labTests}
        onOpenChange={(open) => {
          if (!open) setView(null);
        }}
        onOpenView={setView}
      />
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
