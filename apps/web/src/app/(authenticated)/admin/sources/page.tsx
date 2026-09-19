// `/admin/sources`. One read transaction for the first paint, then the table
// keeps itself current off the change feed.

import { admin } from "@repo/kith-store";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SourcesTable } from "@/components/admin/sources-table";
import { loadSources } from "@/lib/kith/sources-data";

export default async function AdminSourcesPage() {
  const data = await loadSources((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  // The area list is a constant in the store and the table is a client
  // component: passing it down here is what keeps `pg` out of the bundle.
  return <SourcesTable initial={data} areas={admin.LIFE_AREAS} />;
}
