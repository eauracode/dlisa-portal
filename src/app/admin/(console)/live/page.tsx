import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { getLiveActivity, SURGE_THRESHOLD, type LiveIssue } from "@/lib/services/admin/live";
import { formatDateTime, MATCH_STATUS_LABELS, PRIORITY_LABELS, relativeTime } from "@/lib/format";
import { IssueStatusBadge, PriorityBadge } from "@/components/status";
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader, StatCard } from "@/components/ui";
import { LiveRefresh } from "@/components/auto-refresh";

export const metadata: Metadata = { title: "Live monitor" };

function IssueLine({ issue, extra }: { issue: LiveIssue; extra?: React.ReactNode }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link href={`/admin/issues/${issue.id}`} className="font-medium hover:underline">
          {issue.title}
        </Link>
        <div className="flex flex-wrap gap-1">
          {issue.sensitive && <Badge tone="danger">Sensitive</Badge>}
          <PriorityBadge priority={issue.priority} />
          <IssueStatusBadge status={issue.status} />
        </div>
      </div>
      {issue.summary && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{issue.summary}</p>}
      <p className="mt-1 text-xs text-muted">
        {issue.category} · <span className="tabular-nums">{issue.total_submission_count}</span> report{issue.total_submission_count === 1 ? "" : "s"} from{" "}
        <span className="tabular-nums">{issue.distinct_reporter_count}</span> student{issue.distinct_reporter_count === 1 ? "" : "s"}
        {issue.reports_24h > 0 && ` · ${issue.reports_24h} in 24h`}
        {" · "}
        {issue.assigned_name ?? "unassigned"}
        {" · "}
        {issue.expected_resolution_at ? `due ${formatDateTime(issue.expected_resolution_at)}` : "no confirmed date"}
        {issue.last_report_at && ` · last report ${relativeTime(issue.last_report_at)}`}
        {issue.ai_confidence != null && ` · AI match confidence ${issue.ai_confidence.toFixed(2)}`}
      </p>
      {extra}
    </li>
  );
}

function Section({ title, count, children, empty }: { title: string; count?: number; children: React.ReactNode; empty: string }) {
  const hasItems = count === undefined ? true : count > 0;
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>
          {title}
          {count !== undefined && <span className="ml-2 text-sm font-normal text-muted tabular-nums">{count}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="py-1">{hasItems ? children : <p className="py-3 text-sm text-muted">{empty}</p>}</CardContent>
    </Card>
  );
}

export default async function LiveMonitorPage() {
  const admin = await requireAdmin();
  const live = await getLiveActivity(pool(), admin);
  const c = live.counters;
  const isUnionAdmin = admin.role === "union_admin";

  return (
    <>
      <LiveRefresh versionUrl="/api/admin/activity-version" />
      <PageHeader
        title="Live issue monitor"
        description={
          <>
            Every new complaint is analysed by the Issue Intelligence Engine as soon as it is submitted. This page updates automatically
            when processing finishes. <span className="inline-flex items-center gap-1 text-link"><span className="h-2 w-2 rounded-full bg-brand-500" aria-hidden /> Live</span>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Complaints (24h)" value={c.complaints_24h} />
        <StatCard label="New issues (24h)" value={c.issues_24h} />
        <StatCard label="Auto-grouped (24h)" value={c.auto_24h} tone="success" />
        <StatCard label="Sent to review (24h)" value={c.review_24h} tone={c.review_24h ? "warning" : "neutral"} />
        <StatCard label="Started new issue (24h)" value={c.new_24h} />
        <StatCard label="Processing now" value={c.processing} tone={c.processing ? "warning" : "neutral"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Needs intervention" count={live.intervention.length} empty="Nothing waiting for staff action.">
          <ul className="divide-y divide-border">
            {live.intervention.map((i) => (
              <IssueLine key={i.id} issue={i} extra={<Badge tone="warning" className="mt-1">{i.reason}</Badge>} />
            ))}
          </ul>
        </Section>

        <Section title={`Rapid increase (${SURGE_THRESHOLD}+ reports in 24h)`} count={live.surging.length} empty="No issue is receiving a surge of reports.">
          <ul className="divide-y divide-border">
            {live.surging.map((i) => (
              <IssueLine key={i.id} issue={i} />
            ))}
          </ul>
        </Section>

        <Section title="Issues receiving new matching reports" count={live.active.length} empty="No existing issue received new reports in the last 24 hours.">
          <ul className="divide-y divide-border">
            {live.active.map((i) => (
              <IssueLine key={i.id} issue={i} />
            ))}
          </ul>
        </Section>

        <Section title="Newly created issues" count={live.newIssues.length} empty="No new issues in the last 24 hours.">
          <ul className="divide-y divide-border">
            {live.newIssues.map((i) => (
              <IssueLine key={i.id} issue={i} />
            ))}
          </ul>
        </Section>

        {isUnionAdmin && (
          <Section title="Uncertain AI matches" count={live.reviews.length} empty="No matches awaiting review.">
            <ul className="divide-y divide-border text-sm">
              {live.reviews.map((r) => (
                <li key={r.id} className="py-3">
                  <Link href={`/admin/complaints/${r.complaint_id}`} className="font-medium hover:underline">
                    {r.subject}
                  </Link>
                  <p className="text-xs text-muted">
                    may belong to <Link href={`/admin/issues/${r.issue_id}`} className="text-link hover:underline">{r.issue_title}</Link> · confidence {r.confidence_score.toFixed(2)}
                    {r.review_reason && ` · ${r.review_reason}`} · {relativeTime(r.created_at)}
                  </p>
                </li>
              ))}
            </ul>
            {live.reviews.length > 0 && (
              <p className="pb-3 text-sm">
                <Link href="/admin/match-review" className="text-link underline">
                  Open the review queue →
                </Link>
              </p>
            )}
          </Section>
        )}

        <Section title="Priority increased (24h)" count={live.priorityUps.length} empty="No priority increases in the last 24 hours.">
          <ul className="divide-y divide-border text-sm">
            {live.priorityUps.map((p) => (
              <li key={`${p.issue_id}-${p.created_at.toISOString()}`} className="flex flex-wrap justify-between gap-2 py-2">
                <Link href={`/admin/issues/${p.issue_id}`} className="hover:underline">
                  {p.title}
                </Link>
                <span className="text-xs text-muted">
                  {PRIORITY_LABELS[p.previous_value] ?? p.previous_value} → <span className="font-medium text-foreground">{PRIORITY_LABELS[p.new_value] ?? p.new_value}</span> ·{" "}
                  {relativeTime(p.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Newly received complaints" count={live.newComplaints.length} empty="No complaints in the last 24 hours.">
          <ul className="divide-y divide-border text-sm">
            {live.newComplaints.map((n) => (
              <li key={n.id} className="py-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <Link href={`/admin/complaints/${n.id}`} className="font-medium hover:underline">
                    {n.subject}
                  </Link>
                  <Badge tone={n.match_status === "failed" ? "danger" : n.match_status === "pending" || n.match_status === "pending_review" ? "warning" : "neutral"}>
                    {MATCH_STATUS_LABELS[n.match_status] ?? n.match_status}
                  </Badge>
                </div>
                <p className="text-xs text-muted">
                  {n.category} · {relativeTime(n.created_at)}
                  {n.issue_id && (
                    <>
                      {" → "}
                      <Link href={`/admin/issues/${n.issue_id}`} className="text-link hover:underline">
                        {n.issue_title}
                      </Link>
                    </>
                  )}
                  {n.confidence != null && ` · confidence ${n.confidence.toFixed(2)}`}
                </p>
              </li>
            ))}
          </ul>
        </Section>

        {isUnionAdmin && (
          <Section title="AI processing failures and retries" count={live.failures.length} empty="All complaints processed successfully.">
            <ul className="divide-y divide-border text-sm">
              {live.failures.map((f) => (
                <li key={f.complaint_id} className="py-2">
                  <Link href={`/admin/complaints/${f.complaint_id}`} className="font-medium hover:underline">
                    {f.subject}
                  </Link>
                  <p className="text-xs text-muted">
                    {f.status === "failed" ? "Failed — group manually or retry" : `Retrying (attempt ${f.attempts}) at ${formatDateTime(f.next_attempt_at)}`}
                    {f.last_error && ` · ${f.last_error}`}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </>
  );
}
