import { one, rows, withTransaction, type Db } from "../../db";
import { audit } from "../../audit";
import { assertCan, canAccessIssue, issueScopeSql } from "../../auth/permissions";
import { enqueueMatchJob } from "../../matching/jobs";
import { addComplaintEvent, createIssueFromComplaint, linkComplaintToIssue } from "../consolidation";
import { applyIssueStatus } from "./issues";
import { issueDepartmentCounts, issueDepartmentFilterSql, reporterDepartment } from "./departments";
import { departmentForStaff } from "../../privacy";
import { ActionError, loadIssueForAdmin, NotFoundError, reporterNamer, seesStudentIdentity, type AdminContext } from "./context";
import { departmentName } from "../../departments";

export interface ComplaintFilters {
  q?: string;
  status?: string;
  matchStatus?: string;
  categoryId?: number;
  department?: string;
  from?: Date | null;
  to?: Date | null;
}

export interface AdminComplaintRow {
  id: string;
  subject: string;
  category: string;
  status: string;
  match_status: string;
  created_at: Date;
  consolidated_issue_id: string | null;
  issue_title: string | null;
  reporter: string;
  /** Null when withheld (sensitive issue, or fewer than 5 students from that department). */
  department: string | null;
}

/**
 * Association administrators see every complaint (including unmatched ones). Other roles see only
 * complaints attached to issues within their scope.
 */
export async function listComplaints(db: Db, admin: AdminContext, f: ComplaintFilters): Promise<AdminComplaintRow[]> {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (admin.role !== "union_admin") {
    const scope = issueScopeSql(admin, "i", params.length + 1);
    params.push(...scope.params);
    where.push(`c.consolidated_issue_id is not null and ${scope.sql}`);
  }
  if (f.q) where.push(`(c.subject ilike ${p(`%${f.q}%`)} or c.description ilike $${params.length})`);
  if (f.status) where.push(`c.status = ${p(f.status)}`);
  if (f.matchStatus) where.push(`c.match_status = ${p(f.matchStatus)}`);
  if (f.categoryId) where.push(`c.category_id = ${p(f.categoryId)}`);
  if (f.department) {
    params.push(f.department);
    where.push(`c.department_code = $${params.length} and exists (select 1 from consolidated_issues di where di.id = c.consolidated_issue_id and ${issueDepartmentFilterSql("di", params.length)})`);
  }
  if (f.from) where.push(`c.created_at >= ${p(f.from)}`);
  if (f.to) where.push(`c.created_at < ${p(f.to)}`);

  const result = await rows<Omit<AdminComplaintRow, "reporter" | "department"> & { student_id: string; department_code: string | null; dept_reporters: number; issue_sensitive: boolean | null }>(
    db,
    `select c.id, c.subject, cat.name as category, c.status, c.match_status, c.created_at, c.consolidated_issue_id,
            i.title as issue_title, c.student_id, c.department_code, coalesce(i.sensitive, true) as issue_sensitive,
            (select count(distinct x.student_id)::int from complaints x
              where x.consolidated_issue_id = c.consolidated_issue_id and x.department_code = c.department_code) as dept_reporters
       from complaints c
       join issue_categories cat on cat.id = c.category_id
       left join consolidated_issues i on i.id = c.consolidated_issue_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by c.created_at desc limit 300`,
    params,
  );
  const name = await reporterNamer(db, admin, result.map((r) => r.student_id));
  const sees = seesStudentIdentity(admin);
  return result.map(({ student_id, department_code, dept_reporters, issue_sensitive, ...r }) => ({
    ...r,
    reporter: name(student_id),
    department: sees ? departmentName(department_code) : departmentForStaff({ departmentCode: department_code, sameDepartmentReportersOnIssue: dept_reporters, issueIsSensitive: !!issue_sensitive }),
  }));
}

export async function getComplaintForAdmin(db: Db, admin: AdminContext, complaintId: string) {
  const c = await one<{
    id: string; student_id: string; department_code: string | null; subject: string; description: string; category: string; category_id: number; status: string;
    match_status: string; created_at: Date; consolidated_issue_id: string | null; review_request_reason: string | null;
  }>(
    db,
    `select c.id, c.student_id, c.department_code, c.subject, c.description, cat.name as category, c.category_id, c.status, c.match_status,
            c.created_at, c.consolidated_issue_id, c.review_request_reason
       from complaints c join issue_categories cat on cat.id = c.category_id where c.id = $1`,
    [complaintId],
  );
  if (!c) throw new NotFoundError("Complaint");
  if (admin.role !== "union_admin") {
    if (!c.consolidated_issue_id) throw new NotFoundError("Complaint");
    const issue = await one<{ assigned_admin_id: string | null; escalated: boolean }>(db, `select assigned_admin_id, escalated from consolidated_issues where id = $1`, [c.consolidated_issue_id]);
    if (!issue || !canAccessIssue(admin, issue)) throw new NotFoundError("Complaint");
  }
  const [analysis, links, reviews, events, job, issue] = await Promise.all([
    one<{ summary_title: string; problem_type: string | null; severity: string; course_codes: string[]; academic_period: string | null; safety_flag: boolean; classifier_provider: string; classifier_model: string; embedding_model: string }>(
      db,
      `select summary_title, problem_type, severity, course_codes, academic_period, safety_flag, classifier_provider, classifier_model, embedding_model
         from complaint_analyses where complaint_id = $1`,
      [complaintId],
    ),
    rows<{ consolidated_issue_id: string; title: string; match_method: string; match_confidence: number | null; model_version: string | null; matched_at: Date; unlinked_at: Date | null }>(
      db,
      `select s.consolidated_issue_id, i.title, s.match_method, s.match_confidence, s.model_version, s.matched_at, s.unlinked_at
         from issue_submissions s join consolidated_issues i on i.id = s.consolidated_issue_id
        where s.complaint_id = $1 order by s.matched_at desc`,
      [complaintId],
    ),
    rows<{ id: string; candidate_issue_id: string; title: string; confidence_score: number; review_status: string; explanation: string; created_at: Date }>(
      db,
      `select r.id, r.candidate_issue_id, i.title, r.confidence_score, r.review_status, r.explanation, r.created_at
         from ai_match_reviews r join consolidated_issues i on i.id = r.candidate_issue_id
        where r.complaint_id = $1 order by r.created_at desc`,
      [complaintId],
    ),
    rows<{ id: string; event_type: string; message: string | null; visible_to_student: boolean; actor_type: string; created_at: Date }>(
      db,
      `select id, event_type, message, visible_to_student, actor_type, created_at from complaint_events where complaint_id = $1 order by created_at`,
      [complaintId],
    ),
    one<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(
      db,
      `select status, attempts, last_error, next_attempt_at from match_jobs where complaint_id = $1`,
      [complaintId],
    ),
    c.consolidated_issue_id ? one<{ id: string; title: string; status: string }>(db, `select id, title, status from consolidated_issues where id = $1`, [c.consolidated_issue_id]) : null,
  ]);
  const { student_id, department_code, ...complaint } = c;
  const deptCounts = c.consolidated_issue_id ? await issueDepartmentCounts(db, c.consolidated_issue_id) : [];
  const issueSensitive = c.consolidated_issue_id
    ? ((await one<{ sensitive: boolean }>(db, `select sensitive from consolidated_issues where id = $1`, [c.consolidated_issue_id]))?.sensitive ?? true)
    : true;
  const department = reporterDepartment(department_code, deptCounts, issueSensitive, seesStudentIdentity(admin));
  const name = await reporterNamer(db, admin, [student_id]);
  return { complaint: { ...complaint, reporter: name(student_id), department }, analysis, links, reviews, events, job, issue };
}

/** Manually (re)group a complaint: into an existing issue, or into a new issue. */
export async function reassignComplaint(admin: AdminContext, complaintId: string, targetIssueId: string | "new", reason: string) {
  assertCan(admin.role, "complaints.reassign");
  if (reason.trim().length < 3) throw new ActionError("Please give a reason for regrouping this complaint.");
  return withTransaction(async (tx) => {
    const c = await one<{ id: string; consolidated_issue_id: string | null }>(tx, `select id, consolidated_issue_id from complaints where id = $1 for update`, [complaintId]);
    if (!c) throw new NotFoundError("Complaint");
    let destination: string;
    if (targetIssueId === "new") {
      destination = await createIssueFromComplaint(tx, complaintId, { type: "admin", id: admin.id });
    } else {
      const target = await loadIssueForAdmin(tx, admin, targetIssueId, { forUpdate: true });
      if (target.status === "merged") throw new ActionError("Cannot move a complaint into a merged issue.");
      destination = target.id;
    }
    await linkComplaintToIssue(tx, { complaintId, issueId: destination, method: "manual", actor: { type: "admin", id: admin.id } });
    // Any outstanding AI suggestion or retry is now moot.
    await tx.query(
      `update ai_match_reviews set review_status = 'superseded', reviewed_by = $2, reviewed_at = now(), decision_reason = $3
        where complaint_id = $1 and review_status = 'pending'`,
      [complaintId, admin.id, `Manually regrouped: ${reason.trim()}`],
    );
    await tx.query(`update match_jobs set status = 'cancelled', updated_at = now() where complaint_id = $1 and status in ('pending','failed')`, [complaintId]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "complaint.regrouped", entityType: "complaint", entityId: complaintId, metadata: { from: c.consolidated_issue_id, to: destination } });
    return destination;
  });
}

export async function retryMatching(admin: AdminContext, complaintId: string) {
  assertCan(admin.role, "jobs.run");
  return withTransaction(async (tx) => {
    const c = await one<{ consolidated_issue_id: string | null }>(tx, `select consolidated_issue_id from complaints where id = $1 for update`, [complaintId]);
    if (!c) throw new NotFoundError("Complaint");
    if (c.consolidated_issue_id) throw new ActionError("This complaint is already grouped.");
    await tx.query(`update complaints set match_status = 'pending' where id = $1 and match_status = 'failed'`, [complaintId]);
    await enqueueMatchJob(tx, complaintId);
    await tx.query(`update match_jobs set attempts = 0 where complaint_id = $1 and status = 'pending'`, [complaintId]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "complaint.matching_retried", entityType: "complaint", entityId: complaintId });
  });
}

// ---------------------------------------------------------------------------
// Match review queue
// ---------------------------------------------------------------------------

export async function listPendingReviews(db: Db, admin: AdminContext) {
  assertCan(admin.role, "matches.review");
  const list = await rows<{
    id: string; complaint_id: string; subject: string; description: string; complaint_category: string; created_at: Date;
    candidate_issue_id: string; issue_title: string; issue_summary: string; issue_status: string; issue_count: number;
    confidence_score: number; explanation: string; review_kind: string; model_version: string;
    review_reason: string | null; issue_sensitive: boolean; complaint_sensitivity: string | null;
    reporter_department: string | null; dept_reporters: number; student_id: string;
  }>(
    db,
    `select r.id, r.complaint_id, c.subject, c.description, cc.name as complaint_category, r.created_at,
            r.candidate_issue_id, i.title as issue_title, i.summary as issue_summary, i.status as issue_status,
            i.total_submission_count as issue_count, r.confidence_score, r.explanation, r.review_kind, r.model_version,
            r.review_reason, i.sensitive as issue_sensitive, a.sensitivity as complaint_sensitivity, c.department_code as reporter_department, c.student_id,
            (select count(distinct x.student_id)::int from complaints x
              where x.consolidated_issue_id = r.candidate_issue_id and x.department_code = c.department_code) as dept_reporters
       from ai_match_reviews r
       left join complaint_analyses a on a.complaint_id = r.complaint_id
       join complaints c on c.id = r.complaint_id
       join issue_categories cc on cc.id = c.category_id
       join consolidated_issues i on i.id = r.candidate_issue_id
      where r.review_status = 'pending'
      order by r.created_at`,
  );
  // The reporter's department is shown only when the proposed issue already has 5+ students
  // from that department and is not sensitive (same rule as everywhere else).
  const name = await reporterNamer(db, admin, list.map((r) => r.student_id));
  const sees = seesStudentIdentity(admin);
  return list.map(({ reporter_department, dept_reporters, student_id, ...r }) => ({
    ...r,
    reporter: name(student_id),
    department: sees ? departmentName(reporter_department) : departmentForStaff({ departmentCode: reporter_department, sameDepartmentReportersOnIssue: dept_reporters, issueIsSensitive: r.issue_sensitive }),
  }));
}

async function closeReview(tx: Db, reviewId: string, admin: AdminContext, status: string, reason: string | null) {
  await tx.query(
    `update ai_match_reviews set review_status = $2, reviewed_by = $3, reviewed_at = now(), decision_reason = $4 where id = $1`,
    [reviewId, status, admin.id, reason],
  );
}

export type ReviewDecision =
  | { action: "confirm"; reopenIfResolved?: boolean }
  | { action: "reject" }
  | { action: "reassign"; issueId: string };

export async function decideReview(admin: AdminContext, reviewId: string, decision: ReviewDecision, reason: string | null) {
  assertCan(admin.role, "matches.review");
  return withTransaction(async (tx) => {
    const r = await one<{ id: string; complaint_id: string; candidate_issue_id: string; confidence_score: number; model_version: string; review_status: string }>(
      tx,
      `select id, complaint_id, candidate_issue_id, confidence_score, model_version, review_status from ai_match_reviews where id = $1 for update`,
      [reviewId],
    );
    if (!r) throw new NotFoundError("Match review");
    if (r.review_status !== "pending") throw new ActionError("This match has already been reviewed.");
    const c = await one<{ consolidated_issue_id: string | null }>(tx, `select consolidated_issue_id from complaints where id = $1 for update`, [r.complaint_id]);
    if (c?.consolidated_issue_id) throw new ActionError("This complaint has already been grouped.");
    const actor = { type: "admin" as const, id: admin.id };

    if (decision.action === "confirm") {
      const issue = await loadIssueForAdmin(tx, admin, r.candidate_issue_id, { forUpdate: true });
      if (issue.status === "merged") throw new ActionError("The proposed issue was merged; choose a different issue.");
      if (["resolved", "closed"].includes(issue.status)) {
        if (!decision.reopenIfResolved) throw new ActionError("The proposed issue is resolved. Choose “Reopen and attach”, or reject to create a new related issue.");
        await applyIssueStatus(tx, admin, issue, "in_progress", null);
      }
      await linkComplaintToIssue(tx, { complaintId: r.complaint_id, issueId: r.candidate_issue_id, method: "review_confirmed", confidence: r.confidence_score, modelVersion: r.model_version, actor });
      await closeReview(tx, reviewId, admin, "confirmed", reason);
    } else if (decision.action === "reject") {
      const newIssue = await createIssueFromComplaint(tx, r.complaint_id, actor);
      await linkComplaintToIssue(tx, { complaintId: r.complaint_id, issueId: newIssue, method: "new_issue", confidence: r.confidence_score, modelVersion: r.model_version, actor });
      await addComplaintEvent(tx, { complaintId: r.complaint_id, actorType: "admin", actorId: admin.id, eventType: "registered_as_new_issue", message: "Your submission has been reviewed and is being tracked as its own issue.", visibleToStudent: true });
      await closeReview(tx, reviewId, admin, "rejected", reason);
    } else {
      const target = await loadIssueForAdmin(tx, admin, decision.issueId, { forUpdate: true });
      if (target.status === "merged") throw new ActionError("Cannot attach to a merged issue.");
      await linkComplaintToIssue(tx, { complaintId: r.complaint_id, issueId: target.id, method: "manual", actor });
      await closeReview(tx, reviewId, admin, "reassigned", reason);
    }
    // Other pending suggestions for the same complaint no longer apply.
    await tx.query(
      `update ai_match_reviews set review_status = 'superseded', reviewed_by = $2, reviewed_at = now()
        where complaint_id = $1 and review_status = 'pending' and id <> $3`,
      [r.complaint_id, admin.id, reviewId],
    );
    await audit(tx, { actorType: "admin", actorId: admin.id, action: `match_review.${decision.action}`, entityType: "ai_match_review", entityId: reviewId, metadata: { complaintId: r.complaint_id } });
  });
}
