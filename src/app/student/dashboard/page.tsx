import type { Metadata } from "next";
import Link from "next/link";
import { COPY } from "@/config/app";
import { requireStudent } from "@/lib/auth/current";
import { getStudentDashboard, recentActivity, type ActivityItem } from "@/lib/services/student-complaints";
import { getUnreadMessageCount } from "@/lib/services/messages";
import { countUnreadMemos } from "@/lib/services/memos";
import { COMPLAINT_STATUS_LABELS, partOfDay, relativeTime } from "@/lib/format";
import { ComplaintStatusBadge } from "@/components/status";
import { Alert, EmptyState } from "@/components/ui";
import { Icon, type IconName } from "@/components/ui/Icon";
import { CategoryTile } from "@/components/student/CategoryTile";

export const metadata: Metadata = { title: "Home" };

const AWAITING = ["received", "under_review", "review_requested"];
const PROGRESS = ["in_progress", "awaiting_external_action"];
const RESOLVED = ["resolved", "closed"];

function activityText(a: ActivityItem): string {
  if (a.kind === "reply") return "The Student Union replied";
  if (a.kind === "update") return "An update was published";
  return a.detail === "resolved" ? "Marked as resolved" : `Status changed to ${COMPLAINT_STATUS_LABELS[a.detail ?? ""] ?? a.detail}`;
}

export default async function StudentHomePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const student = await requireStudent({ path: "/student/dashboard" });
  const { welcome } = await searchParams;
  const [all, activity, unreadMessages, unreadMemos] = await Promise.all([
    getStudentDashboard(student.id),
    recentActivity(student.id),
    getUnreadMessageCount(student.id),
    countUnreadMemos(student.id),
  ]);
  const kpis: { label: string; value: number; icon: IconName; tint: string; href: string }[] = [
    { label: "Total", value: all.length, icon: "inbox", tint: "bg-[var(--neutral-bg)] text-[var(--neutral-fg)]", href: "/student/complaints" },
    { label: "Awaiting review", value: all.filter((c) => AWAITING.includes(c.status)).length, icon: "hour", tint: "bg-[var(--info-bg)] text-[var(--info-fg)]", href: "/student/complaints?status=open" },
    { label: "In progress", value: all.filter((c) => PROGRESS.includes(c.status)).length, icon: "clock", tint: "bg-[var(--warn-bg)] text-[var(--warn-fg)]", href: "/student/complaints?status=open" },
    { label: "Resolved", value: all.filter((c) => RESOLVED.includes(c.status)).length, icon: "check", tint: "bg-[var(--ok-bg)] text-[var(--ok-fg)]", href: "/student/complaints?status=resolved" },
  ];

  return (
    <div className="space-y-5">
      {welcome && <Alert tone="success">Welcome! Remember your username — it is all you need to come back to your complaints and suggestions.</Alert>}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Good {partOfDay()}, {student.username}
        </h1>
        <p className="mt-1 text-[var(--muted)]">Here&apos;s where your complaints and suggestions stand today.</p>
      </div>

      <ul className="grid grid-cols-2 gap-3 min-[860px]:grid-cols-4">
        {kpis.map((k) => (
          <li key={k.label}>
            <Link href={k.href} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[var(--foreground)] no-underline hover:border-[var(--brand-200)]">
              <span aria-hidden="true" className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${k.tint}`}>
                <Icon name={k.icon} />
              </span>
              <span className="leading-tight">
                <b className="block text-2xl font-bold tabular-nums">{k.value}</b>
                <span className="text-xs text-[var(--muted)]">{k.label}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="grid gap-3 min-[860px]:grid-cols-[1.4fr_1fr]">
        <section className="flex flex-col justify-between gap-4 rounded-xl bg-[var(--brand-600)] p-5 text-white">
          <div>
            <h2 className="text-lg font-bold">Something not right? Or an idea to make things better?</h2>
            <p className="mt-1 text-sm text-[#F3E3E8]">Chat it in. It takes under a minute, and you&apos;ll get every reply in one place.</p>
          </div>
          <Link href="/student/complaints/new" className="flex min-h-11 w-fit items-center gap-2 rounded-lg bg-white px-5 font-bold text-[var(--brand-800)] no-underline hover:bg-[#FBEFF2]">
            <Icon name="plus" />
            Start a complaint or suggestion
          </Link>
        </section>
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="mb-2 text-base font-semibold">Quick links</h2>
          <ul className="grid">
            {[
              { href: "/student/complaints/new", icon: "plus" as const, label: "Start a complaint or suggestion", n: 0 },
              { href: "/student/messages", icon: "bell" as const, label: "Notifications", n: unreadMessages },
              { href: "/memos", icon: "memo" as const, label: "Union memos", n: unreadMemos },
              { href: "/privacy", icon: "shield" as const, label: "How your privacy works", n: 0 },
            ].map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="flex min-h-11 items-center gap-2.5 rounded-md px-1.5 text-sm text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)]">
                  <Icon name={l.icon} className="text-[var(--link)]" />
                  <span className="flex-1">{l.label}</span>
                  {l.n > 0 && <span className="rounded-full bg-[var(--brand-600)] px-2 text-xs font-semibold text-white">{l.n} new</span>}
                  <Icon name="chev" size={16} className="text-[var(--muted)]" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section>
        <h2 className="mb-2.5 text-base font-semibold">Recent activity</h2>
        {all.length === 0 ? (
          <EmptyState title={COPY.emptyDashboard} />
        ) : activity.length === 0 ? (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
            Nothing new yet. Replies and updates from the Student Union will show up here.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {activity.map((a, i) => (
              <li key={i} className="border-b border-[var(--border)] last:border-0">
                <Link href={`/student/complaints/${a.complaint_id}`} className="flex items-center gap-3 px-3 py-3 text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)] sm:px-4">
                  <CategoryTile category={a.category} size={36} />
                  <span className="min-w-0 flex-1">
                    <b className="block text-sm font-semibold">{activityText(a)}</b>
                    <span className="block truncate text-xs text-[var(--muted)]">
                      {a.subject} · {relativeTime(a.at)}
                    </span>
                  </span>
                  <span className="hidden sm:block">
                    <ComplaintStatusBadge status={a.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {all.length > 0 && (
          <p className="mt-3 text-sm">
            <Link href="/student/complaints">See all my complaints and suggestions</Link>
          </p>
        )}
      </section>
    </div>
  );
}
