import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { getOverview } from "@/lib/services/admin/overview";
import { formatDateTime, relativeTime } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { IssueStatusBadge, PriorityBadge } from "@/components/status";
import { Alert, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader, StatCard, Timeline } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LiveRefresh } from "@/components/auto-refresh";
import { endOfDay, FilterBar, filterOptions, parseDate, parseDepartment } from "./filters";

export const metadata: Metadata = { title: "Staff overview" };

type SP = Promise<Record<string, string | undefined>>;

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
  const scopeNote =
    admin.role === "case_officer"
      ? "Showing issues assigned to you."
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
              awaiting review.{" "}
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

      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        <StatCard label="Individual submissions" value={s.total_complaints} href="/admin/complaints" />
        <StatCard label="Consolidated issues" value={s.total_issues} href="/admin/issues" />
        <StatCard label="Awaiting review" value={s.awaiting_review} tone={s.awaiting_review ? "warning" : "neutral"} href="/admin/complaints?status=received" />
        <StatCard label="In progress" value={s.in_progress} href="/admin/issues?status=in_progress" />
        <StatCard label="High & critical" value={s.high_critical} tone={s.high_critical ? "danger" : "neutral"} href="/admin/issues?priority=high" />
        <StatCard label="Overdue" value={s.overdue} tone={s.overdue ? "danger" : "neutral"} href="/admin/issues?overdue=1" />
        <StatCard label="Awaiting external action" value={s.awaiting_external} href="/admin/issues?status=awaiting_external_action" />
        <StatCard label="Escalated (open)" value={s.escalated_open} href="/admin/issues?escalated=1" />
        <StatCard label="Resolved" value={s.resolved} tone="success" href="/admin/issues?status=resolved" />
      </div>

      <div className="mt-4 grid items-start gap-4 min-[1000px]:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
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
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.activity.length === 0 ? (
              <EmptyState title="No activity yet." />
            ) : (
              <Timeline
                items={data.activity.map((a) => ({
                  key: a.id,
                  content: (
                    <>
                      <b className="font-semibold">{a.actor ?? (a.actor_type === "system" ? "System" : a.actor_type === "student" ? "A student" : "Staff")}</b>{" "}
                      {a.action.replace(/[._]/g, " ")}
                      {a.entity_type === "issue" && a.entity_id && (
                        <>
                          {" "}
                          <Link href={`/admin/issues/${a.entity_id}`}>view</Link>
                        </>
                      )}
                    </>
                  ),
                  time: relativeTime(a.created_at),
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
