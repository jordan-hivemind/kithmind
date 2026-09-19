// `/admin/health`. One read transaction plus one archive read for the first
// paint, then the table keeps itself current off the change feed.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { HealthTable } from "@/components/admin/health-table";
import { loadHealth } from "@/lib/kith/admin-data";

export default async function AdminHealthPage() {
  const data = await loadHealth((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <HealthTable initial={data} />;
}
