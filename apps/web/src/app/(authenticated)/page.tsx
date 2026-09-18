// The dashboard.
//
// It loads `stats` and `recent` from one read-only transaction
// (`loadDashboard`, which checks the session itself rather than trusting the
// `(authenticated)` layout above it) and hands them to `KithDashboard` as that
// component's initial poll value (i6): the first paint comes from this server
// component and every ten-second refresh after it comes from
// `GET /api/status/dashboard`, which calls the same `loadDashboard`.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { KithDashboard } from "@/components/kith-dashboard";
import { loadDashboard } from "@/lib/kith/dashboard";

export default async function DashboardPage() {
  const data = await loadDashboard((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <KithDashboard stats={data.stats} recent={data.recent} />;
}
