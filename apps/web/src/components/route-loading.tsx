// Route-level loading fallbacks.
//
// These are server-safe components used by App Router `loading.tsx` files.
// They contain no timers or client fetches: Next can show them as soon as a
// navigation begins, while the destination's authorized server read runs.

function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-control bg-kith-surface-muted ${className}`}
    />
  );
}

function LoadingStatus({ label }: { label: string }) {
  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  );
}

export function AuthRouteLoading() {
  return (
    <main
      aria-busy="true"
      className="flex min-h-screen items-start justify-center bg-kith-page px-4 pt-24"
    >
      <LoadingStatus label="Loading page" />
      <div className="w-full max-w-sm rounded-panel border border-kith-border-subtle bg-kith-surface p-6 shadow-[var(--kith-shadow-md)]">
        <Bar className="h-7 w-28" />
        <div className="mt-5 flex flex-col gap-3">
          <Bar className="h-4 w-20" />
          <Bar className="h-10 w-full" />
          <Bar className="h-4 w-24" />
          <Bar className="h-10 w-full" />
          <Bar className="mt-2 h-10 w-full" />
        </div>
      </div>
    </main>
  );
}

export function PageRouteLoading({
  kind = "cards",
}: {
  kind?: "cards" | "dashboard" | "table";
}) {
  const table = kind === "table";
  return (
    <section aria-busy="true" aria-live="polite">
      <LoadingStatus label="Loading page" />
      <Bar className="h-8 w-40" />
      {kind === "dashboard" ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="kith-tile h-28 p-4">
              <Bar className="h-4 w-24" />
              <Bar className="mt-4 h-6 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <div className="kith-tile mt-5 overflow-hidden">
          <div className="kith-tile-header flex h-12 items-center px-4">
            <Bar className="h-5 w-32" />
          </div>
          {table ? <TableRows /> : <CardRows />}
        </div>
      )}
    </section>
  );
}

function CardRows() {
  return (
    <div className="space-y-4 p-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="space-y-2">
          <Bar className="h-4 w-2/5" />
          <Bar className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

function TableRows() {
  return (
    <div className="divide-y divide-kith-border-subtle">
      <div className="flex h-10 items-center gap-4 bg-kith-surface-muted px-4">
        <Bar className="h-3 w-24" />
        <Bar className="h-3 w-32" />
        <Bar className="ml-auto h-3 w-16" />
      </div>
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="flex h-row items-center gap-4 px-4">
          <Bar className="h-3 w-1/4" />
          <Bar className="h-3 w-2/5" />
          <Bar className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
