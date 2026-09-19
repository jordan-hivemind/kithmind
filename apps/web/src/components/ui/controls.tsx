// The form controls and page scaffolding the app pages share with the admin
// panel's look: square corners, 28px controls, one blue, gray text, and a
// visible focus ring. Class strings rather than a component library, so a
// caller that needs something slightly different passes `className`.

export const inputClass =
  "h-7 rounded-tag border border-gray-300 bg-white px-2 text-xs text-gray-900 outline-none focus:border-accent-600 focus:ring-1 focus:ring-accent-600 disabled:bg-gray-50 disabled:text-gray-500";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600";

const variants = {
  primary: "border-accent-600 bg-accent-600 text-white hover:bg-accent-700",
  secondary: "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
  danger: "border-red-200 bg-white text-red-700 hover:bg-red-50",
} as const;

export function buttonClass(variant: keyof typeof variants = "secondary"): string {
  return `inline-flex h-7 items-center justify-center rounded-tag border px-3 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${variants[variant]}`;
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
    <button type={type} className={`${buttonClass(variant)} ${className}`} {...props} />
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
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-gray-600">
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
    <div className="mb-4 flex min-h-7 flex-wrap items-center justify-between gap-3">
      <h1 className="text-base font-semibold text-gray-900">{title}</h1>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
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
    <section id={id} aria-labelledby={`${id}-heading`} className="mb-8 scroll-mt-4">
      <div className="mb-2 flex min-h-7 flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-1">
        <h2 id={`${id}-heading`} className="text-sm font-semibold text-gray-900">
          {title}
        </h2>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
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
    neutral: "border-gray-200 bg-gray-50",
    accent: "border-accent-200 bg-accent-50",
  } as const;
  return (
    <div className={`mb-3 rounded-tag border p-3 ${tones[tone]} ${className}`}>
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
    <main className="flex min-h-screen items-start justify-center bg-gray-50 px-4 pt-24">
      <div className="w-full max-w-sm rounded-tag border border-gray-200 bg-white p-6 text-sm text-gray-900">
        <h1 className="mb-4 text-base font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Inputs on the auth card are a size up from the table controls. */
export const authInputClass =
  "h-9 w-full rounded-tag border border-gray-300 bg-white px-2 text-sm text-gray-900 outline-none focus:border-accent-600 focus:ring-1 focus:ring-accent-600";

const authButtonBase = `inline-flex h-9 w-full items-center justify-center rounded-tag border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const authButtonClass = `${authButtonBase} ${variants.primary}`;

export const authSecondaryButtonClass = `${authButtonBase} ${variants.secondary}`;

export const linkClass =
  "text-accent-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent-600";
