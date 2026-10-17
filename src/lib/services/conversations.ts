import { one, pool, rows, withStudentContext, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { assertCan, canAccessIssue } from "../auth/permissions";
import { consumeRateLimit, RATE_LIMITS } from "../security/rate-limit";
import { cleanText } from "../validation";
import { applyStatus } from "./admin/issues";
import { resolveComplaint, startComplaint } from "./progress";
import { ActionError, loadIssueForAdmin, NotFoundError, reporterNamer, seesStudentIdentity, type AdminContext } from "./admin/context";
import { issueDepartmentCounts, reporterDepartment } from "./admin/departments";

/*
 * The two-way conversation on a complaint: its owner and Association staff. Association staff see the
 * student's username (oversight officers a reporter code); students never see which staff member replied.
 */

export const REPLY_MAX = 2000;

function cleanBody(body: string): string {
  const b = cleanText(body);
  if (b.length < 1) throw new ActionError("Write a message first.");
  if (b.length > REPLY_MAX) throw new ActionError(`Messages can be up to ${REPLY_MAX.toLocaleString()} characters.`);
  return b;
}

export type StudentReplyResult = { ok: true } | { ok: false; error: "not_found" | "closed" | "rate_limited" | "empty" };

/** A student's message in their own complaint's chat. Row-level security enforces ownership. */
export async function sendStudentReply(studentId: string, complaintId: string, body: string, opts: { reviewRequest?: boolean } = {}): Promise<StudentReplyResult> {
  const text = cleanText(body);
  if (!text) return { ok: false, error: "empty" };
  if (text.length > REPLY_MAX) return { ok: false, error: "empty" };
  if (!opts.reviewRequest) {
    const limit = await consumeRateLimit(pool(), RATE_LIMITS.studentReplyHour, studentId);
    if (!limit.allowed) return { ok: false, error: "rate_limited" };
  }
  const res = await withStudentContext(studentId, async (tx) => {
    const c = await one<{ status: string; consolidated_issue_id: string | null }>(tx, `select status, consolidated_issue_id from complaints where id = $1`, [complaintId]);
    if (!c) return { ok: false as const, error: "not_found" as const };
    if (c.status === "closed") return { ok: false as const, error: "closed" as const };
    await tx.query(`insert into complaint_messages (complaint_id, sender_type, body, is_review_request) values ($1, 'student', $2, $3)`, [
      complaintId,
      text,
      !!opts.reviewRequest,
    ]);
    return { ok: true as const, issueId: c.consolidated_issue_id };
  });
  if (!res.ok) return res;
  await withTransaction(async (tx) => {
    if (res.issueId) await tx.query(`update consolidated_issues set last_activity_at = now() where id = $1`, [res.issueId]);
    // The message text is not copied into the audit log.
    await audit(tx, { actorType: "student", actorId: studentId, action: "complaint.message_sent", entityType: "complaint", entityId: complaintId });
  });
  return { ok: true };
}

/** Loads the complaint and checks the staff member may see it (case officers: assigned issues only). */
async function loadComplaintForStaff(db: Db, admin: AdminContext, complaintId: string) {
  const c = await one<{ id: string; student_id: string; status: string; subject: string; consolidated_issue_id: string | null; department_code: string | null }>(
    db,
    `select id, student_id, status, subject, consolidated_issue_id, department_code from complaints where id = $1`,
    [complaintId],
  );
  if (!c) throw new NotFoundError("Complaint");
  const issue = c.consolidated_issue_id
    ? await one<{ id: string; title: string; status: string; sensitive: boolean; assigned_admin_id: string | null; escalated: boolean }>(
        db,
        `select id, title, status, sensitive, assigned_admin_id, escalated from consolidated_issues where id = $1`,
        [c.consolidated_issue_id],
      )
    : null;
  if (admin.role !== "union_admin" && (!issue || !canAccessIssue(admin, issue))) throw new NotFoundError("Complaint");
  return { complaint: c, issue };
}

/**
 * A staff reply: only this student sees it, in their complaint's chat. Replying moves the
 * submission (and its issue) to In progress; `resolve` marks this submission Resolved instead
 * (the issue follows once all of its submissions are resolved). See progress.ts.
 */
export async function sendStaffReply(admin: AdminContext, complaintId: string, body: string, opts: { resolve?: boolean } = {}) {
  assertCan(admin.role, "messages.send_issue");
  const text = cleanBody(body);
  await withTransaction(async (tx) => {
    const { complaint, issue } = await loadComplaintForStaff(tx, admin, complaintId);
    if (complaint.status === "closed") throw new ActionError("This complaint is closed.");
    await tx.query(`insert into complaint_messages (complaint_id, sender_type, author_admin_id, body) values ($1, 'staff', $2, $3)`, [complaintId, admin.id, text]);
    await tx.query(`update complaint_messages set read_by_staff_at = now() where complaint_id = $1 and sender_type = 'student' and read_by_staff_at is null`, [complaintId]);
    if (issue) await tx.query(`update consolidated_issues set last_activity_at = now() where id = $1`, [issue.id]);
    const actor = { type: "admin" as const, id: admin.id };
    if (opts.resolve) {
      await resolveComplaint(tx, actor, complaintId, "The Students' Association marked this as resolved. If it isn't, reply here or request a review.");
    } else {
      if (issue && ["new", "under_review"].includes(issue.status)) {
        await applyStatus(tx, admin, await loadIssueForAdmin(tx, admin, issue.id, { forUpdate: true }), "in_progress", null);
      }
      await startComplaint(tx, actor, complaintId);
    }
    await audit(tx, { actorType: "admin", actorId: admin.id, action: opts.resolve ? "complaint.staff_reply_resolved" : "complaint.staff_reply", entityType: "complaint", entityId: complaintId });
  });
}

export interface ConversationRow {
  complaint_id: string;
  reporter: string;
  department: string | null;
  subject: string;
  issue_id: string | null;
  issue_title: string | null;
  last_body: string;
  last_from: "student" | "staff";
  last_at: Date;
  unread: number;
  /** The student said an earlier answer was not helpful and is waiting for a personal reply. */
  needs_personal_reply: boolean;
}

/** Complaints with chat messages, unread first. Case officers see their assigned issues only. */
export async function listConversations(db: Db, admin: AdminContext, limit = 100): Promise<ConversationRow[]> {
  assertCan(admin.role, "messages.view");
  const scoped = admin.role === "union_admin" ? "true" : "i.assigned_admin_id = $2";
  const list = await rows<Omit<ConversationRow, "reporter" | "department"> & { student_id: string; department_code: string | null; sensitive: boolean | null }>(
    db,
    `select c.id as complaint_id, c.student_id, c.department_code, c.subject, i.id as issue_id, i.title as issue_title, i.sensitive,
            coalesce(last.body, 'Said an earlier answer was not helpful') as last_body,
            coalesce(last.sender_type, 'student') as last_from,
            greatest(last.created_at, nh.feedback_at) as last_at,
            (select count(*)::int from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null) as unread,
            exists (select 1 from instant_answers na where na.complaint_id = c.id and na.helpful = false
                   and not exists (select 1 from complaint_messages sr where sr.complaint_id = c.id and sr.sender_type = 'staff' and sr.created_at > na.feedback_at)) as needs_personal_reply
       from complaints c
       left join consolidated_issues i on i.id = c.consolidated_issue_id
       left join lateral (select body, sender_type, created_at from complaint_messages m where m.complaint_id = c.id order by created_at desc limit 1) last on true
       left join lateral (select max(feedback_at) as feedback_at from instant_answers na where na.complaint_id = c.id and na.helpful = false) nh on true
      where (last.created_at is not null or nh.feedback_at is not null) and ${scoped}
      order by (exists (select 1 from instant_answers na where na.complaint_id = c.id and na.helpful = false
                   and not exists (select 1 from complaint_messages sr where sr.complaint_id = c.id and sr.sender_type = 'staff' and sr.created_at > na.feedback_at))) desc,
               (select count(*) from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null) > 0 desc,
               greatest(last.created_at, nh.feedback_at) desc
      limit $1`,
    admin.role === "union_admin" ? [limit] : [limit, admin.id],
  );
  const countsByIssue = new Map<string, Awaited<ReturnType<typeof issueDepartmentCounts>>>();
  for (const r of list) if (r.issue_id && !countsByIssue.has(r.issue_id)) countsByIssue.set(r.issue_id, await issueDepartmentCounts(db, r.issue_id));
  const name = await reporterNamer(db, admin, list.map((r) => r.student_id));
  const sees = seesStudentIdentity(admin);
  return list.map(({ student_id, department_code, sensitive, ...r }) => ({
    ...r,
    reporter: name(student_id),
    department: sees || r.issue_id ? reporterDepartment(department_code, countsByIssue.get(r.issue_id ?? "") ?? [], !!sensitive, sees) : null,
  }));
}

export interface StaffConversation {
  complaint_id: string;
  reporter: string;
  department: string | null;
  subject: string;
  status: string;
  issue: { id: string; title: string; status: string } | null;
  needs_personal_reply: boolean;
  messages: Array<{ id: string; sender_type: "student" | "staff"; body: string; is_review_request: boolean; created_at: Date; author: string | null; read: boolean }>;
}

/** One conversation from the staff side; opening it marks the student's messages read. */
export async function getStaffConversation(admin: AdminContext, complaintId: string): Promise<StaffConversation> {
  assertCan(admin.role, "messages.view");
  return withTransaction(async (tx) => {
    const { complaint, issue } = await loadComplaintForStaff(tx, admin, complaintId);
    const messages = await rows<StaffConversation["messages"][number] & { read_by_student_at: Date | null; read_by_staff_at: Date | null }>(
      tx,
      `select m.id, m.sender_type, m.body, m.is_review_request, m.created_at, a.display_name as author, m.read_by_student_at, m.read_by_staff_at
         from complaint_messages m left join admin_users a on a.id = m.author_admin_id
        where m.complaint_id = $1 order by m.created_at`,
      [complaintId],
    );
    await tx.query(`update complaint_messages set read_by_staff_at = now() where complaint_id = $1 and sender_type = 'student' and read_by_staff_at is null`, [complaintId]);
    const counts = issue ? await issueDepartmentCounts(tx, issue.id) : [];
    const flag = await one<{ v: boolean }>(tx, `select exists (select 1 from instant_answers na where na.complaint_id = $1 and na.helpful = false
                   and not exists (select 1 from complaint_messages sr where sr.complaint_id = $1 and sr.sender_type = 'staff' and sr.created_at > na.feedback_at)) as v`, [complaintId]);
    const name = await reporterNamer(tx, admin, [complaint.student_id]);
    const sees = seesStudentIdentity(admin);
    return {
      complaint_id: complaint.id,
      reporter: name(complaint.student_id),
      department: sees || issue ? reporterDepartment(complaint.department_code, counts, issue?.sensitive ?? true, sees) : null,
      subject: complaint.subject,
      status: complaint.status,
      issue: issue ? { id: issue.id, title: issue.title, status: issue.status } : null,
      needs_personal_reply: !!flag?.v,
      messages: messages.map(({ read_by_student_at, read_by_staff_at, ...m }) => ({
        ...m,
        read: m.sender_type === "staff" ? !!read_by_student_at : !!read_by_staff_at,
      })),
    };
  });
}

/** Unread student messages per complaint on one issue (the issue page's "N new replies" links). */
export async function unreadRepliesByComplaint(db: Db, issueId: string): Promise<Map<string, number>> {
  const list = await rows<{ complaint_id: string; n: number }>(
    db,
    `select m.complaint_id, count(*)::int as n from complaint_messages m join complaints c on c.id = m.complaint_id
      where c.consolidated_issue_id = $1 and m.sender_type = 'student' and m.read_by_staff_at is null group by m.complaint_id`,
    [issueId],
  );
  return new Map(list.map((r) => [r.complaint_id, r.n]));
}

export async function countUnreadForStaff(db: Db, admin: AdminContext): Promise<number> {
  const scoped = admin.role === "union_admin" ? "true" : "i.assigned_admin_id = $1";
  const r = await one<{ n: number }>(
    db,
    `select (select count(*)::int from complaint_messages m join complaints c on c.id = m.complaint_id
               left join consolidated_issues i on i.id = c.consolidated_issue_id
              where m.sender_type = 'student' and m.read_by_staff_at is null and ${scoped})
          + (select count(*)::int from complaints c left join consolidated_issues i on i.id = c.consolidated_issue_id
              where ${scoped} and exists (select 1 from instant_answers na where na.complaint_id = c.id and na.helpful = false
                   and not exists (select 1 from complaint_messages sr where sr.complaint_id = c.id and sr.sender_type = 'staff' and sr.created_at > na.feedback_at))
                and not exists (select 1 from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null)) as n`,
    admin.role === "union_admin" ? [] : [admin.id],
  );
  return r!.n;
}
