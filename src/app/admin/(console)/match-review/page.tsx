import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { listPendingReviews } from "@/lib/services/admin/complaints";
import { issueOptionsForSelect } from "@/lib/services/admin/issues";
import { formatDateTime, ISSUE_STATUS_LABELS } from "@/lib/format";
import { IssueStatusBadge } from "@/components/status";
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Select } from "@/components/ui";
import { Flash } from "@/components/flash";
import { LiveRefresh } from "@/components/auto-refresh";
import { matchReviewAction } from "../../actions";

export const metadata: Metadata = { title: "Match review" };

const REASON_LABELS: Record<string, string> = {
  uncertain: "Similar, but not certain",
  ambiguous: "Several issues are similar",
  incompatible: "Similar wording, conflicting details",
  sensitive: "Sensitive case",
  recurrence: "Matches a resolved issue",
  verifier: "AI verifier disagreed",
};

export default async function MatchReviewPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const admin = await requireAdmin("matches.review");
  const sp = await searchParams;
  const [queue, options] = await Promise.all([listPendingReviews(pool(), admin), issueOptionsForSelect(pool(), admin)]);

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <LiveRefresh versionUrl="/api/admin/activity-version" />
      <PageHeader
        title="Match review queue"
        description="New submissions that may describe an existing issue but were not similar enough, or were too ambiguous, to group automatically. Scores are tuning signals, not probabilities."
      />
      {queue.length === 0 ? (
        <EmptyState title="Nothing to review.">Uncertain matches will appear here as students submit complaints.</EmptyState>
      ) : (
        <ul className="space-y-8">
          {queue.map((r) => {
            const resolved = ["resolved", "closed"].includes(r.issue_status);
            return (
              <li key={r.id} className="space-y-3">
                <div className="grid items-stretch gap-3 min-[900px]:grid-cols-[1fr_auto_1fr]">
                  <Card className="space-y-2 p-4">
                    <p className="text-xs text-muted">
                      New submission &nbsp;•&nbsp; {r.reporter}
                      {r.department && ` (${r.department})`} &nbsp;•&nbsp; {formatDateTime(r.created_at)}
                    </p>
                    <Link href={`/admin/complaints/${r.complaint_id}`} className="block font-semibold text-foreground no-underline hover:text-link hover:underline">
                      {r.subject}
                    </Link>
                    <p className="line-clamp-6 whitespace-pre-wrap border-l-[3px] border-border-strong pl-3.5 text-sm">{r.description}</p>
                    <p className="text-xs text-muted">{r.complaint_category}</p>
                  </Card>
                  <div className="grid place-items-center text-center text-xs text-muted">
                    <div>
                      <div className="text-[28px] font-bold text-link tabular-nums">{Math.round(r.confidence_score * 100)}%</div>
                      confidence
                      <div className="mt-2 flex flex-col items-center gap-1">
                        {r.review_reason && <Badge tone="warn">{REASON_LABELS[r.review_reason] ?? r.review_reason}</Badge>}
                        {r.review_kind === "possible_recurrence" && <Badge tone="violet">Possible recurrence</Badge>}
                        {(r.issue_sensitive || (r.complaint_sensitivity && r.complaint_sensitivity !== "none")) && (
                          <Badge tone="danger" flag>
                            Sensitive
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <Card className="space-y-2 p-4">
                    <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <span>
                        Proposed issue &nbsp;•&nbsp; {r.issue_count} report{r.issue_count === 1 ? "" : "s"}
                      </span>
                      <IssueStatusBadge status={r.issue_status} />
                    </p>
                    <Link href={`/admin/issues/${r.candidate_issue_id}`} className="block font-semibold text-foreground no-underline hover:text-link hover:underline">
                      {r.issue_title}
                    </Link>
                    <p className="text-sm text-muted">{r.issue_summary}</p>
                  </Card>
                </div>
                <Alert tone="info">
                  <b className="mb-0.5 block">Why it&apos;s uncertain</b>
                  {r.explanation}
                </Alert>
                <form action={matchReviewAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="reviewId" value={r.id} />
                  {resolved ? (
                    <Button name="decision" value="confirm_reopen">
                      Same problem recurring: reopen and attach
                    </Button>
                  ) : (
                    <Button name="decision" value="confirm">
                      Confirm match
                    </Button>
                  )}
                  <Button variant="ghost" name="decision" value="reject">
                    {resolved ? "New instance: create related issue" : "Not the same"}
                  </Button>
                  <div className="flex flex-wrap gap-2">
                    <Select name="targetIssueId" defaultValue="" aria-label="Different issue" className="w-auto max-w-xs">
                      <option value="">Choose a different issue…</option>
                      {options
                        .filter((o) => o.id !== r.candidate_issue_id)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.title} ({ISSUE_STATUS_LABELS[o.status]})
                          </option>
                        ))}
                    </Select>
                    <Button variant="ghost" name="decision" value="reassign">
                      Attach to a different issue
                    </Button>
                  </div>
                  <Input name="reason" placeholder="Decision note (optional)" aria-label="Decision note" className="w-auto min-w-48 flex-1" />
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
