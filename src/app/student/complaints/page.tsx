import type { Metadata } from "next";
import Link from "next/link";
import { requireStudent } from "@/lib/auth/current";
import { listMyComplaints, type ComplaintListFilter } from "@/lib/services/student-complaints";
import { formatDate } from "@/lib/format";
import { COPY } from "@/config/app";
import { ComplaintStatusBadge } from "@/components/status";
import { buttonVariants, EmptyState } from "@/components/ui";
import { CategoryTile } from "@/components/student/CategoryTile";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "My complaints & suggestions" };

const FILTERS: { key: ComplaintListFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
];

export default async function MyComplaintsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const student = await requireStudent({ path: "/student/complaints" });
  const sp = await searchParams;
  const filter: ComplaintListFilter = sp.status === "open" || sp.status === "resolved" ? sp.status : "all";
  const q = (sp.q ?? "").slice(0, 100);
  const list = await listMyComplaints(student.id, { filter, q });
  const href = (f: ComplaintListFilter) => `/student/complaints?${new URLSearchParams({ ...(f !== "all" && { status: f }), ...(q && { q }) })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My complaints &amp; suggestions</h1>
          <p className="mt-1 text-[var(--muted)]">Open one to see its conversation with the Students&apos; Association.</p>
        </div>
        <Link href="/student/complaints/new" className={buttonVariants()}>
          New complaint or suggestion
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Filter" className="flex gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={href(f.key)}
              aria-current={filter === f.key ? "page" : undefined}
              className="flex min-h-10 items-center rounded-full border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)] aria-[current=page]:border-[var(--brand-600)] aria-[current=page]:bg-[var(--brand-600)] aria-[current=page]:text-white"
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <form role="search" className="ml-auto flex min-w-[220px] flex-1 gap-2 sm:max-w-[360px]">
          {filter !== "all" && <input type="hidden" name="status" value={filter} />}
          <label htmlFor="q" className="sr-only">
            Search my complaints and suggestions
          </label>
          <input id="q" name="q" defaultValue={q} placeholder="Search" className="min-h-10 min-w-0 flex-1 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-base" />
          <button className={buttonVariants({ variant: "secondary", size: "sm", className: "min-h-10" })}>Search</button>
        </form>
      </div>

      {list.length === 0 ? (
        <EmptyState title={q || filter !== "all" ? "Nothing matches." : COPY.emptyDashboard}>
          {q || filter !== "all" ? <Link href="/student/complaints">Show everything</Link> : <Link href="/student/complaints/new">Start a complaint or suggestion</Link>}
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {list.map((c) => (
            <li key={c.id} className="border-b border-[var(--border)] last:border-0">
              <Link href={`/student/complaints/${c.id}`} className="flex items-start gap-3 px-3 py-3.5 text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)] sm:px-4">
                <CategoryTile category={c.category} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <b className={cn("break-words text-[15px] leading-snug", c.unread ? "font-bold" : "font-semibold")}>{c.subject}</b>
                    {c.unread && (
                      <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--brand-600)]">
                        <span className="sr-only">New activity</span>
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-[var(--muted)]">
                    {c.category} · {formatDate(c.created_at)}
                  </span>
                  {c.preview && <span className="mt-1 block truncate text-sm text-[var(--muted)]">{c.preview}</span>}
                  <span className="mt-1.5 block">
                    <ComplaintStatusBadge status={c.status} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
