import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool, withStudentContext } from "@/lib/db";
import { submitComplaint } from "@/lib/services/student-complaints";
import { assignOfficer, mergeIssues } from "@/lib/services/admin/issues";
import { getStudentInbox, getUnreadMessageCount, listSentMessages, sendMessage } from "@/lib/services/messages";
import { ForbiddenError } from "@/lib/auth/permissions";
import { registerStudent } from "@/lib/auth/student-auth";
import { categoryId, complaintRow, makeAdmin, makeStudent, resetData } from "../support/db";
import { basis, resetAI, useFakeAI } from "../support/fake-ai";

beforeEach(async () => {
  await resetData();
  useFakeAI({ lms: basis(0), fees: basis(1) });
});
afterAll(async () => {
  resetAI();
  await closePool();
});

async function report(studentId: string, marker: "lms" | "fees", n = 0) {
  const r = await submitComplaint(
    studentId,
    { categoryId: await categoryId("materials"), subject: `Problem ${marker} ${n}`, description: `#${marker} The LMS portal is not loading at all (${n}).` },
    `c-${studentId}-${n}`,
  );
  if (!r.ok) throw new Error(r.error);
  return r.complaintId;
}

const msg = { subject: "Update on the LMS", body: "The ICT unit is working on the LMS outage." };

describe("messages to a grouped issue", () => {
  it("reach every distinct reporter of the issue exactly once, and nobody else", async () => {
    const admin = await makeAdmin("union_admin");
    const [a, b, outsider] = [await makeStudent(), await makeStudent(), await makeStudent()];
    const first = await report(a, "lms", 1);
    await report(a, "lms", 2); // same student twice
    await report(b, "lms", 3);
    await report(outsider, "fees", 4);
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;

    const res = await sendMessage(admin, { type: "issue", issueId }, msg);
    expect(res.recipients).toBe(2);
    expect((await getStudentInbox(a)).map((m) => m.subject)).toEqual(["Update on the LMS"]);
    expect((await getStudentInbox(a))[0].related).toHaveLength(2); // links to both of A's complaints
    expect(await getStudentInbox(b)).toHaveLength(1);
    expect(await getStudentInbox(outsider)).toHaveLength(0);
  });

  it("cannot target a merged issue", async () => {
    const admin = await makeAdmin("union_admin");
    const x = await report(await makeStudent(), "lms");
    const y = await report(await makeStudent(), "fees");
    const [ix, iy] = [(await complaintRow(x))!.consolidated_issue_id!, (await complaintRow(y))!.consolidated_issue_id!];
    await mergeIssues(admin, iy, ix, "same");
    await expect(sendMessage(admin, { type: "issue", issueId: iy }, msg)).rejects.toThrow(/merged/);
  });
});

describe("direct messages and memos", () => {
  it("sends to one username (case-insensitive) and rejects unknown usernames", async () => {
    const admin = await makeAdmin("union_admin");
    const reg = await registerStudent({ username: "Quiet_Owl" });
    const other = await makeStudent();
    if (!reg.ok) throw new Error();
    expect((await sendMessage(admin, { type: "username", username: "QUIET_OWL" }, msg)).recipients).toBe(1);
    expect(await getStudentInbox(reg.studentId)).toHaveLength(1);
    expect(await getStudentInbox(other)).toHaveLength(0);
    await expect(sendMessage(admin, { type: "username", username: "nobody_here" }, msg)).rejects.toThrow(/No active student/);
  });

  it("messages the author of a complaint without revealing their username", async () => {
    const officer = await makeAdmin("case_officer");
    const admin = await makeAdmin("union_admin");
    const s = await makeStudent();
    const complaintId = await report(s, "lms");
    const issueId = (await complaintRow(complaintId))!.consolidated_issue_id!;
    await expect(sendMessage(officer, { type: "reporter", complaintId }, msg)).rejects.toThrow(/not found/); // not assigned yet
    await assignOfficer(admin, issueId, officer.id);
    await sendMessage(officer, { type: "reporter", complaintId }, msg);
    expect(await getStudentInbox(s)).toHaveLength(1);
    const [sent] = await listSentMessages(pool(), officer);
    expect(sent.target_label).toMatch(/^Reporter [0-9A-F]{6} \(via their complaint\)$/);
  });

  it("sends a memo to every active student", async () => {
    const admin = await makeAdmin("union_admin");
    const students = [await makeStudent(), await makeStudent(), await makeStudent()];
    await pool().query(`update students set account_status = 'suspended' where id = $1`, [students[2]]);
    const res = await sendMessage(admin, { type: "all" }, { subject: "Exam week notice", body: "Exams start on Monday. Check the timetable." });
    expect(res.recipients).toBe(2);
    expect(await getStudentInbox(students[0])).toHaveLength(1);
    expect(await getStudentInbox(students[2])).toHaveLength(0);
  });

  it("validates subject and body", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    await expect(sendMessage(admin, { type: "all" }, { subject: "Hi", body: "x" })).rejects.toThrow(/subject/);
  });
});

describe("permissions", () => {
  it("limits case officers to their assigned issues and blocks oversight officers", async () => {
    const admin = await makeAdmin("union_admin");
    const officer = await makeAdmin("case_officer");
    const oversight = await makeAdmin("oversight_officer");
    const c = await report(await makeStudent(), "lms");
    const issueId = (await complaintRow(c))!.consolidated_issue_id!;

    await expect(sendMessage(officer, { type: "issue", issueId }, msg)).rejects.toThrow(/not found/);
    await assignOfficer(admin, issueId, officer.id);
    expect((await sendMessage(officer, { type: "issue", issueId }, msg)).recipients).toBe(1);
    await expect(sendMessage(officer, { type: "all" }, msg)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendMessage(officer, { type: "username", username: "anyone" }, msg)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendMessage(oversight, { type: "issue", issueId }, msg)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listSentMessages(pool(), oversight)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("student inbox privacy and read tracking", () => {
  it("isolates inboxes in the database and tracks unread messages", async () => {
    const admin = await makeAdmin("union_admin");
    const reg = await registerStudent({ username: "inbox_owner" });
    const other = await makeStudent();
    if (!reg.ok) throw new Error();
    await sendMessage(admin, { type: "username", username: "inbox_owner" }, msg);

    expect(await getUnreadMessageCount(reg.studentId)).toBe(1);
    const visibleToOther = await withStudentContext(other, (tx) => tx.query(`select id from student_messages`));
    expect(visibleToOther.rowCount).toBe(0);
    await expect(withStudentContext(reg.studentId, (tx) => tx.query(`select author_admin_id from student_messages`))).rejects.toThrow(/permission denied/);

    const inbox = await getStudentInbox(reg.studentId, { markRead: true });
    expect(inbox[0].read_at).toBeNull(); // shown as new on the view that marks it read
    expect(await getUnreadMessageCount(reg.studentId)).toBe(0);
    const read = await one<{ n: number }>(pool(), `select count(*)::int as n from student_message_recipients where read_at is not null`);
    expect(read!.n).toBe(1);
    const [sent] = await listSentMessages(pool(), admin);
    expect(sent).toMatchObject({ recipient_count: 1, read_count: 1, target_label: "@inbox_owner" });
  });
});
