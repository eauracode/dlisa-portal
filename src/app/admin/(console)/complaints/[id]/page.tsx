import type { Metadata } from "next";
import { ReuseCheckbox } from "@/components/reuse-checkbox";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { can } from "@/lib/auth/permissions";
import { getComplaintForAdmin } from "@/lib/services/admin/complaints";
import { issueOptionsForSelect } from "@/lib/services/admin/issues";
import { listInstantAnswersForComplaint } from "@/lib/services/instant-answers";
import { NotFoundError } from "@/lib/services/admin/context";
import { formatDateTime, ISSUE_STATUS_LABELS } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { ComplaintStatusBadge, IssueStatusBadge, MatchStatusBadge } from "@/components/status";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea } from "@/components/ui";
import { Flash } from "@/components/flash";
import { reassignComplaintAction, retryMatchingAction, sendMessageAction } from "../../../actions";

export const metadata: Metadata = { title: "Submission" };

export default async function AdminComplaintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  let d;
  try {
    d = await getComplaintForAdmin(pool(), admin, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { complaint: c } = d;
  const canRegroup = can(admin.role, "complaints.reassign");
  const options = canRegroup ? await issueOptionsForSelect(pool(), admin, c.consolidated_issue_id ?? undefined) : [];
  const answers = await listInstantAnswersForComplaint(pool(), c.id);

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <nav className="mb-3 text-sm">
        <Link href="/admin/complaints" className="text-link hover:underline">
          ← All submissions
        </Link>
      </nav>
      <div className="mb-6">
        <div className="flex flex-wrap gap-2">
          <ComplaintStatusBadge status={c.status} />
          <MatchStatusBadge status={c.match_status} />
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words">{c.subject}</h1>
        <p className="text-sm text-muted">
          {c.category} · {c.reporter}
          {c.department && (
            <Badge className="mx-1.5" title="Shown because at least 5 students from this department reported the issue">
              {c.department}
            </Badge>
          )}{" "}
          · submitted {formatDateTime(c.created_at)}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Original submission</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line break-words text-sm">{c.description}</p>
              {c.review_request_reason && (
                <p className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-sm">
                  <span className="font-medium">Review requested: </span>
                  {c.review_request_reason}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Consolidated issue</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {d.issue ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/admin/issues/${d.issue.id}`} className="font-medium text-link hover:underline">
                    {d.issue.title}
                  </Link>
                  <IssueStatusBadge status={d.issue.status} />
                </div>
              ) : (
                <p className="text-muted">Not yet grouped. {c.match_status === "pending_review" ? "A suggested match is waiting in the review queue." : ""}</p>
              )}
            </CardContent>
          </Card>

          {d.analysis && (
            <Card>
              <CardHeader>
                <CardTitle>Automated analysis</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
                <p>
                  <span className="text-muted">Summary title:</span> {d.analysis.summary_title}
                </p>
                <p>
                  <span className="text-muted">Problem type:</span> {d.analysis.problem_type?.replace(/_/g, " ")}
                </p>
                <p>
                  <span className="text-muted">Severity:</span> {d.analysis.severity} {d.analysis.safety_flag && <Badge tone="danger">Safety flag</Badge>}
                </p>
                <p>
                  <span className="text-muted">Courses:</span> {d.analysis.course_codes.join(", ") || "—"} · <span className="text-muted">Period:</span> {d.analysis.academic_period ?? "—"}
                </p>
                <p className="text-xs text-muted sm:col-span-2">
                  {d.analysis.classifier_provider}:{d.analysis.classifier_model} · embeddings {d.analysis.embedding_model}. AI output is advisory; staff make the decisions.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Grouping history</CardTitle>
            </CardHeader>
            <CardContent>
              {d.links.length === 0 && d.reviews.length === 0 ? (
                <p className="text-sm text-muted">No grouping yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {d.links.map((l) => (
                    <li key={`${l.consolidated_issue_id}-${l.matched_at.toISOString()}`}>
                      <span className="text-xs text-muted">{formatDateTime(l.matched_at)}</span> linked to{" "}
                      <Link href={`/admin/issues/${l.consolidated_issue_id}`} className="text-link hover:underline">
                        {l.title}
                      </Link>{" "}
                      by <span className="font-medium">{l.match_method.replace("_", " ")}</span>
                      {l.match_confidence != null && ` (confidence ${l.match_confidence.toFixed(2)})`}
                      {l.unlinked_at && <span className="text-muted"> · unlinked {formatDateTime(l.unlinked_at)}</span>}
                      {l.model_version && <span className="block text-xs text-muted">{l.model_version}</span>}
                    </li>
                  ))}
                  {d.reviews.map((r) => (
                    <li key={r.id}>
                      <span className="text-xs text-muted">{formatDateTime(r.created_at)}</span> suggested match with “{r.title}” ({r.confidence_score.toFixed(2)}) —{" "}
                      <span className="font-medium">{r.review_status}</span>
                      <span className="block text-xs text-muted">{r.explanation}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Complaint history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm">
                {d.events.map((e) => (
                  <li key={e.id}>
                    <span className="text-xs text-muted">{formatDateTime(e.created_at)}</span> {e.event_type.replace(/_/g, " ")}
                    {!e.visible_to_student && <Badge className="ml-1">staff only</Badge>}
                    {e.message && <span className="block text-muted">{e.message}</span>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-3">
          {answers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Instant answers given</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {answers.map((a) => (
                  <div key={a.message_id} className="border-b border-border pb-2 last:border-0 last:pb-0">
                    <p className="font-medium">{a.subject}</p>
                    <p className="text-xs text-muted">
                      {a.source === "same_issue" ? "Earlier reply to this issue" : `Similar question (${Math.round((a.similarity ?? 0) * 100)}% match)`} ·{" "}
                      {a.helpful === null ? "No feedback yet" : a.helpful ? "Student confirmed it answered their question (resolved)" : "Student still needs help"}
                    </p>
                  </div>
                ))}
                <p className="text-xs text-muted">The student received these in their Messages inbox when they submitted.</p>
              </CardContent>
            </Card>
          )}
          {can(admin.role, "messages.send_issue") && (
            <Card>
              <CardHeader>
                <CardTitle>Message this reporter</CardTitle>
              </CardHeader>
              <CardContent>
                <form action={sendMessageAction} className="space-y-2">
                  <input type="hidden" name="targetType" value="reporter" />
                  <input type="hidden" name="complaintId" value={c.id} />
                  <input type="hidden" name="back" value={`/admin/complaints/${c.id}`} />
                  <Input name="subject" required minLength={3} maxLength={150} placeholder="Subject" aria-label="Subject" />
                  <Textarea name="body" required minLength={5} maxLength={4000} rows={4} placeholder="Private message to the student who wrote this" aria-label="Message" />
                  <ReuseCheckbox defaultChecked={false} personal />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" name="intent" value="send" variant="secondary">
                      Send privately
                    </Button>
                    {!["resolved", "closed"].includes(c.status) && (
                      <Button size="sm" name="intent" value="resolve">
                        Send &amp; resolve
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted">Delivered to {c.reporter}&apos;s Messages inbox. Sending moves this to In progress; &ldquo;Send &amp; resolve&rdquo; marks it Resolved.</p>
                </form>
              </CardContent>
            </Card>
          )}
          {d.job && d.job.status !== "completed" && d.job.status !== "cancelled" && (
            <Card>
              <CardContent className="space-y-2 text-sm">
                <p className="font-medium">Automatic matching: {d.job.status}</p>
                <p className="text-xs text-muted">
                  Attempts: {d.job.attempts}
                  {d.job.status === "pending" && ` · next attempt ${formatDateTime(d.job.next_attempt_at)}`}
                </p>
                {d.job.last_error && <p className="text-xs text-muted">Last error: {d.job.last_error}</p>}
                {can(admin.role, "jobs.run") && !c.consolidated_issue_id && (
                  <form action={retryMatchingAction}>
                    <input type="hidden" name="complaintId" value={c.id} />
                    <Button size="sm" variant="secondary">
                      Retry automatic matching
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          )}
          {canRegroup && (
            <Card>
              <CardHeader>
                <CardTitle>{c.consolidated_issue_id ? "Correct the grouping" : "Group manually"}</CardTitle>
              </CardHeader>
              <CardContent>
                <form action={reassignComplaintAction} className="space-y-2">
                  <input type="hidden" name="complaintId" value={c.id} />
                  <Label htmlFor="targetIssueId">Move to</Label>
                  <Select id="targetIssueId" name="targetIssueId" defaultValue="new">
                    <option value="new">A new issue</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.title} ({ISSUE_STATUS_LABELS[o.status]}, {o.total_submission_count})
                      </option>
                    ))}
                  </Select>
                  <Input name="reason" required placeholder="Reason (recorded)" aria-label="Reason" />
                  <Button size="sm">Save grouping</Button>
                  <p className="text-xs text-muted">The original submission is never changed or deleted. The student keeps seeing it on their dashboard.</p>
                </form>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
