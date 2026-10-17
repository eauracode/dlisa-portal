import { one, rows, withTransaction, type Db } from "../../db";
import { audit } from "../../audit";
import { assertCan, can, issueScopeSql } from "../../auth/permissions";
import { formatDateTime } from "@/lib/format";
import { COPY } from "@/config/app";
import type { IssueStatus, Priority } from "../../validation";
import {
  addComplaintEvent,
  addIssueEvent,
  createIssueFromComplaint,
  ISSUE_TO_COMPLAINT_STATUS,
  linkComplaintToIssue,
  recalculatePriority,
  refreshIssueAggregates,
} from "../consolidation";
import { getPriorityConfig } from "../settings";
import { departmentBreakdown, issueDepartmentCounts, issueDepartmentFilterSql, reporterDepartment } from "./departments";
import { ActionError, ISSUE_COLUMNS, loadIssueForAdmin, NotFoundError, reporterNamer, seesStudentIdentity, type AdminContext, type IssueRow } from "./context";

const OPEN_STATUSES = ["new", "under_review", "in_progress", "awaiting_external_action"];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface IssueFilters {
  q?: string;
  department?: string;
  status?: string;
  priority?: string;
  categoryId?: number;
  assigned?: string; // admin id | "unassigned"
  overdue?: boolean;
  escalated?: boolean;
  from?: Date | null;
  to?: Date | null;
}

export interface IssueListRow extends IssueRow {
  category: string;
  assigned_name: string | null;
  overdue: boolean;
  pending_reviews: number;
  review_requests: number;
}

export async function listIssues(db: Db, admin: AdminContext, f: IssueFilters): Promise<IssueListRow[]> {
  const params: unknown[] = [];
  const where: string[] = ["i.status <> 'merged'"];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const scope = issueScopeSql(admin, "i", params.length + 1);
  params.push(...scope.params);
  where.push(scope.sql);
  if (f.q) where.push(`(i.title ilike ${p(`%${f.q}%`)} or i.summary ilike $${params.length} or array_to_string(i.course_codes, ' ') ilike $${params.length})`);
  if (f.status === "open") where.push(`i.status in ('new','under_review','in_progress','awaiting_external_action')`);
  else if (f.status) where.push(`i.status = ${p(f.status)}`);
  if (f.priority) where.push(`i.priority = ${p(f.priority)}`);
  if (f.categoryId) where.push(`i.category_id = ${p(f.categoryId)}`);
  if (f.department) {
    params.push(f.department);
    where.push(issueDepartmentFilterSql("i", params.length));
  }
  if (f.assigned === "unassigned") where.push(`i.assigned_admin_id is null`);
  else if (f.assigned) where.push(`i.assigned_admin_id = ${p(f.assigned)}`);
  if (f.overdue) where.push(`i.expected_resolution_at < now() and i.status not in ('resolved','closed')`);
  if (f.escalated) where.push(`i.escalated`);
  if (f.from) where.push(`i.created_at >= ${p(f.from)}`);
  if (f.to) where.push(`i.created_at < ${p(f.to)}`);

  return rows<IssueListRow>(
    db,
    `select ${ISSUE_COLUMNS.split(",").map((c) => `i.${c.trim()}`).join(", ")},
            cat.name as category, a.display_name as assigned_name,
            (i.expected_resolution_at is not null and i.expected_resolution_at < now() and i.status not in ('resolved','closed')) as overdue,
            (select count(*)::int from ai_match_reviews r where r.candidate_issue_id = i.id and r.review_status = 'pending') as pending_reviews,
            (select count(*)::int from complaints c where c.consolidated_issue_id = i.id and c.status = 'review_requested') as review_requests
       from consolidated_issues i
       join issue_categories cat on cat.id = i.category_id
       left join admin_users a on a.id = i.assigned_admin_id
      where ${where.join(" and ")}
      order by case i.priority when 'critical' then 0 when 'high' then 1 when 'elevated' then 2 else 3 end,
               (i.status in ('resolved','closed')), i.last_activity_at desc
      limit 300`,
    params,
  );
}

export async function getIssueDetail(db: Db, admin: AdminContext, issueId: string) {
  const issue = await loadIssueForAdmin(db, admin, issueId);
  const [category, assigned, complaints, updates, notes, events, proposals, reviews, officers] = await Promise.all([
    one<{ name: string }>(db, `select name from issue_categories where id = $1`, [issue.category_id]),
    issue.assigned_admin_id ? one<{ display_name: string }>(db, `select display_name from admin_users where id = $1`, [issue.assigned_admin_id]) : null,
    rows<{ id: string; student_id: string; department_code: string | null; subject: string; description: string; status: string; match_status: string; created_at: Date; review_request_reason: string | null; match_method: string | null; match_confidence: number | null }>(
      db,
      `select c.id, c.student_id, c.department_code, c.subject, c.description, c.status, c.match_status, c.created_at, c.review_request_reason,
              s.match_method, s.match_confidence
         from complaints c
         left join issue_submissions s on s.complaint_id = c.id and s.unlinked_at is null
        where c.consolidated_issue_id = $1 order by c.created_at`,
      [issueId],
    ),
    rows<{ id: string; update_type: string; message: string; visibility: string; created_at: Date; author: string }>(
      db,
      `select u.id, u.update_type, u.message, u.visibility, u.created_at, a.display_name as author
         from issue_updates u join admin_users a on a.id = u.author_admin_id
        where u.consolidated_issue_id = $1 order by u.created_at desc`,
      [issueId],
    ),
    rows<{ id: string; note: string; visibility: string; created_at: Date; author: string }>(
      db,
      `select n.id, n.note, n.visibility, n.created_at, a.display_name as author
         from administrative_notes n join admin_users a on a.id = n.author_admin_id
        where n.consolidated_issue_id = $1
          and ((n.visibility = 'internal' and $2) or (n.visibility = 'oversight' and $3))
        order by n.created_at desc`,
      [issueId, can(admin.role, "issues.view_internal_notes"), can(admin.role, "issues.view_oversight_notes")],
    ),
    rows<{ id: string; event_type: string; previous_value: string | null; new_value: string | null; reason: string | null; actor_type: string; actor: string | null; created_at: Date }>(
      db,
      `select e.id, e.event_type, e.previous_value, e.new_value, e.reason, e.actor_type, a.display_name as actor, e.created_at
         from issue_events e left join admin_users a on a.id = e.actor_id and e.actor_type = 'admin'
        where e.consolidated_issue_id = $1 order by e.created_at desc limit 100`,
      [issueId],
    ),
    rows<{ id: string; proposal_type: string; proposed_deadline: Date | null; reason: string; status: string; created_at: Date; proposer: string }>(
      db,
      `select p.id, p.proposal_type, p.proposed_deadline, p.reason, p.status, p.created_at, a.display_name as proposer
         from issue_proposals p join admin_users a on a.id = p.proposed_by
        where p.consolidated_issue_id = $1 order by p.created_at desc`,
      [issueId],
    ),
    rows<{ id: string; complaint_id: string; confidence_score: number; explanation: string; review_kind: string }>(
      db,
      `select id, complaint_id, confidence_score, explanation, review_kind from ai_match_reviews
        where candidate_issue_id = $1 and review_status = 'pending'`,
      [issueId],
    ),
    rows<{ id: string; display_name: string; role: string }>(
      db,
      `select id, display_name, role from admin_users where active and role in ('union_admin','case_officer') order by display_name`,
    ),
  ]);

  // Association staff see usernames and departments. Oversight officers need case records for
  // escalated issues but see reporter codes, and departments under the privacy rule.
  const deptCounts = await issueDepartmentCounts(db, issueId);
  const name = await reporterNamer(db, admin, complaints.map((c) => c.student_id));
  const sees = seesStudentIdentity(admin);
  const reporters = complaints.map(({ student_id, department_code, ...c }) => ({
    ...c,
    reporter: name(student_id),
    department: reporterDepartment(department_code, deptCounts, issue.sensitive, sees),
  }));
  return {
    issue,
    byDepartment: departmentBreakdown(deptCounts, issue.sensitive),
    category: category?.name ?? "",
    assignedName: assigned?.display_name ?? null,
    complaints: reporters,
    updates,
    notes,
    events,
    proposals,
    reviews,
    officers,
    overdue: !!issue.expected_resolution_at && issue.expected_resolution_at < new Date() && !["resolved", "closed"].includes(issue.status),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function linkedComplaintIds(tx: Db, issueId: string): Promise<string[]> {
  return (await rows<{ id: string }>(tx, `select id from complaints where consolidated_issue_id = $1`, [issueId])).map((r) => r.id);
}

/** Record a student-visible event on every complaint linked to the issue. */
async function notifyLinkedComplaints(
  tx: Db,
  issueId: string,
  admin: AdminContext,
  e: { eventType: string; message: string; previousValue?: string | null; newValue?: string | null },
) {
  for (const complaintId of await linkedComplaintIds(tx, issueId)) {
    await addComplaintEvent(tx, { complaintId, actorType: "admin", actorId: admin.id, ...e });
  }
}

async function touch(tx: Db, issueId: string) {
  await tx.query(`update consolidated_issues set updated_at = now(), last_activity_at = now() where id = $1`, [issueId]);
}

function requireReason(reason: string | undefined | null, what: string): string {
  const r = (reason ?? "").trim();
  if (r.length < 3) throw new ActionError(`Please give a reason for ${what}.`);
  if (r.length > 1000) throw new ActionError("Reason must be at most 1000 characters.");
  return r;
}

// ---------------------------------------------------------------------------
// Mutations (each runs in one transaction with row locks)
// ---------------------------------------------------------------------------

export async function assignOfficer(admin: AdminContext, issueId: string, officerId: string | null) {
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.assign", forUpdate: true });
    if (officerId) {
      const officer = await one<{ id: string }>(tx, `select id from admin_users where id = $1 and active and role in ('union_admin','case_officer')`, [officerId]);
      if (!officer) throw new ActionError("Choose an active Association Administrator or Case Officer.");
    }
    if (issue.assigned_admin_id === officerId) return;
    await tx.query(`update consolidated_issues set assigned_admin_id = $2 where id = $1`, [issueId, officerId]);
    await tx.query(`insert into issue_assignments (consolidated_issue_id, admin_user_id, assigned_by) values ($1, $2, $3)`, [issueId, officerId, admin.id]);
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "assigned", previousValue: issue.assigned_admin_id, newValue: officerId });
    if (issue.status === "new") await applyStatus(tx, admin, issue, "under_review", null);
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.assigned", entityType: "issue", entityId: issueId, metadata: { officerId } });
  });
}

export async function setDeadline(admin: AdminContext, issueId: string, deadline: Date | null, reason: string | null) {
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.set_deadline", forUpdate: true });
    await applyDeadline(tx, admin, issue, deadline, reason);
  });
}

async function applyDeadline(tx: Db, admin: AdminContext, issue: IssueRow, deadline: Date | null, reason: string | null) {
  const previous = issue.expected_resolution_at;
  if ((previous?.getTime() ?? null) === (deadline?.getTime() ?? null)) return;
  // Changing or removing a confirmed date needs a recorded reason.
  const why = previous ? requireReason(reason, "changing the expected resolution date") : (reason?.trim() || null);
  if (deadline && deadline.getTime() < Date.now() - 60_000) throw new ActionError("The expected resolution date must be in the future.");
  await tx.query(`update consolidated_issues set expected_resolution_at = $2, proposed_resolution_at = null where id = $1`, [issue.id, deadline]);
  await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: "deadline_changed", previousValue: previous?.toISOString() ?? null, newValue: deadline?.toISOString() ?? null, reason: why });
  await notifyLinkedComplaints(tx, issue.id, admin, {
    eventType: "deadline_changed",
    previousValue: previous?.toISOString() ?? null,
    newValue: deadline?.toISOString() ?? null,
    message: deadline
      ? `${previous ? "The expected resolution date was revised" : "An expected resolution date was set"}: ${formatDateTime(deadline)}.${why && previous ? ` Reason: ${why}` : ""}`
      : `The expected resolution date was withdrawn. ${COPY.noDeadline}`,
  });
  await recalculatePriority(tx, issue.id, await getPriorityConfig(tx));
  await touch(tx, issue.id);
  await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.deadline_changed", entityType: "issue", entityId: issue.id, metadata: { from: previous, to: deadline } });
}

const STATUS_LABELS: Record<string, string> = {
  new: "Received",
  under_review: "Under review",
  in_progress: "In progress",
  awaiting_external_action: "Awaiting action from another office",
  resolved: "Resolved",
  closed: "Closed",
};

export async function applyStatus(tx: Db, admin: AdminContext, issue: IssueRow, status: IssueStatus, resolutionNote: string | null) {
  if (issue.status === status) return;
  const resolving = status === "resolved" || status === "closed";
  const reopening = ["resolved", "closed"].includes(issue.status) && !resolving;
  await tx.query(
    `update consolidated_issues
        set status = $2,
            resolved_at = case when $3 then coalesce(resolved_at, now()) else null end,
            resolution_note = case when $3 then coalesce($4, resolution_note) else resolution_note end
      where id = $1`,
    [issue.id, status, resolving, resolutionNote],
  );
  await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: reopening ? "reopened" : "status_changed", previousValue: issue.status, newValue: status, reason: resolutionNote });

  const complaintStatus = ISSUE_TO_COMPLAINT_STATUS[status];
  const linked = await rows<{ id: string; status: string }>(
    tx,
    // Submissions the student confirmed as answered stay resolved; they can ask for a review.
    `select id, status from complaints where consolidated_issue_id = $1 and resolved_by_student_at is null for update`,
    [issue.id],
  );
  for (const c of linked) {
    // An open review request is only cleared by reopening, not by re-resolving.
    if (c.status === "review_requested" && resolving) continue;
    // Moving an open issue along never reopens a submission that was already resolved on its own.
    if (!resolving && !reopening && ["resolved", "closed"].includes(c.status)) continue;
    if (c.status === complaintStatus) continue;
    await tx.query(`update complaints set status = $2, updated_at = now() where id = $1`, [c.id, complaintStatus]);
    await addComplaintEvent(tx, {
      complaintId: c.id,
      actorType: "admin",
      actorId: admin.id,
      eventType: "status_changed",
      previousValue: c.status,
      newValue: complaintStatus,
      message: status === "resolved" ? COPY.resolved : reopening ? "This issue has been reopened and is being looked at again." : null,
    });
  }
  if (status === "resolved" && resolutionNote) {
    await tx.query(
      `insert into issue_updates (consolidated_issue_id, author_admin_id, update_type, message, visibility)
       values ($1, $2, 'resolution', $3, $4)`,
      [issue.id, admin.id, resolutionNote, issue.public_visibility ? "public" : "reporters"],
    );
  }
  await recalculatePriority(tx, issue.id, await getPriorityConfig(tx));
  await touch(tx, issue.id);
}

export async function changeStatus(admin: AdminContext, issueId: string, status: IssueStatus, note: string | null) {
  if (status === "merged") throw new ActionError("Use the merge action to merge issues.");
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.update_status", forUpdate: true });
    if (issue.status === "merged") throw new ActionError("This issue has been merged into another issue.");
    const reopening = ["resolved", "closed"].includes(issue.status) && !["resolved", "closed"].includes(status);
    if (reopening) assertCan(admin.role, "issues.reopen");
    if (status === "resolved" && !(note ?? "").trim()) throw new ActionError("Add a resolution note explaining what was done. It will be shared with the students who reported this issue.");
    await applyStatus(tx, admin, issue, status, note?.trim() || null);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: reopening ? "issue.reopened" : "issue.status_changed", entityType: "issue", entityId: issueId, metadata: { from: issue.status, to: status } });
  });
}

export async function overridePriority(admin: AdminContext, issueId: string, priority: Priority | null, reason: string | null) {
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.set_priority", forUpdate: true });
    const why = priority ? requireReason(reason, "overriding the priority") : (reason?.trim() || "Override removed");
    await tx.query(`update consolidated_issues set priority_override = $2, priority_override_reason = $3 where id = $1`, [issueId, priority, priority ? why : null]);
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "priority_override", previousValue: issue.priority_override, newValue: priority, reason: why });
    await recalculatePriority(tx, issueId, await getPriorityConfig(tx));
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.priority_override", entityType: "issue", entityId: issueId, metadata: { priority } });
  });
}

export async function publishUpdate(
  admin: AdminContext,
  issueId: string,
  input: { message: string; visibility: "reporters" | "public"; type?: "progress" | "institutional_response" },
) {
  const message = input.message.trim();
  if (message.length < 5 || message.length > 4000) throw new ActionError("Updates must be between 5 and 4000 characters.");
  const type = input.type ?? "progress";
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, {
      permission: type === "institutional_response" ? "issues.institutional_response" : "issues.publish_update",
      forUpdate: true,
    });
    if (input.visibility === "public" && !can(admin.role, "issues.visibility")) throw new ActionError("Only an Association Administrator can publish public updates.");
    if (input.visibility === "public" && issue.sensitive) throw new ActionError("Sensitive welfare issues cannot have public updates.");
    const update = await one<{ id: string }>(
      tx,
      `insert into issue_updates (consolidated_issue_id, author_admin_id, update_type, message, visibility)
       values ($1, $2, $3, $4, $5) returning id`,
      [issueId, admin.id, type, message, input.visibility],
    );
    await notifyLinkedComplaints(tx, issueId, admin, {
      eventType: "update_published",
      newValue: update!.id,
      message: type === "institutional_response" ? "School management recorded a response on this issue." : "The Students' Association published an update on this issue.",
    });
    if (issue.status === "new") await applyStatus(tx, admin, issue, "under_review", null);
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.update_published", entityType: "issue", entityId: issueId, metadata: { visibility: input.visibility, type } });
  });
}

export async function addNote(admin: AdminContext, issueId: string, note: string, visibility: "internal" | "oversight") {
  const text = note.trim();
  if (text.length < 2 || text.length > 4000) throw new ActionError("Notes must be between 2 and 4000 characters.");
  return withTransaction(async (tx) => {
    await loadIssueForAdmin(tx, admin, issueId, { permission: visibility === "internal" ? "issues.internal_note" : "issues.oversight_note" });
    await tx.query(
      `insert into administrative_notes (consolidated_issue_id, author_admin_id, note, visibility) values ($1, $2, $3, $4)`,
      [issueId, admin.id, text, visibility],
    );
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: `issue.${visibility}_note_added`, entityType: "issue", entityId: issueId });
  });
}

export async function setPublicVisibility(
  admin: AdminContext,
  issueId: string,
  input: { visible: boolean; publicTitle?: string; publicSummary?: string },
) {
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.visibility", forUpdate: true });
    if (input.visible) {
      if (issue.sensitive) throw new ActionError("Sensitive welfare issues cannot be made public.");
      const title = (input.publicTitle ?? "").trim();
      const summary = (input.publicSummary ?? "").trim();
      if (title.length < 5 || title.length > 150) throw new ActionError("Enter an anonymised public title (5–150 characters).");
      if (summary.length < 10 || summary.length > 1000) throw new ActionError("Enter an approved public summary (10–1000 characters).");
      await tx.query(`update consolidated_issues set public_visibility = true, public_title = $2, public_summary = $3 where id = $1`, [issueId, title, summary]);
    } else {
      await tx.query(`update consolidated_issues set public_visibility = false where id = $1`, [issueId]);
    }
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "visibility_changed", previousValue: String(issue.public_visibility), newValue: String(input.visible) });
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.visibility_changed", entityType: "issue", entityId: issueId, metadata: { public: input.visible } });
  });
}

export async function editIssueDetails(admin: AdminContext, issueId: string, input: { title: string; summary: string; categoryId: number; sensitive: boolean }) {
  const title = input.title.trim();
  if (title.length < 5 || title.length > 150) throw new ActionError("Title must be 5–150 characters.");
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.edit_details", forUpdate: true });
    const cat = await one<{ id: number }>(tx, `select id from issue_categories where id = $1`, [input.categoryId]);
    if (!cat) throw new ActionError("Choose a valid category.");
    // A safety-flagged issue stays sensitive.
    const sensitive = input.sensitive || issue.safety_flag;
    await tx.query(
      `update consolidated_issues set title = $2, summary = $3, category_id = $4, sensitive = $5,
              public_visibility = public_visibility and not $5 where id = $1`,
      [issueId, title, input.summary.trim().slice(0, 2000), input.categoryId, sensitive],
    );
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "details_edited" });
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.details_edited", entityType: "issue", entityId: issueId, metadata: { categoryId: input.categoryId, sensitive } });
  });
}

export async function escalateIssue(admin: AdminContext, issueId: string, reason: string) {
  const why = requireReason(reason, "escalating to school management");
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.escalate", forUpdate: true });
    await applyEscalation(tx, admin, issue, why);
  });
}

async function applyEscalation(tx: Db, admin: AdminContext, issue: IssueRow, reason: string) {
  if (issue.escalated && issue.escalation_status !== "closed") throw new ActionError("This issue is already escalated.");
  await tx.query(
    `update consolidated_issues set escalated = true, escalated_at = now(), escalation_reason = $2, escalation_status = 'pending' where id = $1`,
    [issue.id, reason],
  );
  await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: "escalated", newValue: "pending", reason });
  await notifyLinkedComplaints(tx, issue.id, admin, { eventType: "escalated", message: "The Students' Association has referred this issue to school management." });
  await touch(tx, issue.id);
  await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.escalated", entityType: "issue", entityId: issue.id });
}

export async function setEscalationStatus(admin: AdminContext, issueId: string, status: "acknowledged" | "responded" | "closed", note: string | null) {
  return withTransaction(async (tx) => {
    const issue = await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.escalation_status", forUpdate: true });
    if (!issue.escalated) throw new ActionError("This issue has not been escalated.");
    await tx.query(`update consolidated_issues set escalation_status = $2 where id = $1`, [issueId, status]);
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "escalation_status", previousValue: issue.escalation_status, newValue: status, reason: note });
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.escalation_status", entityType: "issue", entityId: issueId, metadata: { status } });
  });
}

export async function createProposal(admin: AdminContext, issueId: string, input: { type: "deadline" | "escalation"; deadline: Date | null; reason: string }) {
  const why = requireReason(input.reason, "this proposal");
  return withTransaction(async (tx) => {
    await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.propose", forUpdate: true });
    if (input.type === "deadline") {
      if (!input.deadline || input.deadline.getTime() < Date.now()) throw new ActionError("Propose a future date and time.");
      await tx.query(`update consolidated_issues set proposed_resolution_at = $2 where id = $1`, [issueId, input.deadline]);
    }
    await tx.query(
      `insert into issue_proposals (consolidated_issue_id, proposal_type, proposed_deadline, reason, proposed_by) values ($1, $2, $3, $4, $5)`,
      [issueId, input.type, input.type === "deadline" ? input.deadline : null, why, admin.id],
    );
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: `${input.type}_proposed`, newValue: input.deadline?.toISOString() ?? null, reason: why });
    await touch(tx, issueId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: `issue.${input.type}_proposed`, entityType: "issue", entityId: issueId });
  });
}

export async function decideProposal(admin: AdminContext, proposalId: string, approve: boolean, note: string | null) {
  assertCan(admin.role, "issues.decide_proposals");
  return withTransaction(async (tx) => {
    const p = await one<{ id: string; consolidated_issue_id: string; proposal_type: string; proposed_deadline: Date | null; reason: string; status: string }>(
      tx,
      `select id, consolidated_issue_id, proposal_type, proposed_deadline, reason, status from issue_proposals where id = $1 for update`,
      [proposalId],
    );
    if (!p) throw new NotFoundError("Proposal");
    if (p.status !== "pending") throw new ActionError("This proposal has already been decided.");
    const issue = await loadIssueForAdmin(tx, admin, p.consolidated_issue_id, { forUpdate: true });
    await tx.query(`update issue_proposals set status = $2, decided_by = $3, decided_at = now() where id = $1`, [proposalId, approve ? "approved" : "rejected", admin.id]);
    if (approve && p.proposal_type === "deadline") await applyDeadline(tx, admin, issue, p.proposed_deadline, note || p.reason);
    if (approve && p.proposal_type === "escalation") await applyEscalation(tx, admin, issue, p.reason);
    if (!approve && p.proposal_type === "deadline") await tx.query(`update consolidated_issues set proposed_resolution_at = null where id = $1`, [issue.id]);
    await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: `proposal_${approve ? "approved" : "rejected"}`, newValue: p.proposal_type, reason: note });
    await audit(tx, { actorType: "admin", actorId: admin.id, action: `proposal.${approve ? "approved" : "rejected"}`, entityType: "issue_proposal", entityId: proposalId });
  });
}

/** Merge `sourceId` into `targetId`: every submission moves; the source is kept as 'merged'. */
export async function mergeIssues(admin: AdminContext, sourceId: string, targetId: string, reason: string) {
  const why = requireReason(reason, "merging these issues");
  if (sourceId === targetId) throw new ActionError("Choose a different issue to merge into.");
  return withTransaction(async (tx) => {
    // Lock in a consistent order to avoid deadlocks.
    const [first, second] = [sourceId, targetId].sort();
    await loadIssueForAdmin(tx, admin, first, { permission: "issues.merge_split", forUpdate: true });
    await loadIssueForAdmin(tx, admin, second, { forUpdate: true });
    const source = await loadIssueForAdmin(tx, admin, sourceId);
    const target = await loadIssueForAdmin(tx, admin, targetId);
    if (source.status === "merged" || target.status === "merged") throw new ActionError("One of these issues has already been merged.");

    for (const complaintId of await linkedComplaintIds(tx, sourceId)) {
      await linkComplaintToIssue(tx, { complaintId, issueId: targetId, method: "merge", actor: { type: "admin", id: admin.id } });
    }
    await tx.query(`update ai_match_reviews set candidate_issue_id = $2 where candidate_issue_id = $1 and review_status = 'pending'`, [sourceId, targetId]);
    await tx.query(
      `update consolidated_issues set status = 'merged', merged_into_id = $2, public_visibility = false,
              escalated = escalated, updated_at = now() where id = $1`,
      [sourceId, targetId],
    );
    // Carry over escalation and sensitivity so nothing is lost by merging.
    await tx.query(
      `update consolidated_issues t set
          sensitive = t.sensitive or s.sensitive,
          safety_flag = t.safety_flag or s.safety_flag,
          escalated = t.escalated or s.escalated,
          escalated_at = coalesce(t.escalated_at, s.escalated_at),
          escalation_status = coalesce(t.escalation_status, s.escalation_status),
          escalation_reason = coalesce(t.escalation_reason, s.escalation_reason)
        from consolidated_issues s where t.id = $1 and s.id = $2`,
      [targetId, sourceId],
    );
    await addIssueEvent(tx, { issueId: sourceId, actorType: "admin", actorId: admin.id, eventType: "merged_into", newValue: targetId, reason: why });
    await addIssueEvent(tx, { issueId: targetId, actorType: "admin", actorId: admin.id, eventType: "merged_from", newValue: sourceId, reason: why });
    await refreshIssueAggregates(tx, targetId);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.merged", entityType: "issue", entityId: sourceId, metadata: { into: targetId } });
  });
}

/** Move selected submissions out of an issue, into a new issue or another existing issue. */
export async function splitIssue(admin: AdminContext, issueId: string, complaintIds: string[], targetIssueId: string | null, reason: string): Promise<string> {
  const why = requireReason(reason, "separating these submissions");
  if (!complaintIds.length) throw new ActionError("Select at least one submission to separate.");
  return withTransaction(async (tx) => {
    await loadIssueForAdmin(tx, admin, issueId, { permission: "issues.merge_split", forUpdate: true });
    const linked = new Set(await linkedComplaintIds(tx, issueId));
    if (complaintIds.some((id) => !linked.has(id))) throw new ActionError("Some selected submissions are not part of this issue.");
    if (complaintIds.length === linked.size && !targetIssueId) throw new ActionError("To move every submission, merge the issue instead.");

    let destination = targetIssueId;
    if (destination) {
      const target = await loadIssueForAdmin(tx, admin, destination, { forUpdate: true });
      if (target.status === "merged") throw new ActionError("Cannot move submissions into a merged issue.");
    } else {
      destination = await createIssueFromComplaint(tx, complaintIds[0], { type: "admin", id: admin.id });
    }
    for (const complaintId of complaintIds) {
      await linkComplaintToIssue(tx, { complaintId, issueId: destination, method: "split", actor: { type: "admin", id: admin.id } });
    }
    await addIssueEvent(tx, { issueId, actorType: "admin", actorId: admin.id, eventType: "split", newValue: destination, reason: why });
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "issue.split", entityType: "issue", entityId: issueId, metadata: { destination, count: complaintIds.length } });
    return destination;
  });
}

/**
 * Respond to a student's request to review a resolved complaint:
 *  - reopen: reopen the whole issue (all linked complaints return to in progress)
 *  - separate: treat as a new instance; move the complaint to a new related issue
 *  - decline: keep it resolved and explain why to that student only
 */
export async function handleReviewRequest(admin: AdminContext, complaintId: string, action: "reopen" | "separate" | "decline", message: string) {
  assertCan(admin.role, "issues.handle_review_requests");
  const text = message.trim();
  if (text.length < 5 || text.length > 2000) throw new ActionError("Add a short explanation for the student (5–2000 characters).");
  return withTransaction(async (tx) => {
    const c = await one<{ id: string; status: string; consolidated_issue_id: string | null }>(
      tx,
      `select id, status, consolidated_issue_id from complaints where id = $1 for update`,
      [complaintId],
    );
    if (!c?.consolidated_issue_id) throw new NotFoundError("Complaint");
    const issue = await loadIssueForAdmin(tx, admin, c.consolidated_issue_id, { forUpdate: true });
    if (c.status !== "review_requested") throw new ActionError("This complaint has no open review request.");

    if (action === "reopen") {
      assertCan(admin.role, "issues.reopen");
      if (["resolved", "closed"].includes(issue.status)) await applyStatus(tx, admin, issue, "in_progress", null);
      // If the issue was already open again, applyStatus did not touch this complaint.
      const current = await one<{ status: string }>(tx, `select status from complaints where id = $1`, [complaintId]);
      if (current?.status === "review_requested") {
        const reopened = await one<{ status: string }>(tx, `select status from consolidated_issues where id = $1`, [issue.id]);
        const next = ISSUE_TO_COMPLAINT_STATUS[reopened!.status] ?? "in_progress";
        await tx.query(`update complaints set status = $2, updated_at = now() where id = $1`, [complaintId, next]);
        await addComplaintEvent(tx, { complaintId, actorType: "admin", actorId: admin.id, eventType: "status_changed", previousValue: "review_requested", newValue: next });
      }
    } else if (action === "separate") {
      assertCan(admin.role, "issues.merge_split");
      const newIssue = await createIssueFromComplaint(tx, complaintId, { type: "admin", id: admin.id });
      await tx.query(`update complaints set status = 'received' where id = $1`, [complaintId]);
      await linkComplaintToIssue(tx, { complaintId, issueId: newIssue, method: "split", actor: { type: "admin", id: admin.id } });
      await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: "related_issue_created", newValue: newIssue });
    } else {
      await tx.query(`update complaints set status = $2, updated_at = now() where id = $1`, [complaintId, ISSUE_TO_COMPLAINT_STATUS[issue.status] ?? "resolved"]);
      await addComplaintEvent(tx, { complaintId, actorType: "admin", actorId: admin.id, eventType: "status_changed", previousValue: "review_requested", newValue: ISSUE_TO_COMPLAINT_STATUS[issue.status] ?? "resolved" });
    }
    await tx.query(`update complaints set review_request_reason = null where id = $1`, [complaintId]);
    await addComplaintEvent(tx, { complaintId, actorType: "admin", actorId: admin.id, eventType: "review_response", newValue: action, message: text });
    await addIssueEvent(tx, { issueId: issue.id, actorType: "admin", actorId: admin.id, eventType: "review_request_handled", newValue: action, reason: text });
    await audit(tx, { actorType: "admin", actorId: admin.id, action: `complaint.review_${action}`, entityType: "complaint", entityId: complaintId });
  });
}

export async function issueOptionsForSelect(db: Db, admin: AdminContext, excludeId?: string) {
  const scope = issueScopeSql(admin, "i", 2);
  return rows<{ id: string; title: string; status: string; total_submission_count: number }>(
    db,
    `select i.id, i.title, i.status, i.total_submission_count from consolidated_issues i
      where i.status <> 'merged' and i.id is distinct from $1 and ${scope.sql}
      order by (i.status in ('resolved','closed')), i.last_activity_at desc limit 200`,
    [excludeId ?? null, ...scope.params],
  );
}

export { OPEN_STATUSES, STATUS_LABELS, applyStatus as applyIssueStatus };
