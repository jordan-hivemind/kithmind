// `/admin/institutions`. The finance archive's own account inventory, read
// through its read contract and its reader role, grouped by institution.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { InstitutionsTable } from "@/components/admin/institutions-table";
import { loadInstitutions } from "@/lib/kith/admin-data";

export default async function AdminInstitutionsPage() {
  const data = await loadInstitutions((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <InstitutionsTable initial={data} />;
}
