// The spaces page, now a server component that picks a surface.
//
// Under `convex` it renders `ConvexFamilySpaceManager` verbatim; i7 deletes
// that path. Under `postgres` it loads the caller's spaces, and the selected
// one's detail, from one read-only transaction (`loadFamilyOverview`) and
// hands them to `KithFamilySpaceManager`.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ConvexFamilySpaceManager } from "@/components/convex-family-space-manager";
import { KithFamilySpaceManager } from "@/components/kith-family-space-manager";
import { loadFamilyOverview } from "@/lib/kith/family-data";
import { kithPostgresSurface } from "@/lib/kith/surface";

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
  if (kithPostgresSurface() !== "postgres") {
    return (
      <Suspense fallback={<p>Loading...</p>}>
        <ConvexFamilySpaceManager />
      </Suspense>
    );
  }

  const params = await searchParams;
  const overview = await loadFamilyOverview(
    (await headers()).get("cookie"),
    one(params.space),
  );
  if (overview === null) redirect("/sign-in");
  return <KithFamilySpaceManager overview={overview} />;
}
