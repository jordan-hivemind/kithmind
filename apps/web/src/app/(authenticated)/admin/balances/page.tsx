// `/admin/balances`. PLAID-1's daily feed of current balances and holdings,
// one row per linked account, read through the same session check every
// admin page repeats for itself.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { BalancesTable } from "@/components/admin/balances-table";
import { loadBalances } from "@/lib/kith/admin-data";

export default async function AdminBalancesPage() {
  const data = await loadBalances((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <BalancesTable initial={data} />;
}
