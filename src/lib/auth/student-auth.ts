import { one, withTransaction, type Db } from "../db";
import { audit } from "../audit";
import { normalizeUsername } from "../validation";
import type { DepartmentCode } from "../departments";

/*
 * Students identify themselves with a username only (no PIN or password), by design, to
 * keep logging a complaint as frictionless as possible. Usernames are unique after
 * normalisation (case-insensitive), so two students can never share one. A department is
 * chosen once and stored with the username.
 */

export type RegisterResult = { ok: true; studentId: string } | { ok: false; error: "username_taken" };

export async function isUsernameAvailable(db: Db, username: string): Promise<boolean> {
  const row = await one<{ id: string }>(db, `select id from students where normalized_username = $1`, [normalizeUsername(username)]);
  return !row;
}

export async function registerStudent(input: { username: string; department?: DepartmentCode | null }): Promise<RegisterResult> {
  const normalized = normalizeUsername(input.username);
  const department = input.department ?? null;
  return withTransaction(async (tx) => {
    // The unique index on normalized_username makes this race-safe.
    const row = await one<{ id: string }>(
      tx,
      `insert into students (username, normalized_username, department_code, department_set_at)
       values ($1, $2, $3, case when $3::text is null then null else now() end)
       on conflict (normalized_username) do nothing
       returning id`,
      [input.username.normalize("NFKC").trim(), normalized, department],
    );
    if (!row) return { ok: false, error: "username_taken" } as const;
    await audit(tx, { actorType: "student", actorId: row.id, action: "student.registered", entityType: "student", entityId: row.id });
    return { ok: true, studentId: row.id } as const;
  });
}

export type SignInResult = { ok: true; studentId: string; hasDepartment: boolean } | { ok: false; error: "not_found" };

/** Returning student: look the username up (case-insensitive). */
export async function signInStudent(db: Db, username: string): Promise<SignInResult> {
  const row = await one<{ id: string; department_code: string | null }>(
    db,
    `update students set last_login_at = now(), updated_at = now()
      where normalized_username = $1 and account_status = 'active'
      returning id, department_code`,
    [normalizeUsername(username)],
  );
  return row ? { ok: true, studentId: row.id, hasDepartment: !!row.department_code } : { ok: false, error: "not_found" };
}

/** Look a returning student up without signing them in (used before the one-time department step). */
export async function findActiveStudent(db: Db, username: string) {
  return one<{ id: string; department_code: string | null }>(
    db,
    `select id, department_code from students where normalized_username = $1 and account_status = 'active'`,
    [normalizeUsername(username)],
  );
}

/**
 * One-time department choice for students who signed up before departments existed.
 * Never overwrites an existing department ("You only pick it once").
 */
export async function setStudentDepartment(db: Db, studentId: string, department: DepartmentCode): Promise<boolean> {
  const res = await db.query(
    `update students set department_code = $2, department_set_at = now(), updated_at = now()
      where id = $1 and department_code is null`,
    [studentId, department],
  );
  if (res.rowCount) {
    await audit(db, { actorType: "student", actorId: studentId, action: "student.department_set", entityType: "student", entityId: studentId, metadata: { department } });
  }
  return !!res.rowCount;
}
