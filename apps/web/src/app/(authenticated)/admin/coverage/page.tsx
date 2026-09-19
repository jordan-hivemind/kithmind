// `/admin/coverage`. Life areas against what the system holds for them, with
// the empty ones listed rather than omitted.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { CoverageTable } from "@/components/admin/coverage-table";
import { loadCoverage } from "@/lib/kith/admin-data";

export default async function AdminCoveragePage() {
  const data = await loadCoverage((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <CoverageTable initial={data} />;
}
