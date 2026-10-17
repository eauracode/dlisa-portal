import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool, withStudentContext } from "@/lib/db";
import { findActiveStudent, registerStudent, setStudentDepartment, signInStudent } from "@/lib/auth/student-auth";
import { submitComplaint } from "@/lib/services/student-complaints";
import { getIssueDetail, listIssues } from "@/lib/services/admin/issues";
import { listComplaints } from "@/lib/services/admin/complaints";
import { getOverview } from "@/lib/services/admin/overview";
import { departmentForStaff, DEPARTMENT_DISCLOSURE_THRESHOLD } from "@/lib/privacy";
import { departmentField } from "@/lib/department-validation";
import type { DepartmentCode } from "@/lib/departments";
import { categoryId, complaintRow, makeAdmin, resetData } from "../support/db";
import { basis, resetAI, useFakeAI } from "../support/fake-ai";

beforeEach(async () => {
  await resetData();
  useFakeAI({ timetable: basis(0), harass: basis(1) });
});
afterAll(async () => {
  resetAI();
  await closePool();
});

let n = 0;
async function student(department: DepartmentCode | null) {
  n += 1;
  const r = await registerStudent({ username: `dept_${n}_${Date.now() % 100000}`, department });
  if (!r.ok) throw new Error("register failed");
  return r.studentId;
}

async function report(studentId: string, marker = "timetable", category = "exams-results") {
  const r = await submitComplaint(
    studentId,
    { categoryId: await categoryId(category), subject: `Report ${n}`, description: `#${marker} The exam timetable has not been published yet (${Math.random()}).` },
    `c-${studentId}`,
  );
  if (!r.ok) throw new Error(r.error);
  return r.complaintId;
}

describe("department capture", () => {
  it("validates against the department list (Zod 4)", () => {
    expect(departmentField.safeParse("FIN").success).toBe(true);
    const bad = departmentField.safeParse("Finance");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toBe("Choose your department.");
  });

  it("stores the department with a new username and snapshots it onto each complaint", async () => {
    const s = await student("FIN");
    const row = await one<{ department_code: string; department_set_at: Date | null }>(pool(), `select department_code, department_set_at from students where id = $1`, [s]);
    expect(row).toMatchObject({ department_code: "FIN" });
    expect(row!.department_set_at).not.toBeNull();
    const c = await report(s);
    expect((await one<{ department_code: string }>(pool(), `select department_code from complaints where id = $1`, [c]))!.department_code).toBe("FIN");
  });

  it("keeps the complaint's snapshot when the student's department is later corrected", async () => {
    const s = await student("ACC");
    const c = await report(s);
    await pool().query(`update students set department_code = 'ECO' where id = $1`, [s]);
    expect((await one<{ department_code: string }>(pool(), `select department_code from complaints where id = $1`, [c]))!.department_code).toBe("ACC");
  });

  it("asks existing students once and never overwrites a chosen department", async () => {
    const s = await student(null);
    const username = (await one<{ username: string }>(pool(), `select username from students where id = $1`, [s]))!.username;
    expect(await findActiveStudent(pool(), username)).toMatchObject({ id: s, department_code: null });
    expect(await signInStudent(pool(), username)).toMatchObject({ ok: true, hasDepartment: false });
    expect(await setStudentDepartment(pool(), s, "BUS")).toBe(true);
    expect(await setStudentDepartment(pool(), s, "FIN")).toBe(false);
    expect(await signInStudent(pool(), username)).toMatchObject({ ok: true, hasDepartment: true });
  });

  it("never exposes other students' departments to the student role", async () => {
    const a = await student("FIN");
    await expect(withStudentContext(a, (tx) => tx.query(`select department_code from students`))).rejects.toThrow(/permission denied/);
  });
});

describe("department privacy on staff screens", () => {
  it("withholds below the threshold and for sensitive issues", () => {
    expect(DEPARTMENT_DISCLOSURE_THRESHOLD).toBe(5);
    expect(departmentForStaff({ departmentCode: "FIN", sameDepartmentReportersOnIssue: 4, issueIsSensitive: false })).toBeNull();
    expect(departmentForStaff({ departmentCode: "FIN", sameDepartmentReportersOnIssue: 5, issueIsSensitive: false })).toBe("Finance");
    expect(departmentForStaff({ departmentCode: "FIN", sameDepartmentReportersOnIssue: 50, issueIsSensitive: true })).toBeNull();
    expect(departmentForStaff({ departmentCode: null, sameDepartmentReportersOnIssue: 50, issueIsSensitive: false })).toBeNull();
  });

  it("shows a department, its 'By department' count and its filter only once 5 students from it reported the issue", async () => {
    const admin = await makeAdmin("union_admin");
    const first = await report(await student("FIN"));
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    for (let i = 0; i < 3; i++) await report(await student("FIN"));
    await report(await student("ACC"));

    // 4 Finance students: Association staff see each reporter's department, but the summary
    // counts and the filter still wait for 5.
    let detail = await getIssueDetail(pool(), admin, issueId);
    expect(detail.complaints.filter((c) => c.department === "Finance")).toHaveLength(4);
    expect(detail.byDepartment).toEqual({ shown: [], withheld: 5, withheldGroups: 2 });
    expect(await listIssues(pool(), admin, { department: "FIN" })).toHaveLength(0);
    expect(await listComplaints(pool(), admin, { department: "FIN" })).toHaveLength(0);

    // The 5th Finance student crosses the threshold.
    await report(await student("FIN"));
    detail = await getIssueDetail(pool(), admin, issueId);
    expect(detail.byDepartment).toEqual({ shown: [{ name: "Finance", students: 5 }], withheld: 1, withheldGroups: 1 });
    expect(detail.complaints.filter((c) => c.department === "Finance")).toHaveLength(5);
    expect(detail.complaints.every((c) => c.department !== null)).toBe(true); // including the lone Accounting student
    expect((await listIssues(pool(), admin, { department: "FIN" })).map((i) => i.id)).toEqual([issueId]);
    expect(await listComplaints(pool(), admin, { department: "FIN" })).toHaveLength(5);
    expect(await listComplaints(pool(), admin, { department: "ACC" })).toHaveLength(0);
    const overview = await getOverview(pool(), admin, { department: "FIN" });
    expect(overview.stats).toMatchObject({ total_issues: 1, total_complaints: 5 });
  });

  it("never discloses departments on sensitive issues, however many students reported", async () => {
    const admin = await makeAdmin("union_admin");
    const welfare = "welfare";
    const first = await report(await student("FIN"), "harass", welfare);
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    await pool().query(`update consolidated_issues set sensitive = true where id = $1`, [issueId]);
    for (let i = 0; i < 5; i++) {
      const c = await report(await student("FIN"), "harass", welfare);
      // sensitive matches go to review; attach directly to simulate staff confirming them
      await pool().query(`update complaints set consolidated_issue_id = $2 where id = $1`, [c, issueId]);
    }
    const detail = await getIssueDetail(pool(), admin, issueId);
    expect(detail.complaints.every((c) => c.department === "Finance")).toBe(true); // Association staff see reporters' departments
    expect(detail.byDepartment.shown).toEqual([]);
    // School-management oversight officers never see departments or usernames on sensitive issues.
    await pool().query(`update consolidated_issues set escalated = true, escalation_status = 'pending' where id = $1`, [issueId]);
    const oversight = await getIssueDetail(pool(), await makeAdmin("oversight_officer"), issueId);
    expect(oversight.complaints.every((c) => c.department === null && /^Reporter [0-9A-F]{6}$/.test(c.reporter))).toBe(true);
    expect(await listIssues(pool(), admin, { department: "FIN" })).toHaveLength(0);
  });
});
