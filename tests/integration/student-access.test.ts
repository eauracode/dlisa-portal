import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool, withStudentContext } from "@/lib/db";
import { isUsernameAvailable, registerStudent, signInStudent } from "@/lib/auth/student-auth";
import { createSession, resolveSession } from "@/lib/auth/sessions";
import { getStudentComplaint, getStudentDashboard, submitComplaint } from "@/lib/services/student-complaints";
import { categoryId, makeStudent, resetData } from "../support/db";
import { resetAI, useFakeAI } from "../support/fake-ai";

beforeEach(async () => {
  await resetData();
  useFakeAI({});
});
afterAll(async () => {
  resetAI();
  await closePool();
});

describe("student username-only access", () => {
  it("creates an account with just a username — no PIN, password or personal data (scenario 1)", async () => {
    const res = await registerStudent({ username: "QuietOwl" });
    expect(res.ok).toBe(true);
    const row = await one<{ normalized_username: string; pin_hash: string | null }>(pool(), `select normalized_username, pin_hash from students`);
    expect(row!.normalized_username).toBe("quietowl");
    expect(row!.pin_hash).toBeNull();
  });

  it("never lets two students share a username, regardless of case, and reports it as picked", async () => {
    expect(await isUsernameAvailable(pool(), "QuietOwl")).toBe(true);
    await registerStudent({ username: "QuietOwl" });
    expect(await isUsernameAvailable(pool(), "quietowl")).toBe(false);
    expect(await isUsernameAvailable(pool(), "QUIETOWL")).toBe(false);
    expect(await registerStudent({ username: "quietowl" })).toEqual({ ok: false, error: "username_taken" });
    const count = await one<{ n: number }>(pool(), `select count(*)::int as n from students`);
    expect(count!.n).toBe(1);
  });

  it("keeps usernames unique even under simultaneous registration", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => registerStudent({ username: "race_name" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("lets the same student return later with only their username and see previous complaints (scenario 2)", async () => {
    const reg = await registerStudent({ username: "returning_student" });
    if (!reg.ok) throw new Error();
    const cat = await categoryId("materials");
    const sub = await submitComplaint(reg.studentId, { categoryId: cat, subject: "LMS will not load", description: "The LMS has not loaded for me since Monday this week." }, "client-1");
    expect(sub.ok).toBe(true);

    const login = await signInStudent(pool(), "RETURNING_student");
    expect(login).toEqual({ ok: true, studentId: reg.studentId, hasDepartment: false });
    if (!login.ok) return;
    const { token } = await createSession(pool(), { type: "student", studentId: login.studentId });
    expect(await resolveSession(pool(), token, "student")).toBe(reg.studentId);
    const dashboard = await getStudentDashboard(login.studentId);
    expect(dashboard.map((c) => c.subject)).toEqual(["LMS will not load"]);
  });

  it("does not sign in with an unknown username", async () => {
    expect(await signInStudent(pool(), "nobody_here")).toEqual({ ok: false, error: "not_found" });
  });

  it("rejects forged or expired session tokens", async () => {
    const id = await makeStudent();
    expect(await resolveSession(pool(), "forged-token-forged-token-forged", "student")).toBeNull();
    const { token } = await createSession(pool(), { type: "student", studentId: id });
    await pool().query(`update sessions set expires_at = now() - interval '1 minute'`);
    expect(await resolveSession(pool(), token, "student")).toBeNull();
    // A student token is never valid as an admin token.
    const { token: t2 } = await createSession(pool(), { type: "student", studentId: id });
    expect(await resolveSession(pool(), t2, "admin")).toBeNull();
  });
});

describe("cross-student data isolation", () => {
  it("never lets one student read another's complaints (scenarios 3, 4)", async () => {
    const alice = await makeStudent("alice");
    const bob = await makeStudent("bob");
    const cat = await categoryId("welfare");
    const res = await submitComplaint(alice, { categoryId: cat, subject: "Private welfare matter", description: "This is a private concern that only I should be able to read." }, "client-a");
    if (!res.ok) throw new Error("submit failed");

    // Bob guesses Alice's complaint id (e.g. by editing the URL).
    expect(await getStudentComplaint(bob, res.complaintId)).toBeNull();
    expect(await getStudentDashboard(bob)).toEqual([]);
    expect(await getStudentComplaint(alice, res.complaintId)).not.toBeNull();
  });

  it("enforces isolation in the database itself via row-level security", async () => {
    const alice = await makeStudent("alice");
    const bob = await makeStudent("bob");
    const cat = await categoryId("academic");
    await submitComplaint(alice, { categoryId: cat, subject: "Lecturer absent again", description: "Our facilitator has not attended the last three classes." }, "client-a");

    const visible = await withStudentContext(bob, (tx) => tx.query(`select id from complaints`));
    expect(visible.rowCount).toBe(0);
    const students = await withStudentContext(bob, (tx) => tx.query(`select id from students`));
    expect(students.rowCount).toBe(1); // only himself

    // Bob cannot insert a complaint on Alice's behalf.
    await expect(
      withStudentContext(bob, (tx) =>
        tx.query(`insert into complaints (student_id, category_id, subject, description, content_fingerprint) values ($1, $2, 'Forged subject', 'Forged description text here', 'x')`, [alice, cat]),
      ),
    ).rejects.toThrow(/row-level security/);

    // Staff-only tables are not readable at all by the student role.
    await expect(withStudentContext(bob, (tx) => tx.query(`select * from administrative_notes`))).rejects.toThrow(/permission denied/);
    await expect(withStudentContext(bob, (tx) => tx.query(`select title, assigned_admin_id from consolidated_issues`))).rejects.toThrow(/permission denied/);
    await expect(withStudentContext(bob, (tx) => tx.query(`select pin_hash from students`))).rejects.toThrow(/permission denied/);
  });
});
