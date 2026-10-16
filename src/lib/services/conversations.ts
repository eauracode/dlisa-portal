import { one, pool, rows, withStudentContext, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { assertCan, canAccessIssue } from "../auth/permissions";
import { consumeRateLimit, RATE_LIMITS } from "../security/rate-limit";
import { cleanText } from "../validation";
import { ActionError, NotFoundError, reporterLabel, type AdminContext } from "./admin/context";
import { issueDepartmentCounts, reporterDepartment } from "./admin/departments";

/*
 * The two-way conversation on a complaint: its owner and Union staff. Staff only ever see a
 * reporter code; students never see which staff member replied.
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

/** A staff reply: only this student sees it, in their complaint's chat. */
export async function sendStaffReply(admin: AdminContext, complaintId: string, body: string) {
  assertCan(admin.role, "messages.send_issue");
  const text = cleanBody(body);
  await withTransaction(async (tx) => {
    const { complaint, issue } = await loadComplaintForStaff(tx, admin, complaintId);
    if (complaint.status === "closed") throw new ActionError("This complaint is closed.");
    await tx.query(`insert into complaint_messages (complaint_id, sender_type, author_admin_id, body) values ($1, 'staff', $2, $3)`, [complaintId, admin.id, text]);
    await tx.query(`update complaint_messages set read_by_staff_at = now() where complaint_id = $1 and sender_type = 'student' and read_by_staff_at is null`, [complaintId]);
    if (issue) await tx.query(`update consolidated_issues set last_activity_at = now() where id = $1`, [issue.id]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "complaint.staff_reply", entityType: "complaint", entityId: complaintId });
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
}

/** Complaints with chat messages, unread first. Case officers see their assigned issues only. */
export async function listConversations(db: Db, admin: AdminContext, limit = 100): Promise<ConversationRow[]> {
  assertCan(admin.role, "messages.view");
  const scoped = admin.role === "union_admin" ? "true" : "i.assigned_admin_id = $2";
  const list = await rows<Omit<ConversationRow, "reporter" | "department"> & { student_id: string; department_code: string | null; sensitive: boolean | null }>(
    db,
    `select c.id as complaint_id, c.student_id, c.department_code, c.subject, i.id as issue_id, i.title as issue_title, i.sensitive,
            last.body as last_body, last.sender_type as last_from, last.created_at as last_at,
            (select count(*)::int from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null) as unread
       from complaints c
       left join consolidated_issues i on i.id = c.consolidated_issue_id
       join lateral (select body, sender_type, created_at from complaint_messages m where m.complaint_id = c.id order by created_at desc limit 1) last on true
      where ${scoped}
      order by (select count(*) from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null) > 0 desc,
               last.created_at desc
      limit $1`,
    admin.role === "union_admin" ? [limit] : [limit, admin.id],
  );
  const countsByIssue = new Map<string, Awaited<ReturnType<typeof issueDepartmentCounts>>>();
  for (const r of list) if (r.issue_id && !countsByIssue.has(r.issue_id)) countsByIssue.set(r.issue_id, await issueDepartmentCounts(db, r.issue_id));
  return list.map(({ student_id, department_code, sensitive, ...r }) => ({
    ...r,
    reporter: reporterLabel(student_id),
    department: r.issue_id ? reporterDepartment(department_code, countsByIssue.get(r.issue_id) ?? [], !!sensitive) : null,
  }));
}

export interface StaffConversation {
  complaint_id: string;
  reporter: string;
  department: string | null;
  subject: string;
  status: string;
  issue: { id: string; title: string; status: string } | null;
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
    return {
      complaint_id: complaint.id,
      reporter: reporterLabel(complaint.student_id),
      department: issue ? reporterDepartment(complaint.department_code, counts, issue.sensitive) : null,
      subject: complaint.subject,
      status: complaint.status,
      issue: issue ? { id: issue.id, title: issue.title, status: issue.status } : null,
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
    `select count(*)::int as n from complaint_messages m join complaints c on c.id = m.complaint_id
       left join consolidated_issues i on i.id = c.consolidated_issue_id
      where m.sender_type = 'student' and m.read_by_staff_at is null and ${scoped}`,
    admin.role === "union_admin" ? [] : [admin.id],
  );
  return r!.n;
}
