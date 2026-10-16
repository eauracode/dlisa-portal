import { rows, withStudentContext } from "../db";
import { COMPLAINT_STATUS_LABELS, formatDateTime } from "../format";

/**
 * The student-visible conversation for one complaint. SERVER ONLY. Privacy rules enforced here:
 * never reporter counts, other students' text, staff names, notes, priority or AI scores, and
 * "other students reported this" only while the linked issue is unresolved.
 */
export type ThreadEvent =
  | { type: "original"; at: Date; body: string }
  | { type: "grouped"; at: Date }
  | { type: "update"; at: Date; body: string }
  | { type: "official"; at: Date; body: string }
  | { type: "status"; at: Date; label: string }
  | { type: "date_set"; at: Date; label: string }
  | { type: "message"; at: Date; from: "student" | "staff"; body: string; readByOther: boolean; note?: string }
  | { type: "answer"; at: Date; messageId: string; subject: string; body: string; audience: string; helpful: boolean | null }
  | { type: "review_requested"; at: Date; body: string | null }
  | { type: "review_response"; at: Date; body: string };

const RESOLVED = new Set(["resolved", "closed", "merged"]);
export const issueIsUnresolved = (status: string | null | undefined) => !!status && !RESOLVED.has(status);

export interface ThreadInput {
  complaint: { createdAt: Date; description: string; matchStatus: string };
  issue: { status: string; groupedAt: Date | null } | null;
  publishedUpdates: { at: Date; body: string; official: boolean }[];
  statusHistory: { at: Date; label: string }[];
  dateHistory: { at: Date; label: string }[];
  messages: { at: Date; from: "student" | "staff"; body: string; readByOther: boolean; note?: string; reviewRequest?: boolean }[];
  answers: { at: Date; messageId: string; subject: string; body: string; audience: string; helpful: boolean | null }[];
  reviewRequests: { at: Date; body: string | null }[];
  reviewResponses: { at: Date; body: string }[];
}

/** Pure: merges the sources into one timeline. */
export function buildStudentThread(input: ThreadInput): ThreadEvent[] {
  const ev: ThreadEvent[] = [{ type: "original", at: input.complaint.createdAt, body: input.complaint.description }];
  // Rule 4: only say others reported this while the issue is unresolved, and only when the
  // submission joined an existing issue (not when it started its own).
  const joinedExisting = ["auto_matched", "manual"].includes(input.complaint.matchStatus);
  if (joinedExisting && input.issue?.groupedAt && issueIsUnresolved(input.issue.status)) ev.push({ type: "grouped", at: input.issue.groupedAt });
  for (const u of input.publishedUpdates) ev.push(u.official ? { type: "official", at: u.at, body: u.body } : { type: "update", at: u.at, body: u.body });
  for (const s of input.statusHistory) ev.push({ type: "status", ...s });
  for (const d of input.dateHistory) ev.push({ type: "date_set", ...d });
  // Review text the student wrote is shown on the review event, not twice.
  for (const m of input.messages) if (!m.reviewRequest) ev.push({ type: "message", at: m.at, from: m.from, body: m.body, readByOther: m.readByOther, note: m.note });
  for (const a of input.answers) ev.push({ type: "answer", ...a });
  for (const r of input.reviewRequests) ev.push({ type: "review_requested", ...r });
  for (const r of input.reviewResponses) ev.push({ type: "review_response", ...r });
  return ev.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Loads the thread for the complaint's owner (row-level security: anyone else gets null) and
 * marks staff messages and answers in it as read.
 */
export async function loadStudentThread(
  studentId: string,
  complaint: { id: string; description: string; created_at: Date; match_status: string; consolidated_issue_id: string | null; review_request_reason: string | null },
  issue: { status: string } | null,
): Promise<ThreadEvent[]> {
  return withStudentContext(studentId, async (tx) => {
    const id = complaint.id;
    const events = await rows<{ event_type: string; new_value: string | null; message: string | null; created_at: Date }>(
      tx,
      `select event_type, new_value, message, created_at from complaint_events where complaint_id = $1 order by created_at`,
      [id],
    );
    const updates = complaint.consolidated_issue_id
      ? await rows<{ update_type: string; message: string; created_at: Date }>(
          tx,
          `select update_type, message, created_at from issue_updates where consolidated_issue_id = $1 order by created_at`,
          [complaint.consolidated_issue_id],
        )
      : [];
    const chat = await rows<{ sender_type: "student" | "staff"; body: string; is_review_request: boolean; created_at: Date; read_by_student_at: Date | null; read_by_staff_at: Date | null }>(
      tx,
      `select sender_type, body, is_review_request, created_at, read_by_student_at, read_by_staff_at from complaint_messages where complaint_id = $1 order by created_at`,
      [id],
    );
    // Staff messages to everyone on this issue, or to this student about this complaint.
    // Instant answers are shown as answers, so they are excluded here.
    const staffMessages = await rows<{ id: string; audience: string; subject: string; body: string; created_at: Date }>(
      tx,
      `select m.id, m.audience, m.subject, m.body, m.created_at
         from student_messages m join student_message_recipients r on r.message_id = m.id
        where ((m.audience = 'issue' and m.target_issue_id = $2) or (m.audience = 'direct' and m.target_complaint_id = $1))
          and not exists (select 1 from instant_answers ia where ia.complaint_id = $1 and ia.message_id = m.id)
        order by m.created_at`,
      [id, complaint.consolidated_issue_id],
    );
    const answers = await rows<{ message_id: string; helpful: boolean | null; created_at: Date; subject: string; body: string; audience: string }>(
      tx,
      `select ia.message_id, ia.helpful, ia.created_at, m.subject, m.body, m.audience
         from instant_answers ia join student_messages m on m.id = ia.message_id where ia.complaint_id = $1`,
      [id],
    );

    // Reading the conversation reads everything in it.
    await tx.query(`update complaint_messages set read_by_student_at = now() where complaint_id = $1 and sender_type = 'staff' and read_by_student_at is null`, [id]);
    const readIds = [...staffMessages.map((m) => m.id), ...answers.map((a) => a.message_id)];
    if (readIds.length) await tx.query(`update student_message_recipients set read_at = now() where read_at is null and message_id = any($1::uuid[])`, [readIds]);

    const reviewTexts = chat.filter((m) => m.is_review_request);
    return buildStudentThread({
      complaint: { createdAt: complaint.created_at, description: complaint.description, matchStatus: complaint.match_status },
      issue: issue ? { status: issue.status, groupedAt: events.find((e) => e.event_type === "linked" || e.event_type === "relinked")?.created_at ?? null } : null,
      publishedUpdates: updates.map((u) => ({ at: u.created_at, body: u.message, official: u.update_type === "institutional_response" })),
      statusHistory: events
        .filter((e) => e.event_type === "status_changed" && e.new_value)
        .map((e) => ({ at: e.created_at, label: COMPLAINT_STATUS_LABELS[e.new_value!] ?? e.new_value! })),
      dateHistory: events
        .filter((e) => e.event_type === "deadline_changed")
        .map((e) => ({ at: e.created_at, label: e.new_value ? formatDateTime(e.new_value) : "withdrawn" })),
      messages: [
        ...chat.map((m) => ({
          at: m.created_at,
          from: m.sender_type,
          body: m.body,
          readByOther: m.sender_type === "student" ? !!m.read_by_staff_at : true,
          reviewRequest: m.is_review_request,
        })),
        ...staffMessages.map((m) => ({
          at: m.created_at,
          from: "staff" as const,
          body: `${m.subject}\n\n${m.body}`,
          readByOther: true,
          note: m.audience === "issue" ? "To everyone who reported this" : undefined,
        })),
      ],
      answers: answers.map((a) => ({ at: a.created_at, messageId: a.message_id, subject: a.subject, body: a.body, audience: a.audience, helpful: a.helpful })),
      reviewRequests: events
        .filter((e) => e.event_type === "review_requested")
        .map((e) => ({ at: e.created_at, body: reviewTexts.find((m) => Math.abs(m.created_at.getTime() - e.created_at.getTime()) < 60_000)?.body ?? null })),
      reviewResponses: events.filter((e) => e.event_type === "review_response" && e.message).map((e) => ({ at: e.created_at, body: e.message! })),
    });
  });
}
