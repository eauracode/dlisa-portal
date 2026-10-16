import { one, rows, withPublicContext, withStudentContext, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { assertCan } from "../auth/permissions";
import { cleanLine, cleanText } from "../validation";
import { ActionError, NotFoundError, type AdminContext } from "./admin/context";
import { listPublicIssues } from "./public-issues";
import { sendMessage } from "./messages";

/*
 * Memos: messages to all students (audience 'broadcast'), shown as a notice board. Every active
 * student can read published memos, including ones sent before they joined. The Memos page
 * also shows "Issue update" cards for unresolved public issues. Never any counts (rule 3).
 */

/** Memos newer than this show as "New" until opened; older ones are simply part of the board. */
export const MEMO_NEW_DAYS = 90;

export type MemoCard =
  | { kind: "notice"; id: string; title: string; body: string; pinned: boolean; publishedAt: Date; isNew: boolean }
  | { kind: "issue"; id: string; title: string; summary: string; category: string; status: string; latest: string | null; expectedAt: Date | null; updatedAt: Date };

export type MemoFilter = "all" | "notice" | "issue";

export const parseMemoFilter = (v: string | undefined): MemoFilter => (v === "notice" || v === "issue" ? v : "all");

/** Pure: pinned notices first, then everything else newest first. */
export function mergeMemoFeed(notices: MemoCard[], issues: MemoCard[], filter: MemoFilter): MemoCard[] {
  const at = (c: MemoCard) => (c.kind === "notice" ? c.publishedAt : c.updatedAt).getTime();
  const pinned = notices.filter((n) => n.kind === "notice" && n.pinned);
  const rest = [...notices.filter((n) => n.kind === "notice" && !n.pinned), ...issues].sort((a, b) => at(b) - at(a));
  const all = [...pinned, ...rest];
  return filter === "all" ? all : all.filter((c) => c.kind === filter);
}

const RESOLVED = new Set(["resolved", "closed", "merged"]);

/** Issue cards: public, never sensitive (the public role cannot see those), unresolved only. */
async function issueCards(): Promise<MemoCard[]> {
  return (await listPublicIssues())
    .filter((i) => !RESOLVED.has(i.status))
    .map((i) => ({
      kind: "issue" as const,
      id: i.id,
      title: i.title,
      summary: i.summary,
      category: i.category,
      status: i.status,
      latest: i.latest_update,
      expectedAt: i.expected_resolution_at,
      updatedAt: i.last_activity_at,
    }));
}

/**
 * The Memos feed. Signed in: every published memo, and opening the page records them as read.
 * Signed out: only memos marked public.
 */
export async function getMemoFeed(studentId: string | null, filter: MemoFilter): Promise<MemoCard[]> {
  type Row = { id: string; subject: string; body: string; pinned: boolean; created_at: Date; read_at: Date | null };
  const notices: Row[] =
    filter === "issue"
      ? []
      : studentId
        ? await withStudentContext(studentId, async (tx) => {
            const list = await rows<Row>(
              tx,
              `select m.id, m.subject, m.body, m.pinned, m.created_at, r.read_at
                 from student_messages m
                 left join student_message_recipients r on r.message_id = m.id and r.student_id = app_current_student_id()
                where m.audience = 'broadcast' and m.memo_status = 'published'
                order by m.pinned desc, m.created_at desc limit 100`,
            );
            const unread = list.filter((m) => !m.read_at).map((m) => m.id);
            if (unread.length) {
              await tx.query(
                `insert into student_message_recipients (message_id, student_id, read_at)
                 select unnest($1::uuid[]), app_current_student_id(), now()
                 on conflict (message_id, student_id) do update set read_at = coalesce(student_message_recipients.read_at, now())`,
                [unread],
              );
            }
            return list;
          })
        : await withPublicContext((tx) =>
            rows<Row>(tx, `select id, subject, body, pinned, created_at, null::timestamptz as read_at from student_messages order by pinned desc, created_at desc limit 100`),
          );
  const cutoff = Date.now() - MEMO_NEW_DAYS * 86_400_000;
  const cards: MemoCard[] = notices.map((m) => ({
    kind: "notice",
    id: m.id,
    title: m.subject,
    body: m.body,
    pinned: m.pinned,
    publishedAt: m.created_at,
    // "New" reflects the state before this visit (the page just recorded the read).
    isNew: !!studentId && !m.read_at && m.created_at.getTime() > cutoff,
  }));
  return mergeMemoFeed(cards, filter === "notice" ? [] : await issueCards(), filter);
}

export async function countUnreadMemos(studentId: string): Promise<number> {
  return withStudentContext(studentId, async (tx) => {
    const r = await one<{ n: number }>(
      tx,
      `select count(*)::int as n from student_messages m
        where m.audience = 'broadcast' and m.memo_status = 'published' and m.created_at > now() - make_interval(days => $1)
          and not exists (select 1 from student_message_recipients r
                           where r.message_id = m.id and r.student_id = app_current_student_id() and r.read_at is not null)`,
      [MEMO_NEW_DAYS],
    );
    return r!.n;
  });
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

function validate(title: string, body: string) {
  const t = cleanLine(title);
  const b = cleanText(body);
  if (t.length < 3 || t.length > 140) throw new ActionError("The title must be 3–140 characters.");
  if (b.length < 5 || b.length > 4000) throw new ActionError("The memo must be 5–4000 characters.");
  return { title: t, body: b };
}

export interface StaffMemo {
  id: string;
  subject: string;
  body: string;
  pinned: boolean;
  public: boolean;
  memo_status: "draft" | "published" | "archived";
  created_at: Date;
  author: string;
  seen: number;
}

export async function listMemosForStaff(db: Db, admin: AdminContext): Promise<StaffMemo[]> {
  assertCan(admin.role, "memos.draft");
  return rows<StaffMemo>(
    db,
    `select m.id, m.subject, m.body, m.pinned, m.public, m.memo_status, m.created_at, a.display_name as author,
            (select count(*)::int from student_message_recipients r where r.message_id = m.id and r.read_at is not null) as seen
       from student_messages m join admin_users a on a.id = m.author_admin_id
      where m.audience = 'broadcast'
      order by (m.memo_status = 'draft') desc, (m.memo_status = 'archived'), m.pinned desc, m.created_at desc
      limit 200`,
  );
}

/** Union Admins publish; Case Officers can only save drafts for an Admin to publish. */
export async function createMemo(admin: AdminContext, input: { title: string; body: string; pinned: boolean; public: boolean; publish: boolean }) {
  const { title, body } = validate(input.title, input.body);
  if (input.publish) {
    assertCan(admin.role, "memos.publish");
    const sent = await sendMessage(admin, { type: "all" }, { subject: title, body, reusable: true });
    await withTransaction(async (tx) => {
      await tx.query(`update student_messages set pinned = $2, public = $3 where id = $1`, [sent.messageId, input.pinned, input.public]);
      await audit(tx, { actorType: "admin", actorId: admin.id, action: "memo.published", entityType: "student_message", entityId: sent.messageId, metadata: { pinned: input.pinned, public: input.public } });
    });
    return sent.messageId;
  }
  assertCan(admin.role, "memos.draft");
  return withTransaction(async (tx) => {
    const m = await one<{ id: string }>(
      tx,
      `insert into student_messages (audience, subject, body, author_admin_id, reusable, pinned, public, memo_status)
       values ('broadcast', $1, $2, $3, true, $4, $5, 'draft') returning id`,
      [title, body, admin.id, input.pinned, input.public],
    );
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "memo.draft_saved", entityType: "student_message", entityId: m!.id });
    return m!.id;
  });
}

async function loadMemo(db: Db, id: string) {
  const m = await one<{ id: string; memo_status: string }>(db, `select id, memo_status from student_messages where id = $1 and audience = 'broadcast' for update`, [id]);
  if (!m) throw new NotFoundError("Memo");
  return m;
}

/** Publishing a draft delivers it to every active student. */
export async function publishDraft(admin: AdminContext, id: string) {
  assertCan(admin.role, "memos.publish");
  await withTransaction(async (tx) => {
    const m = await loadMemo(tx, id);
    if (m.memo_status !== "draft") throw new ActionError("Only drafts can be published.");
    const inserted = await tx.query(
      `insert into student_message_recipients (message_id, student_id) select $1::uuid, id from students where account_status = 'active' on conflict do nothing`,
      [id],
    );
    await tx.query(`update student_messages set memo_status = 'published', created_at = now(), updated_at = now(), recipient_count = $2 where id = $1`, [id, inserted.rowCount ?? 0]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "memo.published", entityType: "student_message", entityId: id });
  });
}

export async function setMemoPinned(admin: AdminContext, id: string, pinned: boolean) {
  assertCan(admin.role, "memos.publish");
  await withTransaction(async (tx) => {
    await loadMemo(tx, id);
    await tx.query(`update student_messages set pinned = $2, updated_at = now() where id = $1`, [id, pinned]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: pinned ? "memo.pinned" : "memo.unpinned", entityType: "student_message", entityId: id });
  });
}

/** Archived memos leave the board (and the instant-answer library). */
export async function archiveMemo(admin: AdminContext, id: string) {
  assertCan(admin.role, "memos.publish");
  await withTransaction(async (tx) => {
    await loadMemo(tx, id);
    await tx.query(`update student_messages set memo_status = 'archived', pinned = false, reusable = false, updated_at = now() where id = $1`, [id]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "memo.archived", entityType: "student_message", entityId: id });
  });
}

export async function editMemo(admin: AdminContext, id: string, input: { title: string; body: string; public: boolean }) {
  const { title, body } = validate(input.title, input.body);
  await withTransaction(async (tx) => {
    const m = await loadMemo(tx, id);
    // Drafts can be edited by whoever may draft; published memos only by those who may publish.
    assertCan(admin.role, m.memo_status === "draft" ? "memos.draft" : "memos.publish");
    // The text changed, so the instant-answer vector is recomputed on next use.
    await tx.query(`update student_messages set subject = $2, body = $3, public = $4, embedding = null, embedding_model = null, updated_at = now() where id = $1`, [
      id,
      title,
      body,
      input.public,
    ]);
    await audit(tx, { actorType: "admin", actorId: admin.id, action: "memo.edited", entityType: "student_message", entityId: id });
  });
}

/** Number of issue-update cards currently on the Memos board (staff hint only). */
export async function liveIssueUpdateCount(): Promise<number> {
  return (await issueCards()).length;
}
