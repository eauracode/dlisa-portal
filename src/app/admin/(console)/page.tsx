import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { getOverview, type NeedsReplyReason } from "@/lib/services/admin/overview";
import { formatDateTime, relativeTime } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { ComplaintStatusBadge, IssueStatusBadge, PriorityBadge } from "@/components/status";
import { Alert, Badge, type BadgeTone, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, StatCard } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LiveRefresh } from "@/components/auto-refresh";
import { endOfDay, FilterBar, filterOptions, parseDate, parseDepartment } from "./filters";

export const metadata: Metadata = { title: "Staff overview" };

type SP = Promise<Record<string, string | undefined>>;

const REASON: Record<NeedsReplyReason, { label: string; tone: BadgeTone }> = {
  not_helpful: { label: "Answer not helpful", tone: "danger" },
  review_requested: { label: "Asked for a review", tone: "warn" },
  unread: { label: "New message", tone: "info" },
  not_answered: { label: "Not answered yet", tone: "neutral" },
};

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

export default async function AdminOverviewPage({ searchParams }: { searchParams: SP }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const { categories, officers } = await filterOptions();
  const data = await getOverview(pool(), admin, {
    from: parseDate(sp.from),
    to: endOfDay(sp.to),
    categoryId: sp.category ? Number(sp.category) || undefined : undefined,
    priority: sp.priority || undefined,
    status: sp.status || undefined,
    assigned: sp.assigned === "unassigned" ? "unassigned" : uuidSchema.safeParse(sp.assigned).success ? sp.assigned : undefined,
    department: parseDepartment(sp.department),
  });
  const s = data.stats;
  const m = data.messages;
  const rated = m.helpful + m.not_helpful;
  const scopeNote =
    admin.role === "case_officer"
      ? "Showing submissions on issues assigned to you."
      : admin.role === "oversight_officer"
        ? "Showing issues escalated to school management."
        : "Showing all submissions and issues.";

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} denied={sp.denied} />
      <LiveRefresh versionUrl="/api/admin/activity-version" />
      <PageHeader title="Overview" description={scopeNote} />
      <FilterBar params={sp} categories={categories} officers={officers} showOfficer={admin.role === "union_admin"} />

      {admin.role === "union_admin" && (data.pendingReviews > 0 || data.failedMatches > 0) && (
        <Alert tone="warning" className="mb-6">
          {data.pendingReviews > 0 && (
            <>
              <Link href="/admin/match-review" className="font-medium underline">
                {data.pendingReviews} possible match{data.pendingReviews === 1 ? "" : "es"}
              </Link>{" "}
              to confirm (45–60% similar).{" "}
            </>
          )}
          {data.failedMatches > 0 && (
            <>
              <Link href="/admin/complaints?match=failed" className="font-medium underline">
                {data.failedMatches} submission{data.failedMatches === 1 ? "" : "s"}
              </Link>{" "}
              could not be grouped automatically and need manual grouping.
            </>
          )}
        </Alert>
      )}

      <h2 className="mb-2 text-sm font-semibold text-muted">Messages from students</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        <StatCard label="Submissions received" value={m.submissions} href="/admin/complaints" />
        <StatCard label="Waiting for a reply" value={m.needs_reply} tone={m.needs_reply ? "danger" : "success"} href="#waiting" />
        <StatCard label={`Answered instantly (${pct(m.answered_instantly, m.submissions)})`} value={m.answered_instantly} />
        <StatCard label={`Instant answers helpful (${pct(m.helpful, rated)})`} value={`${m.helpful} / ${rated}`} tone={m.not_helpful > m.helpful ? "warning" : "neutral"} />
        <StatCard label="In progress" value={m.in_progress} tone="warning" href="/admin/complaints?status=in_progress" />
        <StatCard label="Resolved" value={m.resolved} tone="success" href="/admin/complaints?status=resolved" />
        <StatCard label="Chat replies sent" value={m.staff_replies} href="/admin/messages?tab=conversations" />
        <StatCard label="Messages & memos sent" value={m.messages_sent} href="/admin/messages?tab=bulk" />
      </div>

      <div className="mt-4 grid items-start gap-4 min-[1000px]:grid-cols-[1.5fr_1fr]">
        <Card id="waiting">
          <CardHeader>
            <CardTitle>Students waiting for a reply</CardTitle>
            <p className="text-xs text-muted">Most urgent first. Open one to reply, or reply and mark it resolved in one step.</p>
          </CardHeader>
          <CardContent>
            {data.attention.length === 0 ? (
              <EmptyState title="Nobody is waiting. Every student has had an answer." />
            ) : (
              <ul className="divide-y divide-border">
                {data.attention.map((r) => (
                  <li key={r.complaint_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <b>{r.reporter}</b>
                        {r.department && <span className="text-muted"> · {r.department}</span>}
                      </p>
                      <p className="truncate text-sm">{r.subject}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <Badge tone={REASON[r.reason].tone}>{REASON[r.reason].label}</Badge>
                        waiting {relativeTime(r.waiting_since)}
                      </p>
                    </div>
                    <Link
                      href={`/admin/messages?tab=conversations&c=${r.complaint_id}`}
                      className="inline-flex min-h-10 items-center rounded-[var(--radius-s)] bg-brand-600 px-3 text-sm font-semibold text-on-brand no-underline hover:bg-brand-700"
                    >
                      Reply
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How a submission&apos;s status changes</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3 text-sm">
              <li>
                <ComplaintStatusBadge status="received" />
                <p className="mt-1 text-muted">The student sent it and nobody on the team has replied yet. If an earlier answer matched, they got it instantly.</p>
              </li>
              <li>
                <ComplaintStatusBadge status="in_progress" />
                <p className="mt-1 text-muted">Moves here automatically when staff reply to the student, or message everyone on its issue.</p>
              </li>
              <li>
                <ComplaintStatusBadge status="resolved" />
                <p className="mt-1 text-muted">
                  Moves here when the student clicks <b>Helpful</b> on an answer, or staff use <b>Reply &amp; resolve</b>. An issue is resolved once all its
                  submissions are, or when staff mark the whole issue resolved.
                </p>
              </li>
              <li>
                <ComplaintStatusBadge status="review_requested" />
                <p className="mt-1 text-muted">The student said it isn&apos;t fixed. It returns to the waiting list until someone replies.</p>
              </li>
            </ol>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
              Similar questions (60% or more alike) are grouped automatically, and everyone in the group receives replies already sent.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid items-start gap-4 min-[1000px]:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Latest submissions</CardTitle>
          </CardHeader>
          <CardContent>
            {data.latest.length === 0 ? (
              <EmptyState title="No submissions yet." />
            ) : (
              <ul className="divide-y divide-border">
                {data.latest.map((c) => (
                  <li key={c.complaint_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <Link href={`/admin/complaints/${c.complaint_id}`} className="block truncate font-medium hover:underline">
                        {c.subject}
                      </Link>
                      <p className="text-xs text-muted">
                        {c.reporter}
                        {c.department && ` · ${c.department}`} · {c.category} · {relativeTime(c.created_at)}
                        {c.answered_instantly && " · answered instantly"}
                      </p>
                    </div>
                    <ComplaintStatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Grouped issues</CardTitle>
            <p className="text-xs text-muted">
              {s.total_issues} issue{s.total_issues === 1 ? "" : "s"} · {s.in_progress} in progress · {s.resolved} resolved
              {s.escalated_open > 0 && ` · ${s.escalated_open} escalated`}
            </p>
          </CardHeader>
          <CardContent>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <StatCard label="High & critical" value={s.high_critical} tone={s.high_critical ? "danger" : "neutral"} href="/admin/issues?priority=high" />
              <StatCard label="Overdue" value={s.overdue} tone={s.overdue ? "danger" : "neutral"} href="/admin/issues?overdue=1" />
              <StatCard label="Other office" value={s.awaiting_external} href="/admin/issues?status=awaiting_external_action" />
            </div>
            {data.urgent.length === 0 ? (
              <EmptyState title="No high-priority or overdue issues." />
            ) : (
              <ul className="divide-y divide-border">
                {data.urgent.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Link href={`/admin/issues/${i.id}`} className="font-medium hover:underline">
                        {i.title}
                      </Link>
                      <p className="text-xs text-muted">
                        {i.distinct_reporter_count} student{i.distinct_reporter_count === 1 ? "" : "s"}
                        {i.expected_resolution_at && ` · due ${formatDateTime(i.expected_resolution_at)}`}
                        {i.overdue && <span className="font-medium text-danger-fg"> · overdue</span>}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <PriorityBadge priority={i.priority} />
                      <IssueStatusBadge status={i.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
