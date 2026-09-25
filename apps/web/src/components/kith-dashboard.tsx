import type { admin } from "@repo/kith-store";
import Link from "next/link";

import { PageHeader } from "@/components/ui/controls";
import { tableInteger } from "@/lib/kith/format";

type Area = admin.AreaCoverageRow;

const DATA_TYPES: readonly {
  area: string;
  label: string;
  href?: string;
}[] = [
  {
    area: "brokerage",
    label: "Investment Accounts",
    href: "/admin/institutions",
  },
  {
    area: "outside investments",
    label: "Private Investments",
    href: "/admin/investments",
  },
  { area: "banking and cards", label: "Banking & Cards" },
  { area: "taxes", label: "Taxes" },
  { area: "medical", label: "Medical", href: "/admin/medical" },
  { area: "vehicles", label: "Vehicles" },
  { area: "home and projects", label: "Home & Projects" },
  { area: "notes and facts", label: "Thoughts & Facts", href: "/browse" },
];

function count(value: number) {
  return <span className="tabular-nums">{tableInteger(value)}</span>;
}

/**
 * Home deliberately stays a small fixed inventory. Coverage gaps are not
 * shown as attention counts until they lead to the actionable queue required
 * by the information-architecture plan.
 */
export function KithDashboard({
  initial,
}: {
  initial: { areas: Area[]; truncated: boolean };
}) {
  const areas = new Map(initial.areas.map((area) => [area.area, area]));

  return (
    <div className="max-w-[960px]">
      <PageHeader title="Your Data" />
      <section className="kith-tile overflow-hidden" aria-label="Your Data">
        <table className="w-full text-[13.5px]">
          <thead className="border-b border-kith-border-subtle bg-kith-surface-subtle text-left text-kith-text-secondary">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Data type
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Documents
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Records
              </th>
            </tr>
          </thead>
          <tbody>
            {DATA_TYPES.map((dataType) => {
              const area = areas.get(dataType.area);
              return (
                <tr
                  key={dataType.area}
                  className="border-b border-kith-border-subtle last:border-b-0"
                >
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {dataType.href ? (
                      <Link
                        href={dataType.href}
                        className="text-accent-700 hover:text-accent-800 focus-visible:outline-2 focus-visible:outline-accent-600"
                      >
                        {dataType.label}
                      </Link>
                    ) : (
                      <span className="text-kith-text-secondary">
                        {dataType.label}
                      </span>
                    )}
                  </th>
                  <td className="px-4 py-2 text-right">
                    {count(area?.documents ?? 0)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {count(area?.records ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
