import { one, rows, withStudentContext, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { getAIProviders, withTimeout } from "../ai";
import { extractCourseCodes } from "../ai/extract";
import { embeddingText } from "../ai/prompt";
import { calibrateSimilarity, cosineSimilarity } from "../matching/engine";
import { resolveComplaint } from "./progress";
import { ActionError, NotFoundError, type AdminContext } from "./admin/context";

/**
 * Instant answers. Every reusable staff message (memo, reply to a grouped issue, or a direct
 * reply staff marked as reusable) is part of an answer library. When a new submission asks
 * the same thing, the earlier answer is delivered to the student's Messages inbox and shown
 * on their receipt straight away; the submission still goes to staff as normal.
 */
export const INSTANT_ANSWER_CONFIG = {
  /** Calibrated similarity between the new submission and the answer text itself. Measured
   *  on real questions: repeats score 0.76–1.0, unrelated < 0.25. Short memos that only share
   *  a theme ("exam period" vs "exams begin Monday") reach 0.68–0.72, so the bar sits above them. */
  answerThreshold: 0.75,
  /** Similarity to the question the answer was written for (the issue or the original
   *  complaint). Higher, because related-but-different complaints also score well here. */
  contextThreshold: 0.85,
  maxAnswers: 2,
  /** Memos are time-sensitive; older ones are not offered. */
  memoDays: 90,
  answerDays: 180,
  /** Library entries embedded per lookup (the rest are embedded on later lookups). */
  embedBatch: 25,
};

export interface InstantAnswerMatch {
  messageId: string;
  similarity: number;
}

// Drafts and archived memos are never offered.
const windowSql = `m.memo_status = 'published' and m.created_at > now() - make_interval(days => case when m.audience = 'broadcast' then $2::int else $3::int end)`;

/** Embeds library entries that have no vector for the current model yet. */
export async function ensureAnswerEmbeddings(db: Db, limit = INSTANT_ANSWER_CONFIG.embedBatch): Promise<number> {
  const { embedder, timeoutMs } = getAIProviders();
  const pending = await rows<{ id: string; subject: string; body: string }>(
    db,
    `select m.id, m.subject, m.body from student_messages m
      where m.reusable and (m.embedding is null or m.embedding_model is distinct from $1) and ${windowSql}
      order by m.created_at desc limit $4`,
    [embedder.model, INSTANT_ANSWER_CONFIG.memoDays, INSTANT_ANSWER_CONFIG.answerDays, limit],
  );
  // A local model's first load can take several seconds.
  const budget = embedder.provider === "transformers" ? Math.max(timeoutMs, 60_000) : timeoutMs;
  for (const m of pending) {
    const vector = await withTimeout(budget, (signal) => embedder.embed(embeddingText(m.subject, m.body), signal));
    await db.query(`update student_messages set embedding = $2, embedding_model = $3, course_codes = $4 where id = $1`, [
      m.id,
      vector,
      embedder.model,
      extractCourseCodes(`${m.subject} ${m.body}`),
    ]);
  }
  return pending.length;
}

/**
 * Finds earlier answers to the same question. Never offered for sensitive submissions, and
 * never when the course codes clearly differ (an answer about ACC 301 does not answer FIN 305).
 */
export async function findInstantAnswers(
  db: Db,
  input: { embedding: number[]; embeddingModel: string; courseCodes: string[]; sensitive: boolean },
): Promise<InstantAnswerMatch[]> {
  if (input.sensitive) return [];
  if (getAIProviders().embedder.model === input.embeddingModel) await ensureAnswerEmbeddings(db);
  const cfg = INSTANT_ANSWER_CONFIG;
  const library = await rows<{ id: string; embedding: number[]; course_codes: string[]; issue_embedding: number[] | null; complaint_embedding: number[] | null }>(
    db,
    `select m.id, m.embedding, m.course_codes,
            case when i.embedding_model = $1 then i.embedding end as issue_embedding,
            case when ca.embedding_model = $1 then ca.embedding end as complaint_embedding
       from student_messages m
       left join consolidated_issues i on i.id = m.target_issue_id
       left join complaint_analyses ca on ca.complaint_id = m.target_complaint_id
      where m.reusable and m.embedding_model = $1 and ${windowSql}`,
    [input.embeddingModel, cfg.memoDays, cfg.answerDays],
  );
  const sim = (v: number[] | null) => (v && v.length === input.embedding.length ? calibrateSimilarity(cosineSimilarity(input.embedding, v), input.embeddingModel) : 0);
  const matches: InstantAnswerMatch[] = [];
  for (const m of library) {
    if (input.courseCodes.length && m.course_codes.length && !m.course_codes.some((c) => input.courseCodes.includes(c))) continue;
    const direct = sim(m.embedding);
    const context = Math.max(sim(m.issue_embedding), sim(m.complaint_embedding));
    const score = direct >= cfg.answerThreshold ? direct : context >= cfg.contextThreshold ? context : 0;
    if (score > 0) matches.push({ messageId: m.id, similarity: score });
  }
  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, cfg.maxAnswers);
}

/** Delivers answers to the submission's author: into their inbox, and onto the receipt. */
export async function recordInstantAnswers(tx: Db, complaintId: string, answers: InstantAnswerMatch[], source: "similar" | "same_issue" = "similar") {
  if (answers.length === 0) return;
  const c = await one<{ student_id: string }>(tx, `select student_id from complaints where id = $1`, [complaintId]);
  if (!c) return;
  for (const a of answers) {
    await tx.query(`insert into student_message_recipients (message_id, student_id) values ($1, $2) on conflict do nothing`, [a.messageId, c.student_id]);
    await tx.query(
      `insert into instant_answers (complaint_id, message_id, source, similarity) values ($1, $2, $3, $4) on conflict do nothing`,
      [complaintId, a.messageId, source, a.similarity],
    );
  }
}

/**
 * A submission that joins a grouped issue (automatically, after review, or through a merge)
 * instantly receives every reply already sent to everyone on that issue. Replies the student
 * already received are never sent again. Personal replies are not issue messages, so they are
 * never shared this way.
 */
export async function deliverIssueAnswers(tx: Db, complaintId: string, issueId: string) {
  const earlier = await rows<{ id: string }>(
    tx,
    `select m.id from student_messages m
      where m.audience = 'issue'
        and m.target_issue_id in (select id from consolidated_issues where id = $1 or merged_into_id = $1)
        and not exists (select 1 from student_message_recipients r join complaints c on c.student_id = r.student_id
                         where r.message_id = m.id and c.id = $2)
      order by m.created_at desc`,
    [issueId, complaintId],
  );
  await recordInstantAnswers(tx, complaintId, earlier.map((m) => ({ messageId: m.id, similarity: 1 })), "same_issue");
}

// ---------------------------------------------------------------------------
// Student side (row-level security: own submissions only)
// ---------------------------------------------------------------------------

export interface StudentInstantAnswer {
  message_id: string;
  source: "similar" | "same_issue";
  helpful: boolean | null;
  audience: string;
  subject: string;
  body: string;
  sent_at: Date;
}

export async function getInstantAnswers(studentId: string, complaintId: string): Promise<StudentInstantAnswer[]> {
  return withStudentContext(studentId, (tx) =>
    rows<StudentInstantAnswer>(
      tx,
      `select ia.message_id, ia.source, ia.helpful, m.audience, m.subject, m.body, m.created_at as sent_at
         from instant_answers ia join student_messages m on m.id = ia.message_id
        where ia.complaint_id = $1
        order by m.created_at desc`,
      [complaintId],
    ),
  );
}

export async function recordAnswerFeedback(studentId: string, complaintId: string, messageId: string, helpful: boolean): Promise<boolean> {
  return withStudentContext(studentId, async (tx) => {
    const res = await tx.query(`update instant_answers set helpful = $3, feedback_at = now() where complaint_id = $1 and message_id = $2`, [complaintId, messageId, helpful]);
    return (res.rowCount ?? 0) > 0;
  });
}

export const ANSWER_CONFIRMED_NOTE =
  "Answered instantly with an earlier Students' Association reply. Every student who reported this confirmed the answer resolved their question.";

/**
 * "Yes, this answered my question": records the feedback and resolves the student's own
 * submission. The grouped issue is resolved too, but only once every student who reported it
 * is resolved, so one student's answer never closes a problem others are still waiting on.
 */
export async function confirmAnswerResolved(studentId: string, complaintId: string, messageId: string): Promise<boolean> {
  // Row-level security: fails for anyone but the submission's owner.
  if (!(await recordAnswerFeedback(studentId, complaintId, messageId, true))) return false;
  await withTransaction(async (tx) => {
    const owned = await one<{ id: string }>(tx, `select id from complaints where id = $1 and student_id = $2`, [complaintId, studentId]);
    if (!owned) return;
    await resolveComplaint(tx, { type: "student", id: studentId }, complaintId, "You confirmed the Students' Association's answer resolved your question.", {
      byStudent: true,
      issueNote: ANSWER_CONFIRMED_NOTE,
    });
    await audit(tx, { actorType: "student", actorId: studentId, action: "complaint.answer_confirmed", entityType: "complaint", entityId: complaintId, metadata: { messageId } });
  });
  return true;
}

// ---------------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------------

export async function listInstantAnswersForComplaint(db: Db, complaintId: string) {
  return rows<{ message_id: string; subject: string; source: string; similarity: number | null; helpful: boolean | null; created_at: Date }>(
    db,
    `select ia.message_id, m.subject, ia.source, ia.similarity, ia.helpful, ia.created_at
       from instant_answers ia join student_messages m on m.id = ia.message_id
      where ia.complaint_id = $1 order by ia.created_at`,
    [complaintId],
  );
}

/** Association administrators, or the staff member who wrote the message, can change reuse. */
export async function setMessageReusable(admin: AdminContext, messageId: string, reusable: boolean) {
  await withTransaction(async (tx) => {
    const m = await one<{ author_admin_id: string }>(tx, `select author_admin_id from student_messages where id = $1 for update`, [messageId]);
    if (!m) throw new NotFoundError("Message");
    if (admin.role !== "union_admin" && m.author_admin_id !== admin.id) throw new ActionError("Only the author or an Association Administrator can change this.");
    await tx.query(`update student_messages set reusable = $2 where id = $1`, [messageId, reusable]);
    await audit(tx, {
      actorType: "admin",
      actorId: admin.id,
      action: reusable ? "message.reuse_enabled" : "message.reuse_disabled",
      entityType: "student_message",
      entityId: messageId,
    });
  });
}
