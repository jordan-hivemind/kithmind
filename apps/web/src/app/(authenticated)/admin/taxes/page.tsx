// `/admin/taxes`. `tax_return`/`k1`/`tax_support` documents by tax year, K-1s
// by issuer, and the existing manual tax payments -- one read-only
// transaction for the first paint, the same shape every admin screen here
// uses.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { TaxesTable } from "@/components/admin/taxes-table";
import { loadTaxes } from "@/lib/kith/admin-data";

export default async function AdminTaxesPage() {
  const data = await loadTaxes((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return <TaxesTable initial={data} />;
}
