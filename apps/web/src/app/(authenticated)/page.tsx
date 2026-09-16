// The dashboard, now a server component that picks a surface.
//
// Under `convex` it renders `ConvexDashboard` verbatim; i7 deletes that path.
// Under `postgres` it loads `stats` and `recent` from one read-only
// transaction (`loadDashboard`, which checks the session itself rather than
// trusting the `(authenticated)` layout above it) and hands them to
// `KithDashboard`, a server component with no Convex import.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConvexDashboard } from "@/components/convex-dashboard";
import { KithDashboard } from "@/components/kith-dashboard";
import { loadDashboard } from "@/lib/kith/dashboard";
import { kithPostgresSurface } from "@/lib/kith/surface";

export default async function DashboardPage() {
  if (kithPostgresSurface() !== "postgres") return <ConvexDashboard />;

  const data = await loadDashboard((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <KithDashboard stats={data.stats} recent={data.recent} />;
}
