import { one, rows, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { assertCan } from "../auth/permissions";
import { cleanLine, cleanText } from "../validation";
import { calibrateSimilarity, cosineSimilarity } from "../matching/engine";
import { ActionError, NotFoundError, type AdminContext } from "./admin/context";

/*
 * Frequently asked questions and the saved-response picker.
 *
 * A FAQ is a student message with audience 'faq' (subject = question, body = answer). It never
 * goes to anyone when saved; it is part of the instant-answer library, so a student who asks
 * the same thing gets the answer straight away (see instant-answers.ts). FAQs do not expire.
 */

function validate(question: string, answer: string) {
  const q = cleanLine(question);
  const a = cleanText(answer);
  if (q.length < 5 || q.length > 150) throw new ActionError("The question must be 5–150 characters.");
  if (a.length < 5 || a.length > 4000) throw new ActionError("The answer must be 5–4000 characters.");
  return { question: q, answer: a };
}

export interface Faq {
  id: string;
  question: string;
  answer: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  author: string;
  /** Students who received it as an instant answer, and how they rated it. */
  used: number;
  helpful: number;
  not_helpful: number;
}

export async function listFaqs(db: Db, admin: AdminContext): Promise<Faq[]> {
  assertCan(admin.role, "faqs.manage");
  return rows<Faq>(
    db,
    `select m.id, m.subject as question, m.body as answer, (m.memo_status = 'published') as active, m.created_at, m.updated_at,
            a.display_name as author,
            (select count(*)::int from instant_answers ia where ia.message_id = m.id) as used,
            (select count(*)::int from instant_answers ia where ia.message_id = m.id and ia.helpful) as helpful,
            (select count(*)::int from instant_answers ia where ia.message_id = m.id and ia.helpful = false) as not_helpful
       from student_messages m join admin_users a on a.id = m.author_admin_id
      where m.audience = 'faq'
      order by (m.memo_status = 'published') desc, m.updated_at desc`,
  );
}

export async function createFaq(admin: AdminContext, input: { question: string; answer: string }, db?: Db): Promise<string> {
  assertCan(admin.role, "faqs.manage");
  const { question, answer } = validate(input.question, input.answer);
  const run = async (tx: Db) => {
    const m = await one<{ id: string }>(
      tx,
      `insert into student_messages (audience, subject, body, author_admin_id, reusable, memo_status) values ('faq', $1, $2, $3, true, 'published') returning id`,
      [question, answer, admin.id],
    );
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "faq.created", entityType: "student_message", entityId: m!.id });
    return m!.id;
  };
  return db ? run(db) : withTransaction(run);
}

export async function editFaq(admin: AdminContext, id: string, input: { question: string; answer: string }) {
  assertCan(admin.role, "faqs.manage");
  const { question, answer } = validate(input.question, input.answer);
  await withTransaction(async (tx) => {
    // The text changed, so the matching vector is recomputed.
    const res = await tx.query(
      `update student_messages set subject = $2, body = $3, embedding = null, embedding_model = null, updated_at = now() where id = $1 and audience = 'faq'`,
      [id, question, answer],
    );
    if (!res.rowCount) throw new NotFoundError("FAQ");
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "faq.edited", entityType: "student_message", entityId: id });
  });
}

/** Switched-off FAQs stay listed for staff but are never offered to students. */
export async function setFaqActive(admin: AdminContext, id: string, active: boolean) {
  assertCan(admin.role, "faqs.manage");
  await withTransaction(async (tx) => {
    const res = await tx.query(
      `update student_messages set memo_status = $2, reusable = $3, updated_at = now() where id = $1 and audience = 'faq'`,
      [id, active ? "published" : "archived", active],
    );
    if (!res.rowCount) throw new NotFoundError("FAQ");
    await audit(tx, { actorType: "admin", actorId: admin.id, action: active ? "faq.activated" : "faq.deactivated", entityType: "student_message", entityId: id });
  });
}

// ---------------------------------------------------------------------------
// Saved responses for the reply box
// ---------------------------------------------------------------------------

export interface SavedResponse {
  id: string;
  kind: "faq" | "memo" | "issue" | "reply";
  title: string;
  body: string;
  /** 0–1 similarity to the student's question, when both have vectors from the same model. */
  match: number | null;
}

const KIND: Record<string, SavedResponse["kind"]> = { faq: "faq", broadcast: "memo", issue: "issue" };

/**
 * Answers staff can reuse when replying to one submission: FAQs, memos, replies to grouped
 * issues and replies marked reusable. The closest to the student's question come first.
 */
export async function listSavedResponses(db: Db, complaintId: string, limit = 40): Promise<SavedResponse[]> {
  const q = await one<{ embedding: number[] | null; embedding_model: string | null }>(
    db,
    `select embedding, embedding_model from complaint_analyses where complaint_id = $1`,
    [complaintId],
  );
  const library = await rows<{ id: string; audience: string; subject: string; body: string; embedding: number[] | null; embedding_model: string | null; created_at: Date }>(
    db,
    `select m.id, m.audience, m.subject, m.body, m.embedding, m.embedding_model, m.created_at
       from student_messages m
      where m.reusable and m.memo_status = 'published'
      order by m.created_at desc limit 500`,
  );
  const scored = library.map((m) => {
    const comparable = q?.embedding && m.embedding && m.embedding_model === q.embedding_model && m.embedding.length === q.embedding.length;
    return {
      id: m.id,
      kind: KIND[m.audience] ?? ("reply" as const),
      title: m.subject,
      body: m.body,
      match: comparable ? Math.round(calibrateSimilarity(cosineSimilarity(q!.embedding!, m.embedding!), q!.embedding_model) * 100) / 100 : null,
      at: m.created_at.getTime(),
    };
  });
  // Best match first; without vectors, FAQs first, then newest.
  scored.sort((a, b) => (b.match ?? -1) - (a.match ?? -1) || Number(b.kind === "faq") - Number(a.kind === "faq") || b.at - a.at);
  // The same answer is often sent more than once; offer each text once.
  const seen = new Set<string>();
  return scored
    .filter((s) => (seen.has(s.body) ? false : (seen.add(s.body), true)))
    .slice(0, limit)
    .map(({ at: _at, ...s }) => s);
}
