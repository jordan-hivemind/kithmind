// `/admin/banking`. The unified ledger's depository, credit and loan
// accounts, read through the same session check every admin page repeats
// for itself.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { BankingTable } from "@/components/admin/banking-table";
import { loadBanking } from "@/lib/kith/admin-data";

export default async function AdminBankingPage() {
  const data = await loadBanking((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <BankingTable initial={data} />;
}
