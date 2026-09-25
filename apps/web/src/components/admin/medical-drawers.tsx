"use client";

// Every read-only drawer the Health Records page opens on a row click: one
// `DrawerView` union, one `Drawer` element that swaps its content as the
// view changes (a report drawer's own test row opens that test's history in
// the same drawer, rather than stacking a second overlay), and no raw FHIR
// jsonb anywhere -- every field here already came out of `medicalRecords.ts`
// typed.
//
// Read-only throughout: nothing here saves anything, so there is no `dirty`
// state and no discard-confirmation to wire up (`Drawer`'s own `dirty` prop
// defaults to false).

import type { admin } from "@repo/kith-store";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable, Tag } from "@/components/ui/data-table";
import { Drawer } from "@/components/ui/drawer";
import { archiveDate } from "@/lib/kith/format";

import { flagTone } from "./medical-format";

type LabReportGroup = admin.LabReportGroup;
type LabTestSeries = admin.LabTestSeries;
type LabResultItem = admin.LabResultItem;
type MedicationRow = admin.MedicationRow;
type ConditionGroup = admin.ConditionGroup;
type AllergyRow = admin.AllergyRow;
type EncounterRow = admin.EncounterRow;
type ImmunizationRow = admin.ImmunizationRow;
type VitalsDayGroup = admin.VitalsDayGroup;
type ClinicalNoteRow = admin.ClinicalNoteRow;

export type DrawerView =
  | { kind: "labReport"; report: LabReportGroup }
  | { kind: "labTest"; series: LabTestSeries }
  | { kind: "medication"; medication: MedicationRow }
  | { kind: "condition"; condition: ConditionGroup }
  | { kind: "allergy"; allergy: AllergyRow }
  | { kind: "encounter"; encounter: EncounterRow }
  | { kind: "immunization"; immunization: ImmunizationRow }
  | { kind: "vitalsDay"; day: VitalsDayGroup }
  | { kind: "note"; note: ClinicalNoteRow };

function date(value: string | null) {
  return <span className="tabular-nums text-gray-600">{archiveDate(value)}</span>;
}

function flagTag(flag: string | null) {
  const tone = flagTone(flag);
  if (tone === null) return null;
  return (
    <Tag tone={tone} title={`Reference range flag: ${flag}`}>
      {flag}
    </Tag>
  );
}

/** A compact `<dl>`: the only definition-list shape every read-only drawer
 * below uses. A row whose value is null or empty is left out entirely --
 * nothing here pads out a field FHIR never sent. */
function DefinitionList({
  rows,
}: {
  rows: Array<{ label: string; value: React.ReactNode }>;
}) {
  const present = rows.filter(
    (row) => row.value !== null && row.value !== undefined && row.value !== "",
  );
  if (present.length === 0) {
    return <p className="text-sm text-kith-text-muted">Nothing on file</p>;
  }
  return (
    <dl className="flex flex-col gap-3">
      {present.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium tracking-wide text-kith-text-muted uppercase">
            {row.label}
          </dt>
          <dd className="text-sm text-kith-text">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function resultColumns(): ColumnDef<LabResultItem, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Name", size: 200 },
    {
      id: "value",
      accessorFn: (row) => row.value ?? "",
      header: "Value",
      size: 90,
      meta: { nowrap: true, align: "right" },
    },
    { id: "unit", accessorFn: (row) => row.unit ?? "", header: "Unit", size: 80 },
    { id: "range", accessorFn: (row) => row.range ?? "", header: "Range", size: 130 },
    {
      id: "flag",
      accessorFn: (row) => row.flag ?? "",
      header: "Flag",
      size: 70,
      cell: ({ row }) => flagTag(row.original.flag),
    },
  ];
}

function LabReportDrawerContent({
  report,
  labTests,
  onOpenTest,
}: {
  report: LabReportGroup;
  labTests: readonly LabTestSeries[];
  onOpenTest: (series: LabTestSeries) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm text-kith-text-secondary">
        {date(report.date)}
        {report.category === null ? null : <Tag>{report.category}</Tag>}
      </div>
      <DataTable
        id="admin-medical-lab-report-results"
        data={report.results}
        columns={resultColumns()}
        initialSorting={[{ id: "name", desc: false }]}
        showSearch={false}
        empty="No results"
        onRowClick={(result) => {
          const series = labTests.find((candidate) => candidate.testKey === result.testKey);
          if (series !== undefined) onOpenTest(series);
        }}
      />
    </div>
  );
}

function testPointColumns(): ColumnDef<admin.LabTestPoint, unknown>[] {
  return [
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => date(row.original.date),
    },
    {
      id: "value",
      accessorFn: (row) => row.value ?? "",
      header: "Value",
      size: 90,
      meta: { nowrap: true, align: "right" },
    },
    { id: "unit", accessorFn: (row) => row.unit ?? "", header: "Unit", size: 80 },
    { id: "range", accessorFn: (row) => row.range ?? "", header: "Range", size: 130 },
    {
      id: "flag",
      accessorFn: (row) => row.flag ?? "",
      header: "Flag",
      size: 70,
      cell: ({ row }) => flagTag(row.original.flag),
    },
    {
      id: "report",
      accessorFn: (row) => row.reportName ?? "",
      header: "Report",
      size: 160,
    },
  ];
}

function LabTestDrawerContent({ series }: { series: LabTestSeries }) {
  return (
    <DataTable
      id="admin-medical-lab-test-history"
      data={series.points}
      columns={testPointColumns()}
      initialSorting={[{ id: "date", desc: true }]}
      showSearch={false}
      empty="No values on file"
    />
  );
}

function MedicationDrawerContent({ medication }: { medication: MedicationRow }) {
  return (
    <DefinitionList
      rows={[
        { label: "Status", value: medication.status === null ? null : <Tag>{medication.status}</Tag> },
        { label: "Authored", value: medication.date === null ? null : date(medication.date) },
        { label: "Dosage", value: medication.dosageText },
        { label: "Requested by", value: medication.requesterDisplay },
        { label: "Reason", value: medication.reasonText },
      ]}
    />
  );
}

function occurrenceColumns(): ColumnDef<admin.ConditionOccurrence, unknown>[] {
  return [
    {
      id: "date",
      accessorFn: (row) => row.date ?? "",
      header: "Date",
      size: 110,
      meta: { nowrap: true, align: "right" },
      cell: ({ row }) => date(row.original.date),
    },
    { id: "category", accessorFn: (row) => row.category ?? "", header: "Category", size: 150 },
    { id: "status", accessorFn: (row) => row.status ?? "", header: "Status", size: 100 },
    {
      id: "encounter",
      accessorFn: (row) => row.encounterFhirId ?? "",
      header: "Encounter",
      size: 140,
    },
  ];
}

function ConditionDrawerContent({ condition }: { condition: ConditionGroup }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {condition.onProblemList ? <Tag tone="accent">Problem list</Tag> : null}
        {condition.status === null ? null : <Tag>{condition.status}</Tag>}
      </div>
      <DataTable
        id="admin-medical-condition-occurrences"
        data={condition.occurrences}
        columns={occurrenceColumns()}
        initialSorting={[{ id: "date", desc: true }]}
        showSearch={false}
        empty="No occurrences"
      />
    </div>
  );
}

function AllergyDrawerContent({ allergy }: { allergy: AllergyRow }) {
  return (
    <DefinitionList
      rows={[
        { label: "Status", value: allergy.status === null ? null : <Tag>{allergy.status}</Tag> },
        { label: "Category", value: allergy.category },
        { label: "Criticality", value: allergy.criticality },
        { label: "Recorded", value: allergy.date === null ? null : date(allergy.date) },
        {
          label: "Reactions",
          value:
            allergy.reactions.length === 0 ? null : (
              <ul className="flex flex-col gap-1">
                {allergy.reactions.map((reaction, index) => (
                  <li key={index}>
                    {reaction.manifestation ?? "Unspecified"}
                    {reaction.severity === null ? "" : ` (${reaction.severity})`}
                  </li>
                ))}
              </ul>
            ),
        },
      ]}
    />
  );
}

function EncounterDrawerContent({ encounter }: { encounter: EncounterRow }) {
  return (
    <DefinitionList
      rows={[
        { label: "Status", value: encounter.status === null ? null : <Tag>{encounter.status}</Tag> },
        { label: "Category", value: encounter.category },
        { label: "Start", value: encounter.start === null ? null : date(encounter.start) },
        { label: "End", value: encounter.end === null ? null : date(encounter.end) },
      ]}
    />
  );
}

function ImmunizationDrawerContent({ immunization }: { immunization: ImmunizationRow }) {
  return (
    <DefinitionList
      rows={[
        {
          label: "Status",
          value: immunization.status === null ? null : <Tag>{immunization.status}</Tag>,
        },
        { label: "Date", value: immunization.date === null ? null : date(immunization.date) },
        { label: "Lot number", value: immunization.lotNumber },
      ]}
    />
  );
}

function readingColumns(): ColumnDef<admin.VitalsReading, unknown>[] {
  return [
    { id: "name", accessorFn: (row) => row.name ?? "", header: "Name", size: 180 },
    {
      id: "value",
      accessorFn: (row) => row.value ?? "",
      header: "Value",
      size: 90,
      meta: { nowrap: true, align: "right" },
    },
    { id: "unit", accessorFn: (row) => row.unit ?? "", header: "Unit", size: 80 },
    {
      id: "flag",
      accessorFn: (row) => row.flag ?? "",
      header: "Flag",
      size: 70,
      cell: ({ row }) => flagTag(row.original.flag),
    },
  ];
}

function VitalsDayDrawerContent({ day }: { day: VitalsDayGroup }) {
  return (
    <DataTable
      id="admin-medical-vitals-day"
      data={day.readings}
      columns={readingColumns()}
      showSearch={false}
      empty="No readings"
    />
  );
}

function NoteDrawerContent({ note }: { note: ClinicalNoteRow }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm text-kith-text-secondary">
        {date(note.date)}
        {note.type === null ? null : <Tag>{note.type}</Tag>}
      </div>
      {note.hasText ? (
        <div className="whitespace-pre-wrap rounded-control border border-kith-border-subtle bg-kith-surface-muted p-3 text-sm text-kith-text">
          {note.text}
        </div>
      ) : (
        <p className="text-sm text-kith-text-muted">
          {note.storageNote ?? "Note body not retrieved"}
        </p>
      )}
    </div>
  );
}

function drawerTitle(view: DrawerView): string {
  switch (view.kind) {
    case "labReport":
      return view.report.name;
    case "labTest":
      return view.series.name;
    case "medication":
      return view.medication.name ?? "Medication";
    case "condition":
      return view.condition.name;
    case "allergy":
      return view.allergy.name ?? "Allergy";
    case "encounter":
      return view.encounter.name ?? "Encounter";
    case "immunization":
      return view.immunization.name ?? "Immunization";
    case "vitalsDay":
      return view.day.date === null ? "Vitals" : archiveDate(view.day.date);
    case "note":
      return view.note.title ?? "Clinical note";
  }
}

/** The one drawer the whole page opens: `view` decides its title and
 * content, so drilling from a report into one of its tests replaces the
 * content in place rather than opening a second overlay. */
export function MedicalDrawer({
  view,
  labTests,
  onOpenChange,
  onOpenView,
}: {
  view: DrawerView | null;
  labTests: readonly LabTestSeries[];
  onOpenChange: (open: boolean) => void;
  onOpenView: (view: DrawerView) => void;
}) {
  if (view === null) return null;
  return (
    <Drawer open onOpenChange={onOpenChange} title={drawerTitle(view)}>
      {view.kind === "labReport" ? (
        <LabReportDrawerContent
          report={view.report}
          labTests={labTests}
          onOpenTest={(series) => onOpenView({ kind: "labTest", series })}
        />
      ) : view.kind === "labTest" ? (
        <LabTestDrawerContent series={view.series} />
      ) : view.kind === "medication" ? (
        <MedicationDrawerContent medication={view.medication} />
      ) : view.kind === "condition" ? (
        <ConditionDrawerContent condition={view.condition} />
      ) : view.kind === "allergy" ? (
        <AllergyDrawerContent allergy={view.allergy} />
      ) : view.kind === "encounter" ? (
        <EncounterDrawerContent encounter={view.encounter} />
      ) : view.kind === "immunization" ? (
        <ImmunizationDrawerContent immunization={view.immunization} />
      ) : view.kind === "vitalsDay" ? (
        <VitalsDayDrawerContent day={view.day} />
      ) : (
        <NoteDrawerContent note={view.note} />
      )}
    </Drawer>
  );
}
