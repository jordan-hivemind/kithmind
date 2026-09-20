// The form controls and page scaffolding share Kith's semantic Stonewash,
// forest-action system, compact 32px controls, and visible focus treatment.
// Class strings let callers make small layout adjustments with `className`.

export const inputClass =
  "h-8 rounded-control border border-kith-border-subtle bg-kith-surface px-2.5 text-sm text-kith-text outline-none focus:border-kith-action focus:ring-1 focus:ring-kith-action disabled:bg-kith-surface-muted disabled:text-kith-text-muted";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600";

const variants = {
  primary:
    "border-kith-action bg-kith-action text-white hover:bg-kith-action-hover",
  secondary:
    "border-kith-border-subtle bg-kith-surface text-kith-text-secondary hover:bg-kith-surface-muted",
  danger: "border-red-200 bg-white text-red-700 hover:bg-red-50",
} as const;

export function buttonClass(
  variant: keyof typeof variants = "secondary",
): string {
  return `inline-flex h-8 items-center justify-center rounded-control border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${variants[variant]}`;
}

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
}) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant)} ${className}`}
      {...props}
    />
  );
}

/** A label above its control. */
export function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-kith-text-secondary"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <h1 className="kith-page-title">{title}</h1>
      {children ? (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

export function Section({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="kith-tile mb-8 overflow-hidden scroll-mt-4"
    >
      <div className="kith-tile-header mb-0 flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 py-2">
        <h2 id={`${id}-heading`} className="kith-section-title">
          {title}
        </h2>
        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A bordered panel for a form or a one-time value above a table. */
export function Panel({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent";
  className?: string;
}) {
  const tones = {
    neutral: "border-kith-border-subtle bg-kith-surface-muted",
    accent: "border-accent-200 bg-accent-50",
  } as const;
  return (
    <div className={`mb-3 rounded-card border p-4 ${tones[tone]} ${className}`}>
      {children}
    </div>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-xs text-red-700">
      {children}
    </p>
  );
}

/** The centred card the sign-in, sign-up, invite and consent pages share. */
export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-kith-page px-4 pt-24">
      <div className="w-full max-w-sm rounded-panel border border-kith-border-subtle bg-kith-surface p-6 text-kith-text shadow-[var(--kith-shadow-md)]">
        <h1 className="kith-page-title mb-5">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Inputs on the auth card are a size up from the table controls. */
export const authInputClass =
  "h-10 w-full rounded-control border border-kith-border-subtle bg-kith-surface px-3 text-sm text-kith-text outline-none focus:border-kith-action focus:ring-1 focus:ring-kith-action";

const authButtonBase = `inline-flex h-10 w-full items-center justify-center rounded-control border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const authButtonClass = `${authButtonBase} ${variants.primary}`;

export const authSecondaryButtonClass = `${authButtonBase} ${variants.secondary}`;

export const linkClass =
  "text-accent-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent-600";
