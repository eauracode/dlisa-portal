import type { Metadata } from "next";
import { ReuseCheckbox } from "@/components/reuse-checkbox";
import Link from "next/link";
import { notFound } from "next/navigation";
import { pool, rows } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { can } from "@/lib/auth/permissions";
import { getIssueDetail, issueOptionsForSelect } from "@/lib/services/admin/issues";
import { unreadRepliesByComplaint } from "@/lib/services/conversations";
import { NotFoundError } from "@/lib/services/admin/context";
import { DEPARTMENT_DISCLOSURE_THRESHOLD } from "@/lib/privacy";
import { formatDateTime, ISSUE_STATUS_LABELS, MATCH_STATUS_LABELS, PRIORITY_LABELS, toDateTimeLocal } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { COPY } from "@/config/app";
import { ComplaintStatusBadge, FlagBadge, IssueStatusBadge, PriorityBadge } from "@/components/status";
import { Alert, Badge, Button, buttonVariants, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea, Timeline } from "@/components/ui";
import { ActionTabs, type ActionTab } from "@/components/action-tabs";
import { Flash } from "@/components/flash";
import * as act from "../../../actions";

export const metadata: Metadata = { title: "Issue" };

/** One collapsible action inside a tab (prototype "details.act"). */
function Act({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-[var(--radius-m)] border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3.5 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {title}
        <span aria-hidden="true" className="text-lg font-normal text-muted group-open:hidden">
          +
        </span>
        <span aria-hidden="true" className="hidden text-lg font-normal text-muted group-open:inline">
          –
        </span>
      </summary>
      <div className="grid gap-2.5 px-3.5 pb-3.5">{children}</div>
    </details>
  );
}

function Hidden({ issueId }: { issueId: string }) {
  return <input type="hidden" name="issueId" value={issueId} />;
}

const ROLE_NOTE: Record<string, string | undefined> = {
  case_officer:
    "As a Case Officer you can respond and schedule. Triage, escalation and restructuring are handled by the Association Administrator — you can propose a date or an escalation under Schedule.",
  oversight_officer: "As an Oversight Officer you can record official responses, add oversight notes and update the escalation status.",
};

export default async function AdminIssuePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  let d;
  try {
    d = await getIssueDetail(pool(), admin, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { issue } = d;
  const role = admin.role;
  const merged = issue.status === "merged";
  const otherIssues = can(role, "issues.merge_split") ? await issueOptionsForSelect(pool(), admin, issue.id) : [];
  const categories = can(role, "issues.edit_details") ? await rows<{ id: number; name: string }>(pool(), `select id, name from issue_categories order by sort_order`) : [];
  const reviewRequests = d.complaints.filter((c) => c.status === "review_requested");
  const unreadReplies = await unreadRepliesByComplaint(pool(), d.issue.id);
  const pendingProposals = d.proposals.filter((p) => p.status === "pending");
  const canSplit = can(role, "issues.merge_split") && !merged;
  const noteKinds = [
    can(role, "issues.internal_note") && { value: "internal", label: "Internal note" },
    can(role, "issues.oversight_note") && { value: "oversight", label: "Restricted oversight note" },
  ].filter(Boolean) as Array<{ value: string; label: string }>;

  // ---------------------------------------------------------------- action groups (role-filtered)
  const respond = (
    <>
      {can(role, "issues.publish_update") && (
        <Act title="Publish an update" open>
          <form action={act.publishUpdateAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Label htmlFor="up" className="mb-0">
              Update for students
            </Label>
            <Textarea id="up" name="message" className="min-h-24" required placeholder="Factual progress update. Do not promise outcomes or dates that are not confirmed." />
            {can(role, "issues.visibility") && !issue.sensitive && (
              <label className="flex min-h-10 items-start gap-2.5 py-2 text-sm">
                <input type="checkbox" name="visibility" value="public" className="mt-0.5 h-5 w-5 accent-brand-600" />
                Also post to public Memos as an issue update
              </label>
            )}
            <Button>Publish update</Button>
          </form>
        </Act>
      )}
      {can(role, "messages.send_issue") && issue.distinct_reporter_count > 0 && (
        <Act title={`Message all reporters (${issue.distinct_reporter_count})`}>
          <form action={act.sendMessageAction} className="grid gap-2.5">
            <input type="hidden" name="targetType" value="issue" />
            <Hidden issueId={issue.id} />
            <input type="hidden" name="back" value={`/admin/issues/${issue.id}`} />
            <Input name="subject" required minLength={3} maxLength={150} placeholder="Subject" aria-label="Subject" />
            <Textarea name="body" className="min-h-24" required minLength={5} maxLength={4000} placeholder="Message" aria-label="Message" />
            <ReuseCheckbox defaultChecked />
            <Button>Send message</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.institutional_response") && (role === "oversight_officer" || issue.escalated) && (
        <Act title="Record institutional response" open={role === "oversight_officer"}>
          <form action={act.publishUpdateAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <input type="hidden" name="type" value="institutional_response" />
            <input type="hidden" name="visibility" value="reporters" />
            <Textarea name="message" className="min-h-24" required placeholder="The school's official response, as approved for students" aria-label="Response" />
            <Button>Record response</Button>
          </form>
        </Act>
      )}
      {noteKinds.length > 0 && (
        <Act title="Add a note">
          <form action={act.noteAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            {noteKinds.length > 1 ? (
              <Select name="visibility" aria-label="Note type" defaultValue={noteKinds[0].value}>
                {noteKinds.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            ) : (
              <input type="hidden" name="visibility" value={noteKinds[0].value} />
            )}
            <Textarea name="note" className="min-h-20" required placeholder="Never shown to students" aria-label="Note" />
            <Button variant="ghost">Save note</Button>
          </form>
        </Act>
      )}
    </>
  );
  const hasRespond = can(role, "issues.publish_update") || can(role, "messages.send_issue") || can(role, "issues.institutional_response") || noteKinds.length > 0;

  const schedule = (
    <>
      {can(role, "issues.update_status") && (
        <Act title="Change status" open>
          <form action={act.statusAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Select name="status" defaultValue={issue.status} aria-label="Status">
              {Object.entries(ISSUE_STATUS_LABELS)
                .filter(([v]) => v !== "merged")
                .map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
            </Select>
            <Textarea name="note" rows={2} placeholder="Resolution note (required when resolving; shared with reporting students)" aria-label="Note" />
            <Button>Change status</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.set_deadline") && (
        <Act title="Set expected resolution date">
          <form action={act.deadlineAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Input type="datetime-local" name="deadline" defaultValue={toDateTimeLocal(issue.expected_resolution_at)} aria-label="Date and time (Lagos)" />
            <Input name="reason" placeholder={issue.expected_resolution_at ? "Reason for change (required)" : "Note (optional)"} aria-label="Reason" />
            <p className="text-[13px] text-muted">Students see this date as soon as you save it. Only set a confirmed date; clear the field to withdraw it.</p>
            <Button>Save date</Button>
          </form>
        </Act>
      )}
      {(can(role, "issues.propose") || (can(role, "issues.decide_proposals") && pendingProposals.length > 0)) && (
        <Act title={pendingProposals.length ? `Proposals (${pendingProposals.length})` : "Proposals"} open={pendingProposals.length > 0}>
          {pendingProposals.length === 0 && <p className="text-xs text-muted">No proposals yet.</p>}
          {can(role, "issues.decide_proposals") &&
            pendingProposals.map((p) => (
              <form key={p.id} action={act.decideProposalAction} className="grid gap-2 rounded-[var(--radius-m)] border border-border p-2.5 text-sm">
                <Hidden issueId={issue.id} />
                <input type="hidden" name="proposalId" value={p.id} />
                <p>
                  <b>{p.proposer}</b> proposes {p.proposal_type === "deadline" ? `the date ${formatDateTime(p.proposed_deadline)}` : "escalation to school management"}: {p.reason}
                </p>
                <Input name="note" placeholder="Decision note" aria-label="Decision note" />
                <div className="flex gap-2">
                  <Button size="sm" name="decision" value="approve">
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" name="decision" value="reject">
                    Reject
                  </Button>
                </div>
              </form>
            ))}
          {can(role, "issues.propose") && (
            <form action={act.proposeAction} className="grid gap-2.5">
              <Hidden issueId={issue.id} />
              <Select name="type" defaultValue="deadline" aria-label="Proposal type">
                <option value="deadline">Propose an expected resolution date</option>
                <option value="escalation">Propose escalation to school management</option>
              </Select>
              <Input type="datetime-local" name="deadline" aria-label="Proposed date" />
              <Textarea name="reason" rows={2} required placeholder="Reason" aria-label="Reason" />
              <Button variant="ghost">Send proposal</Button>
            </form>
          )}
        </Act>
      )}
      {can(role, "issues.escalation_status") && issue.escalated && (
        <Act title="Escalation status" open={role === "oversight_officer"}>
          <form action={act.escalationStatusAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Select name="escalationStatus" defaultValue={issue.escalation_status ?? "acknowledged"} aria-label="Escalation status">
              <option value="acknowledged">Acknowledged</option>
              <option value="responded">Responded</option>
              <option value="closed">Closed</option>
            </Select>
            <Input name="note" placeholder="Note (optional)" aria-label="Note" />
            <Button>Update escalation</Button>
          </form>
        </Act>
      )}
    </>
  );
  const hasSchedule =
    can(role, "issues.update_status") || can(role, "issues.set_deadline") || can(role, "issues.propose") || (can(role, "issues.decide_proposals") && pendingProposals.length > 0) || (can(role, "issues.escalation_status") && issue.escalated);

  const triage = (
    <>
      {can(role, "issues.assign") && (
        <Act title="Assign officer" open>
          <form action={act.assignAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Select name="officerId" defaultValue={issue.assigned_admin_id ?? ""} aria-label="Officer">
              <option value="">Unassigned</option>
              {d.officers.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.display_name}
                </option>
              ))}
            </Select>
            <Button>Assign</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.set_priority") && (
        <Act title="Override priority">
          <form action={act.priorityAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Select name="priority" defaultValue={issue.priority_override ?? "auto"} aria-label="Priority">
              <option value="auto">Automatic ({PRIORITY_LABELS[issue.computed_priority]})</option>
              {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Input name="reason" placeholder="Reason (required for an override)" aria-label="Reason" />
            <Button>Override</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.escalate") && (!issue.escalated || issue.escalation_status === "closed") && (
        <Act title="Escalate to school management">
          <form action={act.escalateAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Textarea name="reason" className="min-h-20" required placeholder="What do you need from management?" aria-label="Reason" />
            <p className="text-[13px] text-muted">Oversight officers gain access to this issue and its submissions. Reporting students are told it was referred.</p>
            <Button>Escalate</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.visibility") && (
        <Act title="Public visibility">
          {issue.sensitive ? (
            <p className="text-[13px] text-muted">Sensitive issues can never be made public.</p>
          ) : (
            <form action={act.visibilityAction} className="grid gap-2.5">
              <Hidden issueId={issue.id} />
              <Input name="publicTitle" defaultValue={issue.public_title ?? issue.title} placeholder="Anonymised public title" aria-label="Public title" />
              <Textarea name="publicSummary" rows={3} defaultValue={issue.public_summary ?? ""} placeholder="Approved public summary — no names or identifying details" aria-label="Public summary" />
              <div className="flex flex-wrap gap-2">
                <Button name="visible" value="true">
                  {issue.public_visibility ? "Update public text" : "Show in public Memos"}
                </Button>
                {issue.public_visibility && (
                  <Button variant="ghost" name="visible" value="false">
                    Make private
                  </Button>
                )}
              </div>
              <p className="text-[13px] text-muted">
                Public issues appear in students&apos; Memos as &ldquo;Issue update&rdquo; cards until resolved, then drop off automatically. Sensitive
                issues can never be made public. Students never see how many others reported an issue.
              </p>
            </form>
          )}
        </Act>
      )}
    </>
  );
  const hasTriage = can(role, "issues.assign") || can(role, "issues.set_priority") || can(role, "issues.escalate") || can(role, "issues.visibility");

  const restructure = (
    <>
      {can(role, "issues.edit_details") && (
        <Act title="Edit details" open>
          <form action={act.editIssueAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Input name="title" defaultValue={issue.title} aria-label="Title" />
            <Textarea name="summary" rows={3} defaultValue={issue.summary} aria-label="Summary" />
            <Select name="categoryId" defaultValue={issue.category_id} aria-label="Category">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <label className="flex min-h-10 items-start gap-2.5 py-2 text-sm">
              <input type="checkbox" name="sensitive" defaultChecked={issue.sensitive} className="mt-0.5 h-5 w-5 accent-brand-600" />
              Sensitive (restricted access, never public)
            </label>
            <Button variant="ghost">Save details</Button>
          </form>
        </Act>
      )}
      {can(role, "issues.merge_split") && otherIssues.length > 0 && (
        <Act title="Merge into another issue">
          <form action={act.mergeAction} className="grid gap-2.5">
            <Hidden issueId={issue.id} />
            <Select name="targetIssueId" required aria-label="Issue to keep" defaultValue="">
              <option value="" disabled>
                Choose the issue to keep
              </option>
              {otherIssues.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title} ({ISSUE_STATUS_LABELS[o.status]}, {o.total_submission_count})
                </option>
              ))}
            </Select>
            <Input name="reason" required placeholder="Reason" aria-label="Reason" />
            <p className="text-[13px] text-muted">All submissions move to the chosen issue. This issue is kept as &ldquo;merged&rdquo; for the record.</p>
            <Button variant="danger">Merge</Button>
          </form>
        </Act>
      )}
      {canSplit && <p className="text-[13px] text-muted">To split, select submissions on the left.</p>}
    </>
  );
  const hasRestructure = can(role, "issues.edit_details") || can(role, "issues.merge_split");

  const tabs: ActionTab[] = [
    hasRespond && { id: "respond", label: "Respond", content: respond },
    hasSchedule && { id: "schedule", label: "Schedule", content: schedule },
    hasTriage && { id: "triage", label: "Triage", content: triage },
    hasRestructure && { id: "restructure", label: "Restructure", content: restructure },
  ].filter(Boolean) as ActionTab[];

  return (
    <div className="space-y-4">
      <Flash ok={sp.ok} err={sp.err} />
      <Link href="/admin/issues" className="text-xs">
        ‹ Issues
      </Link>

      <div>
        <div className="flex flex-wrap gap-1.5">
          <IssueStatusBadge status={issue.status} />
          <PriorityBadge priority={issue.priority} />
          {issue.sensitive && <FlagBadge tone="danger">Sensitive</FlagBadge>}
          {issue.safety_flag && <FlagBadge tone="danger">Safety flag</FlagBadge>}
          {issue.escalated && <Badge tone="violet">Escalated · {issue.escalation_status}</Badge>}
          {issue.public_visibility && <Badge tone="neutral">Public</Badge>}
          {d.overdue && <FlagBadge tone="danger">Overdue</FlagBadge>}
          {reviewRequests.length > 0 && <Badge tone="warn">{reviewRequests.length} review request{reviewRequests.length === 1 ? "" : "s"}</Badge>}
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{issue.title}</h1>
        <p className="mt-1 text-xs text-muted">
          {d.category} &nbsp;•&nbsp; Opened {formatDateTime(issue.created_at)} &nbsp;•&nbsp; Last activity {formatDateTime(issue.last_activity_at)}
        </p>
        {merged && issue.merged_into_id && (
          <p className="mt-2 text-sm">
            This issue was merged into <Link href={`/admin/issues/${issue.merged_into_id}`}>another issue</Link>.
          </p>
        )}
      </div>

      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent>
              <dl className="m-0 grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
                <dt className="text-muted">Officer</dt>
                <dd className="m-0 font-medium">{d.assignedName ?? "Unassigned"}</dd>
                <dt className="text-muted">Expected resolution</dt>
                <dd className="m-0 font-medium">
                  {issue.expected_resolution_at ? formatDateTime(issue.expected_resolution_at) : "Not confirmed"}
                  {issue.proposed_resolution_at && <span className="block text-xs font-normal text-muted">Proposed: {formatDateTime(issue.proposed_resolution_at)}</span>}
                </dd>
                <dt className="text-muted">Priority score</dt>
                <dd className="m-0 font-medium">
                  {issue.priority_score}{" "}
                  <span className="text-xs font-normal text-muted">
                    (severity {issue.severity}
                    {issue.academic_impact && ", academic impact"}
                    {issue.priority_override && `; override from ${PRIORITY_LABELS[issue.computed_priority]}: ${issue.priority_override_reason}`})
                  </span>
                </dd>
                <dt className="text-muted">Reports</dt>
                <dd className="m-0 font-medium">
                  {issue.total_submission_count} from {issue.distinct_reporter_count} student{issue.distinct_reporter_count === 1 ? "" : "s"}
                </dd>
                <dt className="text-muted">By department</dt>
                <dd className="m-0 font-medium">
                  {issue.sensitive ? (
                    <span className="font-normal text-muted">Withheld for sensitive issues</span>
                  ) : d.byDepartment.shown.length === 0 ? (
                    <span className="font-normal text-muted">Shown once {DEPARTMENT_DISCLOSURE_THRESHOLD}+ students from one department report this</span>
                  ) : (
                    <>
                      {d.byDepartment.shown.map((g) => `${g.name} ${g.students}`).join("  •  ")}
                      {d.byDepartment.withheldGroups > 0 && (
                        <span className="font-normal text-muted">
                          {" "}
                          &nbsp;•&nbsp; {d.byDepartment.withheldGroups} smaller department{d.byDepartment.withheldGroups === 1 ? "" : "s"} withheld
                        </span>
                      )}
                    </>
                  )}
                </dd>
                {issue.course_codes.length > 0 && (
                  <>
                    <dt className="text-muted">Courses</dt>
                    <dd className="m-0 font-medium">
                      {issue.course_codes.join(", ")}
                      {issue.academic_period && ` · ${issue.academic_period}`}
                    </dd>
                  </>
                )}
                {issue.summary && (
                  <>
                    <dt className="text-muted">Internal summary</dt>
                    <dd className="m-0">{issue.summary}</dd>
                  </>
                )}
                {issue.escalated && (
                  <>
                    <dt className="text-muted">Escalation</dt>
                    <dd className="m-0">
                      {formatDateTime(issue.escalated_at)} — {issue.escalation_reason}
                    </dd>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>

          {d.reviews.length > 0 && can(role, "matches.review") && (
            <Link href="/admin/match-review" className="block no-underline">
              <Alert tone="warning">
                {d.reviews.length} new submission{d.reviews.length === 1 ? "" : "s"} may belong to this issue — review matches →
              </Alert>
            </Link>
          )}

          {reviewRequests.length > 0 &&
            can(role, "issues.handle_review_requests") &&
            reviewRequests.map((c) => (
              <form key={c.id} action={act.reviewRequestAction}>
                <Alert tone="warning">
                  <b className="mb-0.5 block">Student review request</b>
                  {c.reporter}: &ldquo;{c.review_request_reason}&rdquo;
                  <Hidden issueId={issue.id} />
                  <input type="hidden" name="complaintId" value={c.id} />
                  <Label htmlFor={`rr-${c.id}`} className="mt-2.5">
                    Response to the student
                  </Label>
                  <Textarea id={`rr-${c.id}`} name="message" rows={2} required placeholder="Explain what happens next" />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button name="decision" value="reopen" size="sm">
                      Reopen issue
                    </Button>
                    {can(role, "issues.merge_split") && (
                      <Button name="decision" value="separate" size="sm" variant="ghost">
                        Treat as new related issue
                      </Button>
                    )}
                    <Button name="decision" value="decline" size="sm" variant="ghost">
                      Keep resolved and explain
                    </Button>
                    {can(role, "messages.send_issue") && (
                      <Link href={`/admin/messages?tab=conversations&c=${c.id}`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                        Reply to reporter
                      </Link>
                    )}
                  </div>
                </Alert>
              </form>
            ))}

          <Card>
            <form action={act.splitAction}>
              <CardHeader>
                <CardTitle>Submissions ({d.complaints.length})</CardTitle>
              </CardHeader>
              <Hidden issueId={issue.id} />
              <ul className="m-0 list-none p-0">
                {d.complaints.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
                    {canSplit && (
                      <label className="flex min-h-6 items-start">
                        <input type="checkbox" name="complaintIds" value={c.id} className="mt-0.5 h-5 w-5 accent-brand-600" />
                        <span className="sr-only">Select {c.subject}</span>
                      </label>
                    )}
                    <div className="min-w-0 flex-1">
                      <b>{c.reporter}</b> {c.department && <Badge className="ml-1">{c.department}</Badge>}{" "}
                      <span className="text-xs text-muted">{formatDateTime(c.created_at)}</span>
                      <Link href={`/admin/complaints/${c.id}`} className="mt-0.5 block font-medium text-foreground no-underline hover:text-link hover:underline">
                        {c.subject}
                      </Link>
                      <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-[13px]">{c.description}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <ComplaintStatusBadge status={c.status} />
                        {can(role, "messages.send_issue") && (
                          <Link href={`/admin/messages?tab=conversations&c=${c.id}`} className="text-[13px] font-medium">
                            {unreadReplies.get(c.id) ? `${unreadReplies.get(c.id)} new repl${unreadReplies.get(c.id) === 1 ? "y" : "ies"}` : "Message"}
                          </Link>
                        )}
                      </div>
                    </div>
                    <Badge tone={c.match_method === "auto" ? "info" : c.match_method === "new_issue" ? "brand" : "neutral"}>
                      {c.match_method === "auto"
                        ? `Auto-grouped${c.match_confidence != null ? ` ${c.match_confidence.toFixed(2)}` : ""}`
                        : c.match_method === "new_issue"
                          ? "New issue"
                          : MATCH_STATUS_LABELS.manual}
                    </Badge>
                  </li>
                ))}
              </ul>
              {canSplit && d.complaints.length > 1 && (
                <div className="grid gap-2 border-t border-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div>
                    <Label htmlFor="split-target">Split selected into</Label>
                    <Select id="split-target" name="targetIssueId" defaultValue="new">
                      <option value="new">A new issue</option>
                      {otherIssues.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title} ({ISSUE_STATUS_LABELS[o.status]}, {o.total_submission_count})
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Input name="reason" placeholder="Reason (recorded in history)" aria-label="Reason for splitting" />
                  <Button variant="ghost" size="sm">
                    Split selected
                  </Button>
                </div>
              )}
            </form>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Published updates</CardTitle>
            </CardHeader>
            <CardContent>
              {d.updates.length === 0 ? (
                <p className="text-sm text-muted">Nothing published yet. Students see &ldquo;{COPY.noDeadline}&rdquo; until a date is set.</p>
              ) : (
                <Timeline
                  items={d.updates.map((u) => ({
                    key: u.id,
                    content: <span className="whitespace-pre-line">{u.message}</span>,
                    time: `${formatDateTime(u.created_at)}  •  ${u.author}  •  ${u.update_type === "institutional_response" ? "institutional response" : u.update_type.replace("_", " ")}  •  ${u.visibility === "public" ? "public" : "reporters only"}`,
                  }))}
                />
              )}
            </CardContent>
          </Card>

          {(can(role, "issues.view_internal_notes") || can(role, "issues.view_oversight_notes")) && (
            <Card>
              <CardHeader>
                <CardTitle>Staff notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.notes.length === 0 ? (
                  <p className="text-sm text-muted">No notes. Notes are never shown to students.</p>
                ) : (
                  d.notes.map((n) =>
                    n.visibility === "oversight" ? (
                      <div key={n.id} className="rounded-[var(--radius-m)] border border-violet-fg/30 bg-violet-bg px-3.5 py-3 text-sm">
                        <p className="mb-1.5 flex justify-between gap-2 text-xs text-muted">
                          <b className="text-violet-fg">Restricted oversight note</b>
                          <span>Association Admin and management</span>
                        </p>
                        <p className="whitespace-pre-line">{n.note}</p>
                        <p className="mt-1 text-xs text-muted">
                          {n.author} · {formatDateTime(n.created_at)}
                        </p>
                      </div>
                    ) : (
                      <div key={n.id} className="rounded-[var(--radius-m)] border border-border bg-sunken px-3.5 py-3 text-sm">
                        <p className="mb-1.5 flex justify-between gap-2 text-xs text-muted">
                          <b className="text-foreground">Internal note</b>
                          <span>Association staff only</span>
                        </p>
                        <p className="whitespace-pre-line">{n.note}</p>
                        <p className="mt-1 text-xs text-muted">
                          {n.author} · {formatDateTime(n.created_at)}
                        </p>
                      </div>
                    ),
                  )
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline
                items={d.events.map((e) => ({
                  key: e.id,
                  content: (
                    <>
                      <b className="font-semibold">{e.actor ?? (e.actor_type === "system" ? "System" : e.actor_type === "student" ? "Student" : "Staff")}</b>{" "}
                      {e.event_type.replace(/_/g, " ")}
                      {e.event_type.includes("status") || e.event_type === "reopened" ? ` ${e.previous_value ?? ""} → ${e.new_value ?? ""}` : ""}
                      {e.event_type === "priority_changed" || e.event_type === "priority_override" ? ` → ${e.new_value ?? "automatic"}` : ""}
                      {e.event_type === "deadline_changed" && ` → ${e.new_value ? formatDateTime(e.new_value) : "removed"}`}
                      {e.reason && <span className="text-muted"> — {e.reason}</span>}
                    </>
                  ),
                  time: formatDateTime(e.created_at),
                }))}
              />
            </CardContent>
          </Card>
        </div>

        {!merged && <ActionTabs tabs={tabs} note={ROLE_NOTE[role]} />}
      </div>
    </div>
  );
}
