import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Reusable primitives in the shadcn/ui style, styled to the burgundy redesign. Every colour
 * comes from the tokens in src/styles/theme-tokens.css (light + dark), never a hex value.
 */

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-m)] border border-transparent font-semibold leading-tight no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-60 min-h-11 px-[18px] text-[15px]",
  {
    variants: {
      variant: {
        primary: "bg-brand-600 text-on-brand hover:bg-brand-700",
        secondary: "border-brand-600 bg-surface text-link hover:bg-brand-50",
        ghost: "border-border-strong bg-transparent text-foreground hover:bg-sunken",
        danger: "bg-danger-fg text-background hover:opacity-90",
        link: "min-h-0 border-0 bg-transparent px-1 font-medium text-link underline",
      },
      size: {
        sm: "min-h-10 px-3 text-sm",
        md: "",
        lg: "min-h-14 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({ className, variant, size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-m)] border border-border bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-3 border-b border-border px-4 py-3.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-semibold", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-sm font-semibold", className)} {...props} />;
}

const fieldBase =
  "block w-full rounded-[var(--radius-m)] border border-border-strong bg-surface px-3 py-2.5 text-base text-foreground placeholder:text-muted focus:border-brand-600 focus:outline-2 focus:outline-offset-1 focus:outline-brand-500 aria-[invalid=true]:border-danger-fg";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, "min-h-11", className)} {...props} />;
});

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-28 resize-y leading-normal", className)} {...props} />;
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, "min-h-11 pr-8", className)} {...props} />;
}

export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[13px] font-medium text-danger-fg" role="alert">
      {message}
    </p>
  );
}

export function Hint({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] text-muted">
      {children}
    </p>
  );
}

// Alerts: tinted fill, coloured 4px left rule, body text in the normal foreground colour.
const alertVariants = cva("rounded-[var(--radius-m)] border-l-4 border-current px-3.5 py-3 text-sm [&>*]:text-foreground", {
  variants: {
    tone: {
      info: "bg-info-bg text-info-fg",
      success: "bg-ok-bg text-ok-fg",
      warning: "bg-warn-bg text-warn-fg",
      error: "bg-danger-bg text-danger-fg",
      neutral: "bg-sunken text-muted",
    },
  },
  defaultVariants: { tone: "info" },
});

export function Alert({ className, tone, children, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props}>
      <div>{children}</div>
    </div>
  );
}

/*
 * Badges always show their word (colour is never the only signal). The dot is decoration;
 * flags (Sensitive, Overdue, New…) get a diamond instead of a dot.
 * Old tone names (success/warning/purple) are kept as aliases of the new status pairs.
 */
export type BadgeTone = "info" | "ok" | "warn" | "danger" | "violet" | "neutral" | "brand" | "success" | "warning" | "purple";

const badgeTone: Record<BadgeTone, string> = {
  info: "bg-info-bg text-info-fg",
  ok: "bg-ok-bg text-ok-fg",
  success: "bg-ok-bg text-ok-fg",
  warn: "bg-warn-bg text-warn-fg",
  warning: "bg-warn-bg text-warn-fg",
  danger: "bg-danger-bg text-danger-fg",
  violet: "bg-violet-bg text-violet-fg",
  purple: "bg-violet-bg text-violet-fg",
  neutral: "bg-neutral-bg text-neutral-fg",
  brand: "bg-brand-100 text-link",
};

export function Badge({ className, tone = "neutral", flag = false, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone | null; flag?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-2 pr-2.5 text-xs font-semibold leading-relaxed",
        badgeTone[tone ?? "neutral"],
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 bg-current", flag ? "rotate-45 rounded-[1px]" : "rounded-full")} />
      {children}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-m)] border border-dashed border-border-strong bg-surface px-5 py-8 text-center">
      <p className="mx-auto max-w-[42ch] text-muted">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StatCard({ label, value, tone = "neutral", href }: { label: string; value: number | string; tone?: "neutral" | "warning" | "danger" | "success"; href?: string }) {
  const toneClass = { neutral: "text-foreground", warning: "text-warn-fg", danger: "text-danger-fg", success: "text-ok-fg" }[tone];
  const body = (
    <>
      <span className="block text-xs text-muted">{label}</span>
      <strong className={cn("mt-0.5 block text-2xl font-bold tabular-nums", toneClass)}>{value}</strong>
    </>
  );
  const cls = "block rounded-[var(--radius-m)] border border-border bg-surface px-3.5 py-3 text-inherit no-underline";
  return href ? (
    <a href={href} className={cn(cls, "hover:border-brand-600")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 max-w-[60ch] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Data tables scroll sideways inside their own frame on small screens. */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-m)] border border-border bg-surface">
      <table className={cn("w-full min-w-[900px] border-collapse text-left text-[13.5px] [&_tbody_tr:hover]:bg-brand-50", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("whitespace-nowrap border-b border-border bg-sunken px-3 py-2.5 text-xs font-semibold text-muted", className)} {...props} />;
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-border px-3 py-[11px] align-top", className)} {...props} />;
}

/** Vertical history timeline: a burgundy dot per entry joined by a thin line, newest first. */
export function Timeline({ items }: { items: Array<{ key: string; content: React.ReactNode; time: React.ReactNode }> }) {
  return (
    <ol className="m-0 list-none p-0">
      {items.map((it, i) => (
        <li key={it.key} className="relative pb-4 pl-[22px] text-sm last:pb-0">
          <span aria-hidden="true" className="absolute left-1 top-[7px] h-2 w-2 rounded-full bg-brand-600" />
          {i < items.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[7px] top-[17px] w-0.5 bg-border" />}
          <div className="break-words">{it.content}</div>
          <time className="block text-xs text-muted">{it.time}</time>
        </li>
      ))}
    </ol>
  );
}
