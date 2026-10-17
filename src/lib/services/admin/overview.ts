import { one, rows, type Db } from "../../db";
import { assertCan, issueScopeSql } from "../../auth/permissions";
import { reporterNamer, seesStudentIdentity, type AdminContext } from "./context";
import { departmentName, issueDepartmentFilterSql } from "./departments";

export interface OverviewFilters {
  from?: Date | null;
  to?: Date | null;
  categoryId?: number;
  priority?: string;
  status?: string;
  assigned?: string;
  department?: string;
}

/** All figures are computed live from the database within the admin's issue scope. */
export async function getOverview(db: Db, admin: AdminContext, f: OverviewFilters) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const scope = issueScopeSql(admin, "i", 1);
  params.push(...scope.params);
  const issueWhere = [scope.sql, "i.status <> 'merged'"];
  const complaintWhere: string[] = [];
  if (admin.role !== "union_admin") complaintWhere.push(`exists (select 1 from consolidated_issues i where i.id = c.consolidated_issue_id and ${scope.sql})`);
  if (f.from) {
    issueWhere.push(`i.created_at >= ${p(f.from)}`);
    complaintWhere.push(`c.created_at >= $${params.length}`);
  }
  if (f.to) {
    issueWhere.push(`i.created_at < ${p(f.to)}`);
    complaintWhere.push(`c.created_at < $${params.length}`);
  }
  if (f.categoryId) {
    issueWhere.push(`i.category_id = ${p(f.categoryId)}`);
    complaintWhere.push(`c.category_id = $${params.length}`);
  }
  if (f.department) {
    // Same disclosure rule as the department labels: only groups of 5+ on non-sensitive issues.
    issueWhere.push(issueDepartmentFilterSql("i", params.length + 1));
    complaintWhere.push(`c.department_code = $${params.length + 1} and exists (select 1 from consolidated_issues di where di.id = c.consolidated_issue_id and ${issueDepartmentFilterSql("di", params.length + 1)})`);
    params.push(f.department);
  }
  if (f.priority) issueWhere.push(`i.priority = ${p(f.priority)}`);
  if (f.status) issueWhere.push(`i.status = ${p(f.status)}`);
  if (f.assigned === "unassigned") issueWhere.push(`i.assigned_admin_id is null`);
  else if (f.assigned) issueWhere.push(`i.assigned_admin_id = ${p(f.assigned)}`);

  const stats = await one<{
    total_complaints: number; awaiting_review: number; total_issues: number; in_progress: number; high_critical: number;
    overdue: number; awaiting_external: number; resolved: number; escalated_open: number;
  }>(
    db,
    `select
       (select count(*)::int from complaints c ${complaintWhere.length ? `where ${complaintWhere.join(" and ")}` : ""}) as total_complaints,
       (select count(*)::int from complaints c where c.status in ('received','review_requested')
          ${complaintWhere.length ? `and ${complaintWhere.join(" and ")}` : ""}) as awaiting_review,
       count(*)::int as total_issues,
       count(*) filter (where i.status = 'in_progress')::int as in_progress,
       count(*) filter (where i.priority in ('high','critical') and i.status not in ('resolved','closed'))::int as high_critical,
       count(*) filter (where i.expected_resolution_at < now() and i.status not in ('resolved','closed'))::int as overdue,
       count(*) filter (where i.status = 'awaiting_external_action')::int as awaiting_external,
       count(*) filter (where i.status in ('resolved','closed'))::int as resolved,
       count(*) filter (where i.escalated and i.escalation_status in ('pending','acknowledged'))::int as escalated_open
     from consolidated_issues i where ${issueWhere.join(" and ")}`,
    params,
  );

  const urgent = await rows<{ id: string; title: string; priority: string; status: string; distinct_reporter_count: number; expected_resolution_at: Date | null; overdue: boolean }>(
    db,
    `select i.id, i.title, i.priority, i.status, i.distinct_reporter_count, i.expected_resolution_at,
            (i.expected_resolution_at < now()) as overdue
       from consolidated_issues i
      where ${issueWhere.join(" and ")} and i.status not in ('resolved','closed')
        and (i.priority in ('high','critical') or i.expected_resolution_at < now())
      order by case i.priority when 'critical' then 0 when 'high' then 1 else 2 end, i.last_activity_at desc
      limit 10`,
    params,
  );

  const [pendingReviews, failedMatches] = await Promise.all([
    admin.role === "union_admin" ? one<{ n: number }>(db, `select count(*)::int as n from ai_match_reviews where review_status = 'pending'`) : null,
    admin.role === "union_admin" ? one<{ n: number }>(db, `select count(*)::int as n from complaints where match_status in ('failed') or (match_status = 'pending' and created_at < now() - interval '10 minutes')`) : null,
  ]);

  const messages = await getMessageSummary(db, admin, complaintWhere, params, f);
  const attention = await listNeedsReply(db, admin, complaintWhere, params);
  const latest = await listLatestSubmissions(db, admin, complaintWhere, params);

  return { stats: stats!, urgent, pendingReviews: pendingReviews?.n ?? 0, failedMatches: failedMatches?.n ?? 0, messages, attention, latest };
}

// ---------------------------------------------------------------------------
// Messages: what came in, what was answered, and who is still waiting
// ---------------------------------------------------------------------------

/** Waiting for a personal reply after saying an earlier answer was not helpful. */
const NOT_HELPFUL_WAITING = `exists (select 1 from instant_answers na where na.complaint_id = c.id and na.helpful = false
  and not exists (select 1 from complaint_messages sr where sr.complaint_id = c.id and sr.sender_type = 'staff' and sr.created_at > na.feedback_at))`;
const UNREAD_FROM_STUDENT = `exists (select 1 from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null)`;
/** Nobody has answered yet: no instant answer and no staff reply. */
const NOT_ANSWERED = `(c.status in ('received', 'under_review')
  and not exists (select 1 from instant_answers ia where ia.complaint_id = c.id)
  and not exists (select 1 from complaint_messages sm where sm.complaint_id = c.id and sm.sender_type = 'staff'))`;
const NEEDS_REPLY = `(${NOT_HELPFUL_WAITING} or c.status = 'review_requested' or ${UNREAD_FROM_STUDENT} or ${NOT_ANSWERED})`;

export interface MessageSummary {
  submissions: number;
  answered_instantly: number;
  helpful: number;
  not_helpful: number;
  needs_reply: number;
  not_helpful_waiting: number;
  not_answered: number;
  in_progress: number;
  resolved: number;
  staff_replies: number;
  messages_sent: number;
}

async function getMessageSummary(db: Db, admin: AdminContext, complaintWhere: string[], params: unknown[], f: OverviewFilters): Promise<MessageSummary> {
  const where = complaintWhere.length ? `where ${complaintWhere.join(" and ")}` : "";
  const summary = await one<Omit<MessageSummary, "messages_sent" | "staff_replies">>(
    db,
    `select count(*)::int as submissions,
            count(*) filter (where exists (select 1 from instant_answers ia where ia.complaint_id = c.id))::int as answered_instantly,
            coalesce(sum((select count(*) from instant_answers ia where ia.complaint_id = c.id and ia.helpful)), 0)::int as helpful,
            coalesce(sum((select count(*) from instant_answers ia where ia.complaint_id = c.id and ia.helpful = false)), 0)::int as not_helpful,
            count(*) filter (where ${NEEDS_REPLY})::int as needs_reply,
            count(*) filter (where ${NOT_HELPFUL_WAITING})::int as not_helpful_waiting,
            count(*) filter (where ${NOT_ANSWERED})::int as not_answered,
            count(*) filter (where c.status in ('under_review', 'in_progress', 'awaiting_external_action', 'review_requested'))::int as in_progress,
            count(*) filter (where c.status in ('resolved', 'closed'))::int as resolved
       from complaints c ${where}`,
    params,
  );
  // Outgoing: chat replies and inbox messages. Administrators see the whole team's; others their own.
  const range: string[] = [];
  const rp: unknown[] = [];
  if (admin.role !== "union_admin") {
    rp.push(admin.id);
    range.push(`author_admin_id = $${rp.length}`);
  }
  if (f.from) {
    rp.push(f.from);
    range.push(`created_at >= $${rp.length}`);
  }
  if (f.to) {
    rp.push(f.to);
    range.push(`created_at < $${rp.length}`);
  }
  const and = range.length ? ` and ${range.join(" and ")}` : "";
  const out = await one<{ staff_replies: number; messages_sent: number }>(
    db,
    `select (select count(*)::int from complaint_messages where sender_type = 'staff'${and}) as staff_replies,
            (select count(*)::int from student_messages where memo_status <> 'draft' and audience <> 'faq'${and}) as messages_sent`,
    rp,
  );
  return { ...summary!, ...out! };
}

export type NeedsReplyReason = "not_helpful" | "review_requested" | "unread" | "not_answered";

export interface NeedsReplyRow {
  complaint_id: string;
  reporter: string;
  department: string | null;
  subject: string;
  status: string;
  created_at: Date;
  waiting_since: Date;
  reason: NeedsReplyReason;
}

/** Submissions where a student is waiting on the team: most urgent reason first, then oldest. */
async function listNeedsReply(db: Db, admin: AdminContext, complaintWhere: string[], params: unknown[]): Promise<NeedsReplyRow[]> {
  const list = await rows<Omit<NeedsReplyRow, "reporter" | "department"> & { student_id: string; department_code: string | null }>(
    db,
    `select c.id as complaint_id, c.student_id, c.department_code, c.subject, c.status, c.created_at,
            case when ${NOT_HELPFUL_WAITING} then 'not_helpful'
                 when c.status = 'review_requested' then 'review_requested'
                 when ${UNREAD_FROM_STUDENT} then 'unread'
                 else 'not_answered' end as reason,
            coalesce((select min(u.created_at) from complaint_messages u where u.complaint_id = c.id and u.sender_type = 'student' and u.read_by_staff_at is null),
                     (select max(na.feedback_at) from instant_answers na where na.complaint_id = c.id and na.helpful = false),
                     c.created_at) as waiting_since
       from complaints c
      where ${NEEDS_REPLY} ${complaintWhere.length ? `and ${complaintWhere.join(" and ")}` : ""}
      order by case when ${NOT_HELPFUL_WAITING} then 0 when c.status = 'review_requested' then 1 when ${UNREAD_FROM_STUDENT} then 2 else 3 end, c.created_at
      limit 15`,
    params,
  );
  return withNames(db, admin, list);
}

export interface LatestSubmission {
  complaint_id: string;
  reporter: string;
  department: string | null;
  subject: string;
  category: string;
  status: string;
  created_at: Date;
  answered_instantly: boolean;
}

async function listLatestSubmissions(db: Db, admin: AdminContext, complaintWhere: string[], params: unknown[]): Promise<LatestSubmission[]> {
  const list = await rows<Omit<LatestSubmission, "reporter" | "department"> & { student_id: string; department_code: string | null }>(
    db,
    `select c.id as complaint_id, c.student_id, c.department_code, c.subject, cat.name as category, c.status, c.created_at,
            exists (select 1 from instant_answers ia where ia.complaint_id = c.id) as answered_instantly
       from complaints c join issue_categories cat on cat.id = c.category_id
      ${complaintWhere.length ? `where ${complaintWhere.join(" and ")}` : ""}
      order by c.created_at desc limit 8`,
    params,
  );
  return withNames(db, admin, list);
}

/** Usernames and departments for Association staff; reporter codes for oversight officers. */
async function withNames<T extends { student_id: string; department_code: string | null }>(db: Db, admin: AdminContext, list: T[]) {
  const name = await reporterNamer(db, admin, list.map((r) => r.student_id));
  const sees = seesStudentIdentity(admin);
  return list.map(({ student_id, department_code, ...r }) => ({ ...r, reporter: name(student_id), department: sees ? departmentName(department_code) : null }));
}

export async function getReports(db: Db, admin: AdminContext) {
  assertCan(admin.role, "reports.view");
  const scope = issueScopeSql(admin, "i", 1);
  const byCategory = await rows<{ category: string; issues: number; submissions: number; open: number; resolved: number; avg_days_to_resolve: number | null }>(
    db,
    `select cat.name as category,
            count(i.id)::int as issues,
            coalesce(sum(i.total_submission_count), 0)::int as submissions,
            count(i.id) filter (where i.status not in ('resolved','closed'))::int as open,
            count(i.id) filter (where i.status in ('resolved','closed'))::int as resolved,
            round(avg(extract(epoch from i.resolved_at - i.created_at) / 86400) filter (where i.resolved_at is not null)::numeric, 1)::float as avg_days_to_resolve
       from issue_categories cat
       left join consolidated_issues i on i.category_id = cat.id and i.status <> 'merged' and ${scope.sql}
      group by cat.id, cat.name, cat.sort_order
      order by cat.sort_order`,
    scope.params,
  );
  const monthly = await rows<{ month: string; submissions: number; distinct_students: number }>(
    db,
    `select to_char(date_trunc('month', c.created_at at time zone 'Africa/Lagos'), 'YYYY-MM') as month,
            count(*)::int as submissions, count(distinct c.student_id)::int as distinct_students
       from complaints c
       ${admin.role === "union_admin" ? "" : `join consolidated_issues i on i.id = c.consolidated_issue_id where ${scope.sql}`}
      ${admin.role === "union_admin" ? "where" : "and"} c.created_at > now() - interval '12 months'
      group by 1 order by 1 desc`,
    scope.params,
  );
  const deadlines = await one<{ with_deadline: number; met: number; missed: number; open_overdue: number }>(
    db,
    `select count(*) filter (where i.expected_resolution_at is not null)::int as with_deadline,
            count(*) filter (where i.resolved_at is not null and i.expected_resolution_at is not null and i.resolved_at <= i.expected_resolution_at)::int as met,
            count(*) filter (where i.resolved_at is not null and i.expected_resolution_at is not null and i.resolved_at > i.expected_resolution_at)::int as missed,
            count(*) filter (where i.resolved_at is null and i.expected_resolution_at < now() and i.status not in ('resolved','closed','merged'))::int as open_overdue
       from consolidated_issues i where ${scope.sql}`,
    scope.params,
  );
  const matching = admin.role === "union_admin"
    ? await rows<{ match_method: string; n: number; avg_confidence: number | null }>(
        db,
        `select match_method, count(*)::int as n, round(avg(match_confidence)::numeric, 2)::float as avg_confidence
           from issue_submissions where unlinked_at is null group by match_method order by n desc`,
      )
    : [];
  return { byCategory, monthly, deadlines: deadlines!, matching };
}

export async function getAuditLog(db: Db, admin: AdminContext, limit = 200) {
  assertCan(admin.role, "audit.view");
  return rows<{ id: string; actor_type: string; actor: string | null; action: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown>; created_at: Date }>(
    db,
    `select l.id::text, l.actor_type, a.display_name as actor, l.action, l.entity_type, l.entity_id, l.metadata, l.created_at
       from audit_logs l left join admin_users a on a.id = l.actor_id and l.actor_type = 'admin'
      order by l.created_at desc limit $1`,
    [limit],
  );
}
