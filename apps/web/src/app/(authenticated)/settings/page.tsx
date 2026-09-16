// The settings page, now a server component that picks a surface.
//
// Under `convex` it renders `ConvexSettings` verbatim; i7 deletes that path.
// Under `postgres` it loads the first paint from one read-only transaction
// (`loadSettings`) and hands it to `KithSettings`, whose mutations each reach
// `/api/kith/*` and reload the session there.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConvexSettings } from "@/components/convex-settings";
import { KithSettings } from "@/components/kith-settings";
import { loadSettings } from "@/lib/kith/settings-data";
import { kithPostgresSurface } from "@/lib/kith/surface";

export default async function SettingsPage() {
  if (kithPostgresSurface() !== "postgres") return <ConvexSettings />;

  const data = await loadSettings((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <KithSettings initial={data} />;
}
