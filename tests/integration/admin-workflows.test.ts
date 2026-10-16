import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool, withStudentContext } from "@/lib/db";
import { getStudentComplaint, requestComplaintReview, submitComplaint } from "@/lib/services/student-complaints";
import {
  addNote,
  assignOfficer,
  changeStatus,
  createProposal,
  decideProposal,
  escalateIssue,
  getIssueDetail,
  handleReviewRequest,
  listIssues,
  mergeIssues,
  overridePriority,
  publishUpdate,
  setDeadline,
  setPublicVisibility,
  splitIssue,
} from "@/lib/services/admin/issues";
import { getOverview } from "@/lib/services/admin/overview";
import { listPublicIssues } from "@/lib/services/public-issues";
import { ForbiddenError } from "@/lib/auth/permissions";
import { categoryId, complaintRow, issueRow, makeAdmin, makeStudent, resetData } from "../support/db";
import { basis, resetAI, useFakeAI } from "../support/fake-ai";
import { COPY } from "@/config/app";

beforeEach(async () => {
  await resetData();
  useFakeAI({ alpha: basis(0), beta: basis(1) });
});
afterAll(async () => {
  resetAI();
  await closePool();
});

async function seedIssue(marker = "alpha", reporters = 2) {
  const cat = await categoryId("timetable");
  const students: string[] = [];
  const complaints: string[] = [];
  for (let i = 0; i < reporters; i++) {
    const s = await makeStudent();
    const r = await submitComplaint(s, { categoryId: cat, subject: `Lecture timetable clash ${marker} ${i}`, description: `#${marker} Two lectures are scheduled at the same time every Tuesday (${i}).` }, `c${i}${marker}`);
    if (!r.ok) throw new Error(r.error);
    students.push(s);
    complaints.push(r.complaintId);
  }
  const issueId = (await complaintRow(complaints[0]))!.consolidated_issue_id!;
  return { issueId, students, complaints };
}

describe("published updates and private notes", () => {
  it("shows a published update to every associated student (scenario 11)", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId, students, complaints } = await seedIssue();
    await publishUpdate(admin, issueId, { message: "The timetable unit is preparing a revised schedule.", visibility: "reporters" });
    for (let i = 0; i < students.length; i++) {
      const d = await getStudentComplaint(students[i], complaints[i]);
      expect(d!.updates.map((u) => u.message)).toContain("The timetable unit is preparing a revised schedule.");
      expect(d!.events.some((e) => e.event_type === "update_published")).toBe(true);
    }
  });

  it("keeps internal and oversight notes private from students and the public (scenario 12)", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId, students, complaints } = await seedIssue();
    await addNote(admin, issueId, "INTERNAL: lecturer is on leave", "internal");
    await addNote(admin, issueId, "OVERSIGHT: budget concern", "oversight");
    await setPublicVisibility(admin, issueId, { visible: true, publicTitle: "Lecture timetable clash", publicSummary: "Two lectures overlap on Tuesdays." });

    const d = await getStudentComplaint(students[0], complaints[0]);
    expect(JSON.stringify(d)).not.toMatch(/INTERNAL|OVERSIGHT/);
    const pub = await listPublicIssues();
    expect(pub).toHaveLength(1);
    expect(JSON.stringify(pub)).not.toMatch(/INTERNAL|OVERSIGHT|Tuesday \(0\)/);
    await expect(withStudentContext(students[0], (tx) => tx.query(`select note from administrative_notes`))).rejects.toThrow(/permission denied/);

    // Case officers see internal notes but not restricted oversight notes.
    const officer = await makeAdmin("case_officer");
    await assignOfficer(admin, issueId, officer.id);
    const officerView = await getIssueDetail(pool(), officer, issueId);
    expect(officerView.notes.map((n) => n.note)).toEqual(["INTERNAL: lecturer is on leave"]);
  });

  it("only shows approved, anonymised issues publicly", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId } = await seedIssue();
    expect(await listPublicIssues()).toHaveLength(0);
    await expect(setPublicVisibility(admin, issueId, { visible: true, publicTitle: "", publicSummary: "" })).rejects.toThrow(/public title/);
  });
});

describe("deadlines", () => {
  it("lets administrators set and revise expected resolution dates with a reason (scenario 13)", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId, students, complaints } = await seedIssue();
    const before = await getStudentComplaint(students[0], complaints[0]);
    expect(before!.issue!.expected_resolution_at).toBeNull();

    const first = new Date(Date.now() + 7 * 86400_000);
    await setDeadline(admin, issueId, first, null);
    expect((await issueRow(issueId))!.expected_resolution_at!.getTime()).toBe(first.getTime());

    const later = new Date(Date.now() + 14 * 86400_000);
    await expect(setDeadline(admin, issueId, later, "")).rejects.toThrow(/reason/);
    await setDeadline(admin, issueId, later, "Awaiting the faculty board meeting");
    const after = await getStudentComplaint(students[0], complaints[0]);
    expect(after!.issue!.expected_resolution_at!.getTime()).toBe(later.getTime());
    expect(after!.events.filter((e) => e.event_type === "deadline_changed")).toHaveLength(2);
  });

  it("surfaces overdue issues on the dashboard (scenario 14)", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId } = await seedIssue();
    await setDeadline(admin, issueId, new Date(Date.now() + 86400_000), null);
    await pool().query(`update consolidated_issues set expected_resolution_at = now() - interval '1 day' where id = $1`, [issueId]);
    const overview = await getOverview(pool(), admin, {});
    expect(overview.stats.overdue).toBe(1);
    expect(overview.urgent.map((u) => u.id)).toContain(issueId);
    const overdue = await listIssues(pool(), admin, { overdue: true });
    expect(overdue.map((i) => i.id)).toEqual([issueId]);
  });
});

describe("resolution and review requests", () => {
  it("requires a resolution note, and lets a student request review which can reopen the issue (scenario 17)", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId, students, complaints } = await seedIssue();
    await expect(changeStatus(admin, issueId, "resolved", "")).rejects.toThrow(/resolution note/);
    await changeStatus(admin, issueId, "resolved", "A revised timetable has been published.");
    expect((await complaintRow(complaints[0]))!.status).toBe("resolved");
    const d = await getStudentComplaint(students[0], complaints[0]);
    expect(d!.events.some((e) => e.message === COPY.resolved)).toBe(true);
    expect(d!.updates[0].message).toBe("A revised timetable has been published.");

    // Both reporters ask for a review; reopening must clear both requests.
    expect((await requestComplaintReview(students[1], complaints[1], "x".repeat(20))).ok).toBe(true);
    const res = await requestComplaintReview(students[0], complaints[0], "The clash still exists on the new timetable.");
    expect(res.ok).toBe(true);
    expect((await complaintRow(complaints[0]))!.status).toBe("review_requested");

    await handleReviewRequest(admin, complaints[0], "reopen", "We have reopened this issue and will follow up.");
    expect((await issueRow(issueId))!.status).toBe("in_progress");
    expect((await complaintRow(complaints[0]))!.status).toBe("in_progress");
    expect((await complaintRow(complaints[1]))!.status).toBe("in_progress");
  });

  it("rejects review requests for complaints that are not resolved", async () => {
    const { students, complaints } = await seedIssue("alpha", 1);
    expect(await requestComplaintReview(students[0], complaints[0], "Still not fixed at all.")).toEqual({ ok: false, error: "not_resolved" });
  });
});

describe("role-based access", () => {
  it("lets oversight officers act on escalated issues only, without union admin powers (scenario 18)", async () => {
    const admin = await makeAdmin("union_admin");
    const oversight = await makeAdmin("oversight_officer");
    const { issueId } = await seedIssue();
    const other = await seedIssue("beta", 1);

    await expect(getIssueDetail(pool(), oversight, issueId)).rejects.toThrow(/not found/);
    await escalateIssue(admin, issueId, "Requires the Registry to act");
    const view = await getIssueDetail(pool(), oversight, issueId);
    expect(view.issue.escalated).toBe(true);
    expect(view.complaints[0].reporter).toMatch(/^Reporter [0-9A-F]{6}$/);
    expect(JSON.stringify(view.complaints)).not.toMatch(/student_id/);

    await addNote(oversight, issueId, "Registry has been contacted", "oversight");
    await publishUpdate(oversight, issueId, { message: "The Registry has approved a revised timetable.", visibility: "reporters", type: "institutional_response" });

    await expect(setDeadline(oversight, issueId, new Date(Date.now() + 86400_000), null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignOfficer(oversight, issueId, oversight.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(overridePriority(oversight, issueId, "critical", "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mergeIssues(oversight, other.issueId, issueId, "reason")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addNote(oversight, issueId, "internal attempt", "internal")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listIssues(pool(), oversight, {})).map((i) => i.id)).toEqual([issueId]);
  });

  it("limits case officers to assigned issues and routes deadlines through proposals", async () => {
    const admin = await makeAdmin("union_admin");
    const officer = await makeAdmin("case_officer");
    const { issueId } = await seedIssue();
    await expect(changeStatus(officer, issueId, "in_progress", null)).rejects.toThrow(/not found/);
    await assignOfficer(admin, issueId, officer.id);
    await changeStatus(officer, issueId, "in_progress", null);
    await expect(setDeadline(officer, issueId, new Date(Date.now() + 86400_000), null)).rejects.toBeInstanceOf(ForbiddenError);

    const proposed = new Date(Date.now() + 5 * 86400_000);
    await createProposal(officer, issueId, { type: "deadline", deadline: proposed, reason: "Timetable unit estimate" });
    const detail = await getIssueDetail(pool(), admin, issueId);
    expect((await issueRow(issueId))!.expected_resolution_at).toBeNull(); // not confirmed yet
    await decideProposal(admin, detail.proposals[0].id, true, null);
    expect((await issueRow(issueId))!.expected_resolution_at!.getTime()).toBe(proposed.getTime());
  });

  it("lets union administrators override priority with a recorded reason", async () => {
    const admin = await makeAdmin("union_admin");
    const { issueId } = await seedIssue();
    await expect(overridePriority(admin, issueId, "critical", "")).rejects.toThrow(/reason/);
    await overridePriority(admin, issueId, "critical", "Examinations start on Monday");
    expect((await issueRow(issueId))!.priority).toBe("critical");
  });
});

describe("merge and split", () => {
  it("merges incorrectly separated issues and splits incorrectly grouped submissions", async () => {
    const admin = await makeAdmin("union_admin");
    const a = await seedIssue("alpha", 2);
    const b = await seedIssue("beta", 1);
    expect(a.issueId).not.toBe(b.issueId);

    await mergeIssues(admin, b.issueId, a.issueId, "Same timetable clash");
    expect(await issueRow(a.issueId)).toMatchObject({ total_submission_count: 3, distinct_reporter_count: 3 });
    expect((await issueRow(b.issueId))!.status).toBe("merged");
    expect((await complaintRow(b.complaints[0]))!.consolidated_issue_id).toBe(a.issueId);

    const newIssue = await splitIssue(admin, a.issueId, [b.complaints[0]], null, "Actually a different clash");
    expect((await complaintRow(b.complaints[0]))!.consolidated_issue_id).toBe(newIssue);
    expect(await issueRow(a.issueId)).toMatchObject({ total_submission_count: 2 });
  });
});
