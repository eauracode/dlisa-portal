import { one, rows, withStudentContext, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { assertCan, can, canAccessIssue } from "../auth/permissions";
import { cleanLine, cleanText, normalizeUsername } from "../validation";
import { DEPARTMENT_CODES, departmentName } from "../departments";
import { ActionError, loadIssueForAdmin, NotFoundError, reporterLabel, type AdminContext } from "./admin/context";

export type MessageTarget =
  | { type: "issue"; issueId: string } // everyone who reported a grouped issue
  | { type: "username"; username: string } // one student, by username
  | { type: "reporter"; complaintId: string } // the author of a complaint, without revealing the username
  | { type: "all" } // memo to every active student
  | { type: "department"; department: string } // every active student in one department
  | { type: "open_complaints" }; // every active student with a complaint that is not resolved or closed

export interface SendResult {
  messageId: string;
  recipients: number;
}

function validate(subject: string, body: string) {
  const s = cleanLine(subject);
  const b = cleanText(body);
  if (s.length < 3 || s.length > 150) throw new ActionError("The subject must be 3–150 characters.");
  if (b.length < 5 || b.length > 4000) throw new ActionError("The message must be 5–4000 characters.");
  return { subject: s, body: b };
}

/**
 * Sends a message to the chosen audience. Recipients are resolved and stored at send time
 * (a snapshot), and only active student accounts receive messages.
 *
 * `reusable` lets the portal give this answer instantly to students who later ask the same
 * thing (see instant-answers.ts). Memos and issue replies default to reusable; a direct reply
 * may be personal, so it is reused only when staff opt in.
 */
export async function sendMessage(
  admin: AdminContext,
  target: MessageTarget,
  input: { subject: string; body: string; reusable?: boolean },
): Promise<SendResult> {
  const { subject, body } = validate(input.subject, input.body);
  return withTransaction(async (tx) => {
    let audience: "issue" | "direct" | "broadcast" | "department" | "open_complaints";
    let department: string | null = null;
    let issueId: string | null = null;
    let studentId: string | null = null;
    let complaintId: string | null = null;

    switch (target.type) {
      case "issue": {
        const issue = await loadIssueForAdmin(tx, admin, target.issueId, { permission: "messages.send_issue" });
        if (issue.status === "merged") throw new ActionError("This issue was merged. Message the issue it was merged into.");
        audience = "issue";
        issueId = issue.id;
        break;
      }
      case "username": {
        assertCan(admin.role, "messages.send_direct");
        const s = await one<{ id: string }>(tx, `select id from students where normalized_username = $1 and account_status = 'active'`, [normalizeUsername(target.username)]);
        if (!s) throw new ActionError("No active student has that username. Check the spelling.");
        audience = "direct";
        studentId = s.id;
        break;
      }
      case "reporter": {
        assertCan(admin.role, "messages.send_issue");
        const c = await one<{ student_id: string; consolidated_issue_id: string | null }>(tx, `select student_id, consolidated_issue_id from complaints where id = $1`, [target.complaintId]);
        if (!c) throw new NotFoundError("Complaint");
        if (admin.role !== "union_admin") {
          const issue = c.consolidated_issue_id
            ? await one<{ assigned_admin_id: string | null; escalated: boolean }>(tx, `select assigned_admin_id, escalated from consolidated_issues where id = $1`, [c.consolidated_issue_id])
            : null;
          if (!issue || !canAccessIssue(admin, issue)) throw new NotFoundError("Complaint");
        }
        audience = "direct";
        studentId = c.student_id;
        complaintId = target.complaintId;
        break;
      }
      case "all":
        assertCan(admin.role, "messages.broadcast");
        audience = "broadcast";
        break;
      case "department":
        assertCan(admin.role, "messages.broadcast");
        if (!(DEPARTMENT_CODES as readonly string[]).includes(target.department)) throw new ActionError("Choose a department.");
        audience = "department";
        department = target.department;
        break;
      case "open_complaints":
        assertCan(admin.role, "messages.broadcast");
        audience = "open_complaints";
        break;
    }

    const message = await one<{ id: string }>(
      tx,
      `insert into student_messages (audience, subject, body, author_admin_id, target_issue_id, target_student_id, target_complaint_id, reusable, target_department)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [audience, subject, body, admin.id, issueId, studentId, complaintId, input.reusable ?? audience !== "direct", department],
    );
    const messageId = message!.id;

    const inserted =
      audience === "issue"
        ? await tx.query(
            `insert into student_message_recipients (message_id, student_id)
             select distinct $1::uuid, c.student_id from complaints c join students s on s.id = c.student_id
              where c.consolidated_issue_id = $2 and s.account_status = 'active'`,
            [messageId, issueId],
          )
        : audience === "direct"
          ? await tx.query(`insert into student_message_recipients (message_id, student_id) values ($1, $2)`, [messageId, studentId])
          : audience === "department"
            ? await tx.query(
                `insert into student_message_recipients (message_id, student_id)
                 select $1::uuid, id from students where account_status = 'active' and department_code = $2`,
                [messageId, department],
              )
            : audience === "open_complaints"
              ? await tx.query(
                  `insert into student_message_recipients (message_id, student_id)
                   select distinct $1::uuid, c.student_id from complaints c join students s on s.id = c.student_id
                    where s.account_status = 'active' and c.status not in ('resolved', 'closed')`,
                  [messageId],
                )
              : await tx.query(
              `insert into student_message_recipients (message_id, student_id)
               select $1::uuid, id from students where account_status = 'active'`,
              [messageId],
            );
    const recipients = inserted.rowCount ?? 0;
    if (recipients === 0) throw new ActionError("There are no students to send this message to.");
    await tx.query(`update student_messages set recipient_count = $2 where id = $1`, [messageId, recipients]);

    // The message text is not copied into the audit log.
    await audit(tx, {
      actorType: "admin",
      actorId: admin.id,
      action: `message.sent_${audience}`,
      entityType: "student_message",
      entityId: messageId,
      metadata: { recipients, issueId, viaComplaint: complaintId },
    });
    return { messageId, recipients };
  });
}

export interface SentMessage {
  id: string;
  audience: string;
  subject: string;
  body: string;
  created_at: Date;
  recipient_count: number;
  read_count: number;
  reusable: boolean;
  reused_count: number;
  helpful_count: number;
  author_admin_id: string;
  author: string;
  target_label: string;
  target_issue_id: string | null;
}

/** Message history. Union administrators see all messages; others see only their own. */
export async function listSentMessages(db: Db, admin: AdminContext, limit = 100): Promise<SentMessage[]> {
  assertCan(admin.role, "messages.view");
  const own = admin.role !== "union_admin";
  const list = await rows<Omit<SentMessage, "target_label"> & { issue_title: string | null; username: string | null; target_student_id: string | null; target_complaint_id: string | null; target_department: string | null }>(
    db,
    `select m.id, m.audience, m.subject, m.body, m.created_at, m.recipient_count, a.display_name as author, m.target_department,
            (select count(*)::int from student_message_recipients r where r.message_id = m.id and r.read_at is not null) as read_count,
            m.reusable, m.author_admin_id,
            (select count(*)::int from instant_answers ia where ia.message_id = m.id) as reused_count,
            (select count(*)::int from instant_answers ia where ia.message_id = m.id and ia.helpful) as helpful_count,
            m.target_issue_id, i.title as issue_title, s.username, m.target_student_id, m.target_complaint_id
       from student_messages m
       join admin_users a on a.id = m.author_admin_id
       left join consolidated_issues i on i.id = m.target_issue_id
       left join students s on s.id = m.target_student_id
      ${own ? "where m.author_admin_id = $2" : ""}
      order by m.created_at desc limit $1`,
    own ? [limit, admin.id] : [limit],
  );
  return list.map(({ issue_title, username, target_student_id, target_complaint_id, target_department, ...m }) => ({
    ...m,
    target_label:
      m.audience === "broadcast"
        ? "All students"
        : m.audience === "department"
          ? `Students in ${departmentName(target_department) ?? "a department"}`
          : m.audience === "open_complaints"
            ? "Students with an open complaint"
        : m.audience === "issue"
          ? `Reporters of “${issue_title ?? "issue"}”`
          : target_complaint_id || !can(admin.role, "messages.send_direct")
            ? `${reporterLabel(target_student_id!)} (via their complaint)`
            : `@${username}`,
  }));
}

/** Students with active accounts reporting each open issue, for the compose form. */
export async function issueAudienceOptions(db: Db, admin: AdminContext) {
  const scoped = admin.role === "union_admin" ? "true" : admin.role === "case_officer" ? "i.assigned_admin_id = $1" : "false";
  return rows<{ id: string; title: string; status: string; reporters: number }>(
    db,
    `select i.id, i.title, i.status, i.distinct_reporter_count as reporters
       from consolidated_issues i
      where i.status <> 'merged' and ${scoped}
      order by (i.status in ('resolved','closed')), i.last_activity_at desc limit 300`,
    admin.role === "case_officer" ? [admin.id] : [],
  );
}

export async function countActiveStudents(db: Db): Promise<number> {
  return (await one<{ n: number }>(db, `select count(*)::int as n from students where account_status = 'active'`))!.n;
}

// ---------------------------------------------------------------------------
// Student inbox (row-level security: a student can only ever see their own messages)
// ---------------------------------------------------------------------------

export interface InboxMessage {
  id: string;
  audience: string;
  subject: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
  related: Array<{ id: string; subject: string }>;
}

export async function getStudentInbox(studentId: string, opts: { markRead?: boolean } = {}): Promise<InboxMessage[]> {
  return withStudentContext(studentId, async (tx) => {
    const list = await rows<Omit<InboxMessage, "related"> & { target_issue_id: string | null }>(
      tx,
      `select m.id, m.audience, m.subject, m.body, m.created_at, r.read_at, m.target_issue_id
         from student_message_recipients r join student_messages m on m.id = r.message_id
        order by m.created_at desc limit 200`,
    );
    // For replies about a grouped issue, link the student's own complaints in that issue.
    const issueIds = [...new Set(list.map((m) => m.target_issue_id).filter(Boolean))] as string[];
    const mine = issueIds.length
      ? await rows<{ id: string; subject: string; consolidated_issue_id: string }>(
          tx,
          `select id, subject, consolidated_issue_id from complaints where consolidated_issue_id = any($1::uuid[])`,
          [issueIds],
        )
      : [];
    if (opts.markRead) await tx.query(`update student_message_recipients set read_at = now() where read_at is null`);
    return list.map(({ target_issue_id, ...m }) => ({
      ...m,
      related: mine.filter((c) => c.consolidated_issue_id === target_issue_id).map(({ id, subject }) => ({ id, subject })),
    }));
  });
}

/** Unread staff messages: complaint chats plus messages to this student. Memos are counted separately. */
export async function getUnreadMessageCount(studentId: string): Promise<number> {
  return withStudentContext(studentId, async (tx) => {
    const r = await one<{ n: number }>(
      tx,
      `select (select count(*)::int from student_message_recipients r join student_messages m on m.id = r.message_id
                where r.read_at is null and m.audience <> 'broadcast')
            + (select count(*)::int from complaint_messages where sender_type = 'staff' and read_by_student_at is null) as n`,
    );
    return r!.n;
  });
}

export interface ComplaintMessageSummary {
  complaint_id: string;
  subject: string;
  last_body: string;
  last_at: Date;
  unread: number;
}

export interface GeneralMessage {
  id: string;
  audience: string;
  subject: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

/**
 * The student Messages page: one row per complaint with something from the Union, newest
 * first, plus messages not tied to a complaint (direct, department, open-complaint). Memos are
 * on the Memos page. Opening this page marks the general messages read.
 */
export async function getStudentMessagesOverview(studentId: string): Promise<{ complaints: ComplaintMessageSummary[]; general: GeneralMessage[] }> {
  return withStudentContext(studentId, async (tx) => {
    const complaints = await rows<ComplaintMessageSummary>(
      tx,
      `with items as (
         select m.complaint_id, m.body, m.created_at, (m.read_by_student_at is null) as unread
           from complaint_messages m where m.sender_type = 'staff'
         union all
         select c.id, u.message, u.created_at, false from issue_updates u join complaints c on c.consolidated_issue_id = u.consolidated_issue_id
         union all
         select c.id, sm.subject || ': ' || sm.body, sm.created_at, (r.read_at is null)
           from student_message_recipients r join student_messages sm on sm.id = r.message_id
           join complaints c on (sm.audience = 'issue' and c.consolidated_issue_id = sm.target_issue_id) or (sm.audience = 'direct' and c.id = sm.target_complaint_id)
         union all
         select ia.complaint_id, sm.subject || ': ' || sm.body, ia.created_at, (r.read_at is null)
           from instant_answers ia join student_messages sm on sm.id = ia.message_id
           left join student_message_recipients r on r.message_id = sm.id and r.student_id = app_current_student_id()
       ),
       ranked as (select *, row_number() over (partition by complaint_id order by created_at desc) as rn from items)
       select c.id as complaint_id, c.subject, ranked.body as last_body, ranked.created_at as last_at,
              (select count(*)::int from items i where i.complaint_id = c.id and i.unread) as unread
         from ranked join complaints c on c.id = ranked.complaint_id
        where ranked.rn = 1
        order by ranked.created_at desc`,
    );
    const general = await rows<GeneralMessage>(
      tx,
      `select m.id, m.audience, m.subject, m.body, m.created_at, r.read_at
         from student_message_recipients r join student_messages m on m.id = r.message_id
        where m.audience in ('department', 'open_complaints') or (m.audience = 'direct' and m.target_complaint_id is null)
        order by m.created_at desc limit 100`,
    );
    const unread = general.filter((m) => !m.read_at).map((m) => m.id);
    if (unread.length) await tx.query(`update student_message_recipients set read_at = now() where read_at is null and message_id = any($1::uuid[])`, [unread]);
    return { complaints, general };
  });
}
