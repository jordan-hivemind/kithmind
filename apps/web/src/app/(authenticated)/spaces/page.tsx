// The spaces page.
//
// It loads the caller's spaces, and the selected one's detail, from one
// read-only transaction (`loadFamilyOverview`) and hands them to
// `KithFamilySpaceManager`.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { KithFamilySpaceManager } from "@/components/kith-family-space-manager";
import { loadFamilyOverview } from "@/lib/kith/family-data";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first || undefined;
}

export default async function SpacesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const overview = await loadFamilyOverview(
    (await headers()).get("cookie"),
    one(params.space),
  );
  if (overview === null) redirect("/sign-in");
  return <KithFamilySpaceManager overview={overview} />;
}
