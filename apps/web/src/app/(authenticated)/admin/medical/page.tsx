// `/admin/medical`. The Epic MyChart feed's overview, one person at a time,
// read through the same session check every admin page repeats for itself.
//
// Not `/admin/health`: that path already belongs to ADM-2's "System Health"
// screen (see `apps/web/src/lib/kith/admin-data.ts`'s `loadHealth`).

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { MedicalRecordsTable } from "@/components/admin/medical-records-table";
import { loadMedical } from "@/lib/kith/admin-data";

export default async function AdminMedicalPage() {
  const data = await loadMedical((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <MedicalRecordsTable initial={data} />;
}
