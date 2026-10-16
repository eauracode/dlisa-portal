import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { listIssues } from "@/lib/services/admin/issues";
import { formatDate, formatDateTime, relativeTime } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { IssueStatusBadge, PriorityBadge } from "@/components/status";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LiveRefresh } from "@/components/auto-refresh";
import { endOfDay, FilterBar, filterOptions, parseDate, parseDepartment } from "../filters";

export const metadata: Metadata = { title: "Issues" };

export default async function AdminIssuesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const { categories, officers } = await filterOptions();
  const list = await listIssues(pool(), admin, {
    q: sp.q?.slice(0, 100),
    status: sp.status || undefined,
    priority: sp.priority || undefined,
    categoryId: sp.category ? Number(sp.category) || undefined : undefined,
    assigned: sp.assigned === "unassigned" ? "unassigned" : uuidSchema.safeParse(sp.assigned).success ? sp.assigned : undefined,
    overdue: sp.overdue === "1",
    escalated: sp.escalated === "1",
    department: parseDepartment(sp.department),
    from: parseDate(sp.from),
    to: endOfDay(sp.to),
  });

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <LiveRefresh versionUrl="/api/admin/activity-version" />
      <PageHeader
        title="Consolidated issues"
        description="Each issue groups student submissions about one underlying problem. Ordered by priority, then latest activity."
      />
      <FilterBar params={sp} categories={categories} officers={officers} showOfficer={admin.role === "union_admin"} showSearch extraStatuses={[["open", "All open"]]} />
      {(sp.overdue === "1" || sp.escalated === "1") && (
        <p className="mb-3 text-sm text-muted">
          Showing {sp.overdue === "1" ? "overdue" : "escalated"} issues only. <Link href="/admin/issues" className="text-link underline">Show all</Link>
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState title="No issues match these filters." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Issue</Th>
              <Th>Reports</Th>
              <Th>Priority</Th>
              <Th>Status</Th>
              <Th>Officer</Th>
              <Th>Expected resolution</Th>
              <Th>Activity</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id} className="hover:bg-brand-50/50">
                <Td className="max-w-sm">
                  <Link href={`/admin/issues/${i.id}`} className="font-medium text-foreground hover:underline">
                    {i.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted">
                    <span>{i.category}</span>
                    <span>· opened {formatDate(i.created_at)}</span>
                    {i.sensitive && <Badge tone="danger">Sensitive</Badge>}
                    {i.escalated && <Badge tone="purple">Escalated</Badge>}
                    {i.public_visibility && <Badge tone="success">Public</Badge>}
                    {i.pending_reviews > 0 && <Badge tone="warning">{i.pending_reviews} match review</Badge>}
                    {i.review_requests > 0 && <Badge tone="warning">{i.review_requests} review request</Badge>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {i.total_submission_count}
                  <span className="block text-xs text-muted">{i.distinct_reporter_count} student{i.distinct_reporter_count === 1 ? "" : "s"}</span>
                </Td>
                <Td>
                  <PriorityBadge priority={i.priority} />
                  {i.priority_override && <span className="block text-xs text-muted">override</span>}
                </Td>
                <Td>
                  <IssueStatusBadge status={i.status} />
                </Td>
                <Td className="text-sm">{i.assigned_name ?? <span className="text-muted">Unassigned</span>}</Td>
                <Td className="whitespace-nowrap text-sm">
                  {i.expected_resolution_at ? formatDateTime(i.expected_resolution_at) : <span className="text-muted">Not set</span>}
                  {i.overdue && <span className="block text-xs font-medium text-danger-fg">Overdue</span>}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">{relativeTime(i.last_activity_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
