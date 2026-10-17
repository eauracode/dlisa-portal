import { one, rows, type Db } from "../db";
import { deliverIssueAnswers } from "./instant-answers";
import { COPY } from "@/config/app";
import { redactIdentifiers } from "../ai/redact";
import { truncate } from "../ai/extract";
import type { Severity } from "../ai/types";
import { computePriority, type PriorityConfig } from "../priority/engine";
import type { ComplaintStatus, Priority } from "../validation";
import { getPriorityConfig } from "./settings";

export type ActorType = "student" | "admin" | "system";
export type MatchMethod = "auto" | "review_confirmed" | "new_issue" | "manual" | "merge" | "split";

export const ISSUE_TO_COMPLAINT_STATUS: Record<string, ComplaintStatus> = {
  new: "received",
  under_review: "under_review",
  in_progress: "in_progress",
  awaiting_external_action: "awaiting_external_action",
  resolved: "resolved",
  closed: "closed",
};

export async function addComplaintEvent(
  db: Db,
  e: {
    complaintId: string;
    actorType: ActorType;
    actorId?: string | null;
    eventType: string;
    previousValue?: string | null;
    newValue?: string | null;
    message?: string | null;
    visibleToStudent?: boolean;
  },
) {
  await db.query(
    `insert into complaint_events (complaint_id, actor_type, actor_id, event_type, previous_value, new_value, message, visible_to_student)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.complaintId, e.actorType, e.actorId ?? null, e.eventType, e.previousValue ?? null, e.newValue ?? null, e.message ?? null, e.visibleToStudent ?? true],
  );
}

export async function addIssueEvent(
  db: Db,
  e: {
    issueId: string;
    actorType: ActorType;
    actorId?: string | null;
    eventType: string;
    previousValue?: string | null;
    newValue?: string | null;
    reason?: string | null;
  },
) {
  await db.query(
    `insert into issue_events (consolidated_issue_id, actor_type, actor_id, event_type, previous_value, new_value, reason)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.issueId, e.actorType, e.actorId ?? null, e.eventType, e.previousValue ?? null, e.newValue ?? null, e.reason ?? null],
  );
}

interface AnalysisRow {
  summary_title: string;
  summary: string;
  inferred_category_id: number | null;
  course_codes: string[];
  academic_period: string | null;
  problem_type: string | null;
  severity: Severity;
  academic_impact: boolean;
  safety_flag: boolean;
  embedding: number[];
  embedding_model: string;
  problem_aspect: string | null;
  academic_activity: string | null;
  affected_group: string | null;
  sensitivity: string;
}

/** Create a new consolidated issue seeded from one complaint (title is identifier-redacted). */
export async function createIssueFromComplaint(
  tx: Db,
  complaintId: string,
  actor: { type: ActorType; id?: string | null },
): Promise<string> {
  const c = await one<{ subject: string; category_id: number }>(tx, `select subject, category_id from complaints where id = $1`, [complaintId]);
  if (!c) throw new Error("Complaint not found");
  const a = await one<AnalysisRow>(tx, `select * from complaint_analyses where complaint_id = $1`, [complaintId]);
  const issue = await one<{ id: string }>(
    tx,
    `insert into consolidated_issues
       (title, summary, category_id, course_codes, academic_period, problem_type, severity, academic_impact,
        safety_flag, sensitive, embedding, embedding_model, problem_aspect, academic_activity, affected_group)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9 or $12, $10, $11, $13, $14, $15)
     returning id`,
    [
      a?.summary_title ?? truncate(redactIdentifiers(c.subject), 100),
      a?.summary ?? "",
      a?.inferred_category_id ?? c.category_id,
      a?.course_codes ?? [],
      a?.academic_period ?? null,
      a?.problem_type ?? null,
      a?.severity ?? "routine",
      a?.academic_impact ?? false,
      a?.safety_flag ?? false,
      a?.embedding ?? null,
      a?.embedding_model ?? null,
      (a?.sensitivity ?? "none") !== "none",
      a?.problem_aspect ?? null,
      a?.academic_activity ?? null,
      a?.affected_group ?? null,
    ],
  );
  await addIssueEvent(tx, { issueId: issue!.id, actorType: actor.type, actorId: actor.id, eventType: "created", newValue: "new" });
  return issue!.id;
}

const STUDENT_LINK_MESSAGES: Partial<Record<MatchMethod, string>> = {
  auto: COPY.matchedExisting,
  review_confirmed: COPY.matchedExisting,
  manual: "Your submission is now being tracked together with related reports. You can follow updates from this page.",
  merge: "Your submission is now being tracked together with related reports. You can follow updates from this page.",
  split: "Your submission is now being tracked as a separate issue. You can follow updates from this page.",
};

/**
 * Link (or re-link) a complaint to an issue inside an existing transaction. The original
 * complaint is never modified beyond its link and status; its history is preserved.
 */
export async function linkComplaintToIssue(
  tx: Db,
  input: {
    complaintId: string;
    issueId: string;
    method: MatchMethod;
    confidence?: number | null;
    modelVersion?: string | null;
    actor: { type: ActorType; id?: string | null };
  },
): Promise<void> {
  const complaint = await one<{ consolidated_issue_id: string | null; status: ComplaintStatus; resolved_by_student_at: Date | null }>(
    tx,
    `select consolidated_issue_id, status, resolved_by_student_at from complaints where id = $1 for update`,
    [input.complaintId],
  );
  if (!complaint) throw new Error("Complaint not found");
  const previousIssueId = complaint.consolidated_issue_id;
  if (previousIssueId === input.issueId) return;

  const issue = await one<{ status: string }>(tx, `select status from consolidated_issues where id = $1 for update`, [input.issueId]);
  if (!issue) throw new Error("Issue not found");
  if (issue.status === "merged") throw new Error("Cannot link to a merged issue");

  await tx.query(`update issue_submissions set unlinked_at = now() where complaint_id = $1 and unlinked_at is null`, [input.complaintId]);
  await tx.query(
    `insert into issue_submissions (consolidated_issue_id, complaint_id, match_method, match_confidence, model_version, matched_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.issueId, input.complaintId, input.method, input.confidence ?? null, input.modelVersion ?? null, input.actor.type === "admin" ? input.actor.id : null],
  );

  // A pending student review request stays open until staff respond to it.
  const nextStatus =
    complaint.status === "review_requested" || complaint.resolved_by_student_at
      ? complaint.status
      : ISSUE_TO_COMPLAINT_STATUS[issue.status] ?? "received";
  const matchStatus = input.method === "auto" ? "auto_matched" : input.method === "new_issue" ? "new_issue" : "manual";
  await tx.query(
    `update complaints set consolidated_issue_id = $2, match_status = $3, status = $4, updated_at = now() where id = $1`,
    [input.complaintId, input.issueId, matchStatus, nextStatus],
  );

  await addComplaintEvent(tx, {
    complaintId: input.complaintId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    eventType: previousIssueId ? "relinked" : "linked",
    previousValue: previousIssueId,
    newValue: input.issueId,
    message: STUDENT_LINK_MESSAGES[input.method] ?? null,
    visibleToStudent: !!STUDENT_LINK_MESSAGES[input.method],
  });
  if (complaint.status !== nextStatus) {
    await addComplaintEvent(tx, {
      complaintId: input.complaintId,
      actorType: "system",
      eventType: "status_changed",
      previousValue: complaint.status,
      newValue: nextStatus,
    });
  }
  await addIssueEvent(tx, {
    issueId: input.issueId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    eventType: "submission_added",
    newValue: input.complaintId,
    reason: input.method,
  });

  const config = await getPriorityConfig(tx);
  await refreshIssueAggregates(tx, input.issueId, config);
  if (previousIssueId) {
    await addIssueEvent(tx, { issueId: previousIssueId, actorType: input.actor.type, actorId: input.actor.id, eventType: "submission_removed", previousValue: input.complaintId, reason: input.method });
    await refreshIssueAggregates(tx, previousIssueId, config);
  }
  // Replies already sent to this issue's reporters reach the newcomer straight away.
  await deliverIssueAnswers(tx, input.complaintId, input.issueId, { merge: input.method === "merge" });
}

const SEVERITY_ORDER: Severity[] = ["routine", "moderate", "serious", "urgent"];

function centroid(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
  return sum.map((x) => x / norm);
}

/**
 * Recompute report counts, distinct reporters, merged structured attributes, the matching
 * centroid and priority from the linked complaints. Counts are always recalculated from
 * source rows (never incremented) so they cannot drift under retries or concurrency.
 */
export async function refreshIssueAggregates(tx: Db, issueId: string, config?: PriorityConfig) {
  const counts = await one<{ total: number; distinct: number }>(
    tx,
    `select count(*)::int as total, count(distinct student_id)::int as distinct
       from complaints where consolidated_issue_id = $1`,
    [issueId],
  );
  const issue = await one<{ embedding_model: string | null; severity: Severity; course_codes: string[] }>(
    tx,
    `select embedding_model, severity, course_codes from consolidated_issues where id = $1`,
    [issueId],
  );
  if (!issue) return;
  const analyses = await rows<AnalysisRow>(
    tx,
    `select a.* from complaint_analyses a join complaints c on c.id = a.complaint_id
      where c.consolidated_issue_id = $1 order by c.created_at desc limit 200`,
    [issueId],
  );

  const model = issue.embedding_model ?? analyses[0]?.embedding_model ?? null;
  const vectors = analyses.filter((a) => a.embedding_model === model).map((a) => a.embedding);
  const severity = analyses.reduce<Severity>(
    (max, a) => (SEVERITY_ORDER.indexOf(a.severity) > SEVERITY_ORDER.indexOf(max) ? a.severity : max),
    issue.severity,
  );
  const courseCodes = [...new Set([...issue.course_codes, ...analyses.flatMap((a) => a.course_codes)])].sort().slice(0, 15);
  const academicImpact = analyses.some((a) => a.academic_impact);
  const safety = analyses.some((a) => a.safety_flag);
  const sensitive = safety || analyses.some((a) => a.sensitivity !== "none");

  await tx.query(
    `update consolidated_issues
        set total_submission_count = $2,
            distinct_reporter_count = $3,
            severity = $4,
            course_codes = $5,
            academic_impact = academic_impact or $6,
            safety_flag = safety_flag or $7,
            sensitive = sensitive or $10,
            embedding = coalesce($8, embedding),
            embedding_model = coalesce(embedding_model, $9),
            last_report_at = (select max(c.created_at) from complaints c where c.consolidated_issue_id = $1),
            last_activity_at = now(),
            updated_at = now()
      where id = $1`,
    [issueId, counts?.total ?? 0, counts?.distinct ?? 0, severity, courseCodes, academicImpact, safety, centroid(vectors), model, sensitive],
  );
  await recalculatePriority(tx, issueId, config ?? (await getPriorityConfig(tx)));
}

export async function recalculatePriority(tx: Db, issueId: string, config: PriorityConfig): Promise<Priority | null> {
  const s = await one<{
    severity: Severity;
    distinct_reporter_count: number;
    total_submission_count: number;
    reports_24h: number;
    days_unresolved: number;
    overdue: boolean;
    academic_impact: boolean;
    safety_flag: boolean;
    priority: Priority;
    priority_override: Priority | null;
  }>(
    tx,
    `select i.severity, i.distinct_reporter_count, i.total_submission_count,
            (select count(*)::int from complaints c where c.consolidated_issue_id = i.id
               and c.created_at > now() - interval '24 hours') as reports_24h,
            case when i.status in ('resolved','closed','merged') then 0
                 else extract(epoch from now() - i.created_at) / 86400 end as days_unresolved,
            (i.expected_resolution_at is not null and i.expected_resolution_at < now()
               and i.status not in ('resolved','closed','merged')) as overdue,
            i.academic_impact, i.safety_flag, i.priority, i.priority_override
       from consolidated_issues i where i.id = $1`,
    [issueId],
  );
  if (!s) return null;
  const result = computePriority(
    {
      severity: s.severity,
      distinctReporters: s.distinct_reporter_count,
      totalSubmissions: s.total_submission_count,
      reportsLast24h: s.reports_24h,
      daysUnresolved: Number(s.days_unresolved),
      overdue: s.overdue,
      academicImpact: s.academic_impact,
      safetyFlag: s.safety_flag,
    },
    config,
  );
  const effective = s.priority_override ?? result.priority;
  await tx.query(
    `update consolidated_issues set computed_priority = $2, priority_score = $3, priority = $4 where id = $1`,
    [issueId, result.priority, result.score, effective],
  );
  if (effective !== s.priority) {
    await addIssueEvent(tx, {
      issueId,
      actorType: "system",
      eventType: "priority_changed",
      previousValue: s.priority,
      newValue: effective,
      reason: result.factors.map((f) => f.factor).join("; "),
    });
  }
  return effective;
}
