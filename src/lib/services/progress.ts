import { one, type Db } from "../db";
import { COPY } from "@/config/app";
import { addComplaintEvent, addIssueEvent, recalculatePriority } from "./consolidation";
import { getPriorityConfig } from "./settings";

/*
 * How a submission moves through its statuses without anyone changing them by hand:
 *
 *   Received ──(staff reply or issue message)──▶ In progress ──▶ Resolved
 *
 *   - Received: the student sent it; nobody on the team has responded yet.
 *   - In progress: a staff member replied to the student, or messaged the issue's reporters.
 *   - Resolved: the student clicked "Helpful" on an answer, or staff chose "Reply & resolve"
 *     (or "Send & resolve" on an issue message, or set the issue's status to Resolved).
 *
 * A grouped issue becomes Resolved once every submission in it is resolved, so one student's
 * answer never closes a problem others are still waiting on.
 */

type Actor = { type: "admin" | "student" | "system"; id?: string | null };

const NOT_STARTED = ["received", "under_review"];
const DONE = ["resolved", "closed"];

/** Received / under review → in progress, for one submission. */
export async function startComplaint(tx: Db, actor: Actor, complaintId: string) {
  const c = await one<{ status: string }>(tx, `select status from complaints where id = $1 for update`, [complaintId]);
  if (!c || !NOT_STARTED.includes(c.status)) return;
  await tx.query(`update complaints set status = 'in_progress', updated_at = now() where id = $1`, [complaintId]);
  await addComplaintEvent(tx, {
    complaintId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    eventType: "status_changed",
    previousValue: c.status,
    newValue: "in_progress",
    message: "The Students' Association is working on this.",
  });
}

/** One submission is resolved; its issue follows once every submission in it is resolved. */
export async function resolveComplaint(tx: Db, actor: Actor, complaintId: string, message: string, opts: { byStudent?: boolean; issueNote?: string } = {}) {
  const c = await one<{ status: string; consolidated_issue_id: string | null }>(
    tx,
    `select status, consolidated_issue_id from complaints where id = $1 for update`,
    [complaintId],
  );
  if (!c || [...DONE, "review_requested"].includes(c.status)) return;
  await tx.query(
    `update complaints set status = 'resolved', resolved_by_student_at = case when $2 then now() else resolved_by_student_at end, updated_at = now() where id = $1`,
    [complaintId, !!opts.byStudent],
  );
  await addComplaintEvent(tx, { complaintId, actorType: actor.type, actorId: actor.id ?? null, eventType: "status_changed", previousValue: c.status, newValue: "resolved", message });
  if (c.consolidated_issue_id) await resolveIssueWhenAllResolved(tx, actor, c.consolidated_issue_id, complaintId, opts.issueNote ?? ALL_RESOLVED_NOTE);
}

export const ALL_RESOLVED_NOTE = "Every student who reported this issue has had their submission resolved.";

async function resolveIssueWhenAllResolved(tx: Db, actor: Actor, issueId: string, complaintId: string, note: string) {
  await addIssueEvent(tx, { issueId, actorType: actor.type, actorId: actor.id ?? null, eventType: actor.type === "student" ? "answer_confirmed" : "submission_resolved", newValue: complaintId });
  const issue = await one<{ status: string; open_reports: number }>(
    tx,
    `select i.status, (select count(*)::int from complaints c where c.consolidated_issue_id = i.id and c.status not in ('resolved', 'closed')) as open_reports
       from consolidated_issues i where i.id = $1 for update`,
    [issueId],
  );
  if (!issue || issue.open_reports > 0 || [...DONE, "merged"].includes(issue.status)) {
    await tx.query(`update consolidated_issues set last_activity_at = now() where id = $1`, [issueId]);
    return;
  }
  await tx.query(
    `update consolidated_issues set status = 'resolved', resolved_at = now(), resolution_note = coalesce(resolution_note, $2), last_activity_at = now(), updated_at = now() where id = $1`,
    [issueId, note],
  );
  await addIssueEvent(tx, { issueId, actorType: "system", eventType: "status_changed", previousValue: issue.status, newValue: "resolved", reason: note });
  await recalculatePriority(tx, issueId, await getPriorityConfig(tx));
}

export const STAFF_RESOLVED_MESSAGE = COPY.resolved;
