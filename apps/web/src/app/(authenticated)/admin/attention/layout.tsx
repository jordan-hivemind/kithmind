import { CoverageGapsNav } from "@/components/admin/coverage-gaps-nav";

export default function AttentionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <CoverageGapsNav />
      {children}
    </div>
  );
}
