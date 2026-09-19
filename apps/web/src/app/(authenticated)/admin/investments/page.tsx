// `/admin/investments`. One read transaction for the first paint, then the
// table keeps itself current: optimistically for this tab's own writes, and
// off the change feed for everything else.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { InvestmentsTable } from "@/components/admin/investments-table";
import { loadInvestments } from "@/lib/kith/investments-data";

export default async function AdminInvestmentsPage() {
  const data = await loadInvestments((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return (
    <InvestmentsTable
      initial={data.investments}
      spaceId={data.spaceIds[0] ?? null}
    />
  );
}
