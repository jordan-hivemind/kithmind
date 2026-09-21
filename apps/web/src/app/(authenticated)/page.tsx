// Home is the fixed Your Data inventory. Its coverage loader continues to
// apply the same authenticated, authorized-space rules used by the former
// Coverage screen; this route merely presents that inventory in personal
// language rather than as an operator dashboard.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { KithDashboard } from "@/components/kith-dashboard";
import { loadCoverage } from "@/lib/kith/admin-data";

export default async function HomePage() {
  const data = await loadCoverage((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <KithDashboard initial={data} />;
}
