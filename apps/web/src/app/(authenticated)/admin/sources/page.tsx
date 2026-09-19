// `/admin/sources`. One read transaction for the first paint, then the table
// keeps itself current off the change feed.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SourcesTable } from "@/components/admin/sources-table";
import { loadSources } from "@/lib/kith/sources-data";

export default async function AdminSourcesPage() {
  const data = await loadSources((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <SourcesTable initial={data.sources} />;
}
