import { one, rows, type Db } from "../../db";
import { issueScopeSql } from "../../auth/permissions";
import type { AdminContext } from "./context";

export interface LiveIssue {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  priority: string;
  total_submission_count: number;
  distinct_reporter_count: number;
  assigned_name: string | null;
  expected_resolution_at: Date | null;
  last_report_at: Date | null;
  created_at: Date;
  reports_24h: number;
  ai_confidence: number | null;
  sensitive: boolean;
}

const ISSUE_SELECT = `
  select i.id, i.title, i.summary, cat.name as category, i.status, i.priority, i.total_submission_count,
         i.distinct_reporter_count, a.display_name as assigned_name, i.expected_resolution_at, i.last_report_at,
         i.created_at, i.sensitive,
         (select count(*)::int from complaints c where c.consolidated_issue_id = i.id and c.created_at > now() - interval '24 hours') as reports_24h,
         (select round(avg(d.confidence)::numeric, 2)::float from match_decisions d
           where d.candidate_issue_id = i.id and d.decision in ('auto', 'review')) as ai_confidence
    from consolidated_issues i
    join issue_categories cat on cat.id = i.category_id
    left join admin_users a on a.id = i.assigned_admin_id`;

/** "Rapid increase": at least this many reports in 24 hours. */
export const SURGE_THRESHOLD = 3;

/**
 * Near-real-time view of what the Issue Intelligence Engine has done in the last 24 hours,
 * limited to the issues the administrator is allowed to see.
 */
export async function getLiveActivity(db: Db, admin: AdminContext) {
  const scope = issueScopeSql(admin, "i", 1);
  const p = scope.params;
  const isUnionAdmin = admin.role === "union_admin";

  const [newIssues, active, priorityUps, intervention, newComplaints, reviews, failures, counters] = await Promise.all([
    rows<LiveIssue>(db, `${ISSUE_SELECT} where ${scope.sql} and i.status <> 'merged' and i.created_at > now() - interval '24 hours' order by i.created_at desc limit 10`, p),
    rows<LiveIssue>(
      db,
      `${ISSUE_SELECT} where ${scope.sql} and i.status <> 'merged' and i.last_report_at > now() - interval '24 hours'
        and i.total_submission_count > 1 order by reports_24h desc, i.last_report_at desc limit 10`,
      p,
    ),
    rows<{ issue_id: string; title: string; previous_value: string; new_value: string; created_at: Date }>(
      db,
      `select e.consolidated_issue_id as issue_id, i.title, e.previous_value, e.new_value, e.created_at
         from issue_events e join consolidated_issues i on i.id = e.consolidated_issue_id
        where ${scope.sql} and e.event_type in ('priority_changed', 'priority_override') and e.created_at > now() - interval '24 hours'
          and array_position(array['normal','elevated','high','critical'], e.new_value)
              > coalesce(array_position(array['normal','elevated','high','critical'], e.previous_value), 0)
        order by e.created_at desc limit 10`,
      p,
    ),
    rows<LiveIssue & { reason: string }>(
      db,
      `${ISSUE_SELECT.replace("select i.id", "select case when i.expected_resolution_at < now() then 'Overdue' when exists (select 1 from complaints c where c.consolidated_issue_id = i.id and c.status = 'review_requested') then 'Student review request' when i.status = 'new' and i.assigned_admin_id is null then 'New and unassigned' else 'Escalation pending' end as reason, i.id")}
        where ${scope.sql} and i.status not in ('merged','resolved','closed')
          and ((i.status = 'new' and i.assigned_admin_id is null)
            or i.expected_resolution_at < now()
            or exists (select 1 from complaints c where c.consolidated_issue_id = i.id and c.status = 'review_requested')
            or (i.escalated and i.escalation_status = 'pending'))
        order by case i.priority when 'critical' then 0 when 'high' then 1 when 'elevated' then 2 else 3 end, i.last_activity_at desc
        limit 12`,
      p,
    ),
    rows<{ id: string; subject: string; category: string; created_at: Date; match_status: string; issue_id: string | null; issue_title: string | null; decision: string | null; confidence: number | null }>(
      db,
      `select c.id, c.subject, cat.name as category, c.created_at, c.match_status, i.id as issue_id, i.title as issue_title,
              d.decision, d.confidence
         from complaints c
         join issue_categories cat on cat.id = c.category_id
         left join consolidated_issues i on i.id = c.consolidated_issue_id
         left join lateral (select decision, confidence from match_decisions md where md.complaint_id = c.id order by created_at desc limit 1) d on true
        where c.created_at > now() - interval '24 hours'
          ${isUnionAdmin ? "" : `and i.id is not null and ${scope.sql}`}
        order by c.created_at desc limit 15`,
      isUnionAdmin ? [] : p,
    ),
    isUnionAdmin
      ? rows<{ id: string; complaint_id: string; subject: string; issue_id: string; issue_title: string; confidence_score: number; review_reason: string | null; created_at: Date }>(
          db,
          `select r.id, r.complaint_id, c.subject, r.candidate_issue_id as issue_id, i.title as issue_title, r.confidence_score, r.review_reason, r.created_at
             from ai_match_reviews r join complaints c on c.id = r.complaint_id join consolidated_issues i on i.id = r.candidate_issue_id
            where r.review_status = 'pending' order by r.created_at desc limit 10`,
        )
      : Promise.resolve([]),
    isUnionAdmin
      ? rows<{ complaint_id: string; subject: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date }>(
          db,
          `select j.complaint_id, c.subject, j.status, j.attempts, j.last_error, j.next_attempt_at
             from match_jobs j join complaints c on c.id = j.complaint_id
            where j.status = 'failed' or (j.status in ('pending','processing') and j.attempts > 0)
            order by j.updated_at desc limit 10`,
        )
      : Promise.resolve([]),
    one<{ complaints_24h: number; issues_24h: number; auto_24h: number; review_24h: number; new_24h: number; processing: number }>(
      db,
      `select (select count(*)::int from complaints c ${isUnionAdmin ? "" : `join consolidated_issues i on i.id = c.consolidated_issue_id and ${scope.sql}`} where c.created_at > now() - interval '24 hours') as complaints_24h,
              (select count(*)::int from consolidated_issues i where ${scope.sql} and i.created_at > now() - interval '24 hours') as issues_24h,
              (select count(*)::int from match_decisions d where d.decision = 'auto' and d.created_at > now() - interval '24 hours') as auto_24h,
              (select count(*)::int from match_decisions d where d.decision = 'review' and d.created_at > now() - interval '24 hours') as review_24h,
              (select count(*)::int from match_decisions d where d.decision = 'new' and d.created_at > now() - interval '24 hours') as new_24h,
              (select count(*)::int from match_jobs j where j.status in ('pending','processing')) as processing`,
      p,
    ),
  ]);

  const surging = active.filter((i) => i.reports_24h >= SURGE_THRESHOLD);
  return { newIssues, active, surging, priorityUps, intervention, newComplaints, reviews, failures, counters: counters! };
}

/**
 * Cheap fingerprint of everything the live views display. The dashboard polls it and
 * re-renders only when it changes (i.e. when background processing has finished).
 */
export async function getActivityVersion(db: Db): Promise<string> {
  const row = await one<{ v: string }>(
    db,
    `select concat_ws('|',
       (select coalesce(max(updated_at), 'epoch')::text from complaints),
       (select coalesce(max(updated_at), 'epoch')::text from consolidated_issues),
       (select coalesce(max(updated_at), 'epoch')::text from match_jobs),
       (select count(*) from ai_match_reviews where review_status = 'pending')::text,
       (select coalesce(max(created_at), 'epoch')::text from issue_updates)) as v`,
  );
  return row?.v ?? "";
}
