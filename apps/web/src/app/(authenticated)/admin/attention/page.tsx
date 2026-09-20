// `/admin/attention`: the quiet, dismissible queue (ADM-8a). One read
// transaction for the first paint, then the table keeps itself current the
// same way `/admin/investments` does: optimistically for this tab's own
// writes, and off the change feed for everything else.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AttentionTable } from "@/components/admin/attention-table";
import { loadAttention } from "@/lib/kith/attention-data";

export default async function AdminAttentionPage() {
  const data = await loadAttention((await headers()).get("cookie"));
  if (data === null) redirect("/sign-in");
  return (
    <AttentionTable
      initial={{
        items: data.items,
        nextCursor: data.nextCursor,
        counts: data.counts,
      }}
      spaceId={data.spaceIds[0] ?? null}
    />
  );
}
