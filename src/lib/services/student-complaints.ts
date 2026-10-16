import { one, pool, rows, withStudentContext, withTransaction, type Db } from "../db";
import { COPY } from "@/config/app";
import { audit } from "../audit";
import { sha256 } from "../security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "../security/rate-limit";
import { enqueueMatchJob, processMatchJob } from "../matching/jobs";
import { addIssueEvent } from "./consolidation";
import type { ComplaintStatus } from "../validation";

export interface Category {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export async function listActiveCategories(db: Db = pool()): Promise<Category[]> {
  return rows<Category>(db, `select id, slug, name, description from issue_categories where active order by sort_order, name`);
}

export function contentFingerprint(subject: string, description: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return sha256(`${norm(subject)}\n${norm(description)}`);
}

export type SubmitResult =
  | { ok: true; complaintId: string }
  | { ok: false; error: "rate_limited"; retryAfterMinutes: number }
  | { ok: false; error: "duplicate"; existingComplaintId: string }
  | { ok: false; error: "invalid_category" };

/**
 * Persist a complaint first, then attempt matching. Matching failures never affect the
 * stored complaint: the job is retried later and staff can always group it manually.
 */
export async function submitComplaint(
  studentId: string,
  input: { categoryId: number; subject: string; description: string },
  clientKey: string,
  options: { matchInline?: boolean } = {},
): Promise<SubmitResult> {
  const db = pool();
  for (const [rule, subject] of [
    [RATE_LIMITS.complaintByStudentHour, studentId],
    [RATE_LIMITS.complaintByStudentDay, studentId],
    [RATE_LIMITS.complaintByClientHour, clientKey],
  ] as const) {
    const r = await consumeRateLimit(db, rule, subject);
    if (!r.allowed) return { ok: false, error: "rate_limited", retryAfterMinutes: Math.ceil(r.retryAfterSeconds / 60) };
  }

  const fingerprint = contentFingerprint(input.subject, input.description);

  const result = await withStudentContext(studentId, async (tx): Promise<SubmitResult> => {
    const category = await one<{ id: number }>(tx, `select id from issue_categories where id = $1 and active`, [input.categoryId]);
    if (!category) return { ok: false, error: "invalid_category" };

    // Reject repeated identical submissions from the same username within 7 days.
    const dup = await one<{ id: string }>(
      tx,
      `select id from complaints where student_id = app_current_student_id() and content_fingerprint = $1
         and created_at > now() - interval '7 days' limit 1`,
      [fingerprint],
    );
    if (dup) return { ok: false, error: "duplicate", existingComplaintId: dup.id };

    const row = await one<{ id: string }>(
      tx,
      `insert into complaints (student_id, category_id, subject, description, content_fingerprint)
       values (app_current_student_id(), $1, $2, $3, $4) returning id`,
      [input.categoryId, input.subject, input.description, fingerprint],
    );
    await tx.query(
      `insert into complaint_events (complaint_id, actor_type, actor_id, event_type, new_value, message)
       values ($1, 'student', app_current_student_id(), 'submitted', 'received', $2)`,
      [row!.id, COPY.acknowledgement],
    );
    return { ok: true, complaintId: row!.id };
  });

  if (!result.ok) return result;

  await withTransaction(async (tx) => {
    await enqueueMatchJob(tx, result.complaintId);
    await audit(tx, { actorType: "student", actorId: studentId, action: "complaint.submitted", entityType: "complaint", entityId: result.complaintId });
  }).catch((err) => {
    // The complaint is safely stored; the maintenance sweep re-creates missing jobs.
    console.error("Failed to enqueue matching job", { complaintId: result.complaintId, error: (err as Error).name });
  });

  if (options.matchInline !== false) {
    try {
      await processMatchJob(result.complaintId);
    } catch (err) {
      console.error("Inline matching failed; job remains queued", { complaintId: result.complaintId, error: (err as Error).name });
    }
  }
  return result;
}

export interface DashboardComplaint {
  id: string;
  subject: string;
  category: string;
  status: ComplaintStatus;
  match_status: string;
  created_at: Date;
  last_update_at: Date;
  last_viewed_at: Date | null;
  expected_resolution_at: Date | null;
  issue_status: string | null;
}

export async function getStudentDashboard(studentId: string): Promise<DashboardComplaint[]> {
  return withStudentContext(studentId, (tx) =>
    rows<DashboardComplaint>(
      tx,
      `select c.id, c.subject, cat.name as category, c.status, c.match_status, c.created_at, c.last_viewed_at,
              i.expected_resolution_at, i.status as issue_status,
              greatest(c.updated_at,
                       coalesce((select max(u.created_at) from issue_updates u where u.consolidated_issue_id = c.consolidated_issue_id), c.created_at),
                       coalesce((select max(e.created_at) from complaint_events e where e.complaint_id = c.id), c.created_at)) as last_update_at
         from complaints c
         join issue_categories cat on cat.id = c.category_id
         left join consolidated_issues i on i.id = c.consolidated_issue_id
        order by c.created_at desc`,
    ),
  );
}

export interface ComplaintDetail {
  complaint: DashboardComplaint & { description: string; review_request_reason: string | null; consolidated_issue_id: string | null };
  events: Array<{ id: string; event_type: string; previous_value: string | null; new_value: string | null; message: string | null; actor_type: string; created_at: Date }>;
  updates: Array<{ id: string; update_type: string; message: string; created_at: Date }>;
  issue: { status: string; expected_resolution_at: Date | null; resolved_at: Date | null; last_activity_at: Date } | null;
}

/**
 * Returns null when the complaint does not exist OR belongs to someone else — RLS makes
 * the two indistinguishable, so ids cannot be probed.
 */
export async function getStudentComplaint(studentId: string, complaintId: string): Promise<ComplaintDetail | null> {
  return withStudentContext(studentId, async (tx) => {
    const complaint = await one<ComplaintDetail["complaint"]>(
      tx,
      `select c.id, c.subject, c.description, cat.name as category, c.status, c.match_status, c.created_at, c.updated_at as last_update_at,
              c.last_viewed_at, c.review_request_reason, c.consolidated_issue_id,
              i.expected_resolution_at, i.status as issue_status
         from complaints c
         join issue_categories cat on cat.id = c.category_id
         left join consolidated_issues i on i.id = c.consolidated_issue_id
        where c.id = $1`,
      [complaintId],
    );
    if (!complaint) return null;
    const events = await rows<ComplaintDetail["events"][number]>(
      tx,
      `select id, event_type, previous_value, new_value, message, actor_type, created_at
         from complaint_events where complaint_id = $1 order by created_at, id`,
      [complaintId],
    );
    const updates = complaint.consolidated_issue_id
      ? await rows<ComplaintDetail["updates"][number]>(
          tx,
          `select id, update_type, message, created_at from issue_updates
            where consolidated_issue_id = $1 order by created_at desc`,
          [complaint.consolidated_issue_id],
        )
      : [];
    const issue = complaint.consolidated_issue_id
      ? await one<NonNullable<ComplaintDetail["issue"]>>(
          tx,
          `select status, expected_resolution_at, resolved_at, last_activity_at from consolidated_issues where id = $1`,
          [complaint.consolidated_issue_id],
        )
      : null;
    await tx.query(`update complaints set last_viewed_at = now() where id = $1`, [complaintId]);
    return { complaint, events, updates, issue };
  });
}

export type ReviewRequestResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "not_resolved" | "rate_limited" };

/** A student indicates that a complaint marked resolved/closed is still unresolved. */
export async function requestComplaintReview(studentId: string, complaintId: string, reason: string): Promise<ReviewRequestResult> {
  const limit = await consumeRateLimit(pool(), RATE_LIMITS.reviewRequestByStudentDay, studentId);
  if (!limit.allowed) return { ok: false, error: "rate_limited" };

  const result = await withStudentContext(studentId, async (tx) => {
    const c = await one<{ status: ComplaintStatus; consolidated_issue_id: string | null }>(
      tx,
      `select status, consolidated_issue_id from complaints where id = $1 for update`,
      [complaintId],
    );
    if (!c) return { ok: false as const, error: "not_found" as const };
    if (c.status !== "resolved" && c.status !== "closed") return { ok: false as const, error: "not_resolved" as const };
    await tx.query(
      `update complaints set status = 'review_requested', review_request_reason = $2, updated_at = now() where id = $1`,
      [complaintId, reason],
    );
    await tx.query(
      `insert into complaint_events (complaint_id, actor_type, actor_id, event_type, previous_value, new_value, message)
       values ($1, 'student', app_current_student_id(), 'review_requested', $2, 'review_requested',
               'You requested a review because the concern remains unresolved. The Student Union team will look at it again.')`,
      [complaintId, c.status],
    );
    // The student's reason also appears in the complaint's conversation, so staff see it there.
    await tx.query(`insert into complaint_messages (complaint_id, sender_type, body, is_review_request) values ($1, 'student', $2, true)`, [complaintId, reason]);
    return { ok: true as const, issueId: c.consolidated_issue_id };
  });
  if (!result.ok) return result;

  await withTransaction(async (tx) => {
    await tx.query(`update complaints set resolved_by_student_at = null where id = $1`, [complaintId]);
    if (result.issueId) {
      await addIssueEvent(tx, { issueId: result.issueId, actorType: "student", actorId: studentId, eventType: "review_requested", newValue: complaintId });
      await tx.query(`update consolidated_issues set last_activity_at = now() where id = $1`, [result.issueId]);
    }
    await audit(tx, { actorType: "student", actorId: studentId, action: "complaint.review_requested", entityType: "complaint", entityId: complaintId });
  });
  return { ok: true };
}

export type ComplaintListFilter = "all" | "open" | "resolved";

export interface MyComplaintRow extends DashboardComplaint {
  preview: string | null;
  unread: boolean;
}

/**
 * "My complaints": the student's own submissions with a one-line preview of the latest thing
 * from the Union and an unread marker. Row-level security limits this to their own rows.
 */
export async function listMyComplaints(studentId: string, opts: { filter?: ComplaintListFilter; q?: string } = {}): Promise<MyComplaintRow[]> {
  const filter = opts.filter ?? "all";
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 100);
  return withStudentContext(studentId, (tx) =>
    rows<MyComplaintRow>(
      tx,
      `select c.id, c.subject, cat.name as category, c.status, c.match_status, c.created_at, c.last_viewed_at,
              i.expected_resolution_at, i.status as issue_status,
              greatest(c.updated_at,
                       coalesce((select max(u.created_at) from issue_updates u where u.consolidated_issue_id = c.consolidated_issue_id), c.created_at),
                       coalesce((select max(m.created_at) from complaint_messages m where m.complaint_id = c.id), c.created_at)) as last_update_at,
              coalesce(
                (select m.body from complaint_messages m where m.complaint_id = c.id and m.sender_type = 'staff' order by m.created_at desc limit 1),
                (select u.message from issue_updates u where u.consolidated_issue_id = c.consolidated_issue_id order by u.created_at desc limit 1)
              ) as preview,
              (exists (select 1 from complaint_messages m where m.complaint_id = c.id and m.sender_type = 'staff' and m.read_by_student_at is null)
               or exists (select 1 from issue_updates u where u.consolidated_issue_id = c.consolidated_issue_id
                           and (c.last_viewed_at is null or u.created_at > c.last_viewed_at))) as unread
         from complaints c
         join issue_categories cat on cat.id = c.category_id
         left join consolidated_issues i on i.id = c.consolidated_issue_id
        where ($1 = 'all' or ($1 = 'open' and c.status not in ('resolved', 'closed')) or ($1 = 'resolved' and c.status in ('resolved', 'closed')))
          and ($2 = '' or lower(c.subject) like '%' || $2 || '%' or lower(cat.name) like '%' || $2 || '%' or lower(c.description) like '%' || $2 || '%')
        order by c.created_at desc`,
      // LIKE wildcards in the search text are dropped rather than escaped.
      [filter, q.replace(/[%_\\]/g, "")],
    ),
  );
}

export interface ActivityItem {
  complaint_id: string;
  subject: string;
  category: string;
  status: ComplaintStatus;
  kind: "reply" | "update" | "status";
  detail: string | null;
  at: Date;
}

/** The dashboard's "Recent activity": the last few things that happened on the student's own complaints. */
export async function recentActivity(studentId: string, limit = 5): Promise<ActivityItem[]> {
  return withStudentContext(studentId, (tx) =>
    rows<ActivityItem>(
      tx,
      `select a.complaint_id, c.subject, cat.name as category, c.status, a.kind, a.detail, a.at
         from (
           select m.complaint_id, 'reply' as kind, null::text as detail, m.created_at as at from complaint_messages m where m.sender_type = 'staff'
           union all
           select c2.id, 'update', null, u.created_at from issue_updates u join complaints c2 on c2.consolidated_issue_id = u.consolidated_issue_id
           union all
           select e.complaint_id, 'status', e.new_value, e.created_at from complaint_events e where e.event_type = 'status_changed'
         ) a
         join complaints c on c.id = a.complaint_id
         join issue_categories cat on cat.id = c.category_id
        order by a.at desc limit $1`,
      [limit],
    ),
  );
}
