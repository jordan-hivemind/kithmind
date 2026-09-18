// The settings page.
//
// It loads the first paint from one read-only transaction (`loadSettings`) and
// hands it to `KithSettings`, whose mutations each reach `/api/kith/*` and
// reload the session there.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { KithSettings } from "@/components/kith-settings";
import { loadSettings } from "@/lib/kith/settings-data";

export default async function SettingsPage() {
  const data = await loadSettings((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <KithSettings initial={data} />;
}
