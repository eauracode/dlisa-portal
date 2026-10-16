import { one, type Db } from "../db";
import { newSessionToken, sha256 } from "../security/crypto";

export type SessionSubject = { type: "student"; studentId: string } | { type: "admin"; adminId: string };

export const SESSION_POLICY = {
  // Students stay signed in on their device for 30 days so returning is effortless.
  student: { absoluteHours: 30 * 24, idleMinutes: 30 * 24 * 60 },
  admin: { absoluteHours: 8, idleMinutes: 60 },
} as const;

export async function createSession(db: Db, subject: SessionSubject): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const policy = SESSION_POLICY[subject.type];
  const row = await one<{ expires_at: Date }>(
    db,
    `insert into sessions (token_hash, subject_type, student_id, admin_id, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(hours => $5))
     returning expires_at`,
    [
      sha256(token),
      subject.type,
      subject.type === "student" ? subject.studentId : null,
      subject.type === "admin" ? subject.adminId : null,
      policy.absoluteHours,
    ],
  );
  return { token, expiresAt: row!.expires_at };
}

/**
 * Resolves a raw cookie token to its subject id, enforcing absolute and idle expiry, and
 * that the account is still active. Returns null for anything invalid.
 */
export async function resolveSession(db: Db, token: string | undefined, type: "student" | "admin"): Promise<string | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const policy = SESSION_POLICY[type];
  const row = await one<{ id: string; subject_id: string; stale: boolean }>(
    db,
    type === "student"
      ? `select s.id, s.student_id as subject_id, s.last_seen_at < now() - interval '5 minutes' as stale
           from sessions s join students st on st.id = s.student_id
          where s.token_hash = $1 and s.subject_type = 'student' and s.expires_at > now()
            and s.last_seen_at > now() - make_interval(mins => $2)
            and st.account_status = 'active'`
      : `select s.id, s.admin_id as subject_id, s.last_seen_at < now() - interval '5 minutes' as stale
           from sessions s join admin_users a on a.id = s.admin_id
          where s.token_hash = $1 and s.subject_type = 'admin' and s.expires_at > now()
            and s.last_seen_at > now() - make_interval(mins => $2)
            and a.active`,
    [sha256(token), policy.idleMinutes],
  );
  if (!row) return null;
  if (row.stale) await db.query(`update sessions set last_seen_at = now() where id = $1`, [row.id]);
  return row.subject_id;
}

export async function destroySession(db: Db, token: string | undefined) {
  if (!token) return;
  await db.query(`delete from sessions where token_hash = $1`, [sha256(token)]);
}

export async function destroyAllSessionsFor(db: Db, subject: SessionSubject) {
  if (subject.type === "student") await db.query(`delete from sessions where student_id = $1`, [subject.studentId]);
  else await db.query(`delete from sessions where admin_id = $1`, [subject.adminId]);
}

export async function pruneSessions(db: Db) {
  await db.query(`delete from sessions where expires_at < now() or last_seen_at < now() - interval '1 day'`);
}
