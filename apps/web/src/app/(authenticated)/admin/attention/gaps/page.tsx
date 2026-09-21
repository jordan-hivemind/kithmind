import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { CoverageGapsTable } from "@/components/admin/coverage-gaps-table";
import { loadCoverageGaps } from "@/lib/kith/coverage-gaps-data";

export default async function CoverageGapsPage() {
  const data = await loadCoverageGaps((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <CoverageGapsTable initial={data} />;
}
