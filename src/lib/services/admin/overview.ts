import { one, rows, type Db } from "../../db";
import { assertCan, issueScopeSql } from "../../auth/permissions";
import type { AdminContext } from "./context";
import { issueDepartmentFilterSql } from "./departments";

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

  const activity = admin.role === "union_admin"
    ? await rows<{ id: string; action: string; entity_type: string | null; entity_id: string | null; actor: string | null; actor_type: string; created_at: Date }>(
        db,
        `select l.id::text, l.action, l.entity_type, l.entity_id, a.display_name as actor, l.actor_type, l.created_at
           from audit_logs l left join admin_users a on a.id = l.actor_id and l.actor_type = 'admin'
          where l.action not in ('admin.login')
          order by l.created_at desc limit 12`,
      )
    : await rows<{ id: string; action: string; entity_type: string | null; entity_id: string | null; actor: string | null; actor_type: string; created_at: Date }>(
        db,
        `select e.id::text, e.event_type as action, 'issue' as entity_type, e.consolidated_issue_id::text as entity_id,
                a.display_name as actor, e.actor_type, e.created_at
           from issue_events e
           join consolidated_issues i on i.id = e.consolidated_issue_id
           left join admin_users a on a.id = e.actor_id and e.actor_type = 'admin'
          where ${scope.sql}
          order by e.created_at desc limit 12`,
        scope.params,
      );

  return { stats: stats!, urgent, pendingReviews: pendingReviews?.n ?? 0, failedMatches: failedMatches?.n ?? 0, activity };
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
