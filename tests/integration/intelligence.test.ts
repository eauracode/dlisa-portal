import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool, rows } from "@/lib/db";
import { processMatchJob, JOB_POLICY } from "@/lib/matching/jobs";
import { getStudentComplaint, submitComplaint } from "@/lib/services/student-complaints";
import { retryMatching, listPendingReviews } from "@/lib/services/admin/complaints";
import { setDeadline, changeStatus } from "@/lib/services/admin/issues";
import { getActivityVersion, getLiveActivity } from "@/lib/services/admin/live";
import { listPublicIssues } from "@/lib/services/public-issues";
import { studentStatusMessage } from "@/lib/services/student-messages";
import { MATCH_ALGORITHM_VERSION } from "@/lib/matching/engine";
import { categoryId, complaintRow, issueRow, makeAdmin, makeStudent, resetData } from "../support/db";
import { basis, resetAI, useFakeAI, type MarkerEmbedder } from "../support/fake-ai";

let embedder: MarkerEmbedder;
beforeEach(async () => {
  await resetData();
  embedder = useFakeAI({ timetable: basis(0), harass: basis(1), wifi: basis(3) });
});
afterAll(async () => {
  resetAI();
  await closePool();
});

const exams = () => categoryId("exams-results");
async function submit(studentId: string, text: string, opts: { inline?: boolean; category?: number } = {}) {
  const r = await submitComplaint(
    studentId,
    { categoryId: opts.category ?? (await exams()), subject: text.slice(0, 60), description: text },
    `client-${studentId}-${Math.random()}`,
    { matchInline: opts.inline ?? true },
  );
  if (!r.ok) throw new Error(r.error);
  return r.complaintId;
}

describe("real-time processing pipeline", () => {
  it("persists first, processes in the background, records provenance and refreshes dashboards (spec 17)", async () => {
    const admin = await makeAdmin("union_admin");
    const a = await makeStudent();
    const b = await makeStudent();
    await submit(a, "#timetable Our exam timetable is not out and exams are close.");
    const before = await getActivityVersion(pool());

    // Submission returns before any AI work: complaint saved, job queued, status pending.
    const id = await submit(b, "#timetable We have not received the schedule for our examinations.", { inline: false });
    expect(await complaintRow(id)).toMatchObject({ match_status: "pending", consolidated_issue_id: null });
    const pendingView = await getStudentComplaint(b, id);
    expect(studentStatusMessage({ matchStatus: pendingView!.complaint.match_status, complaintStatus: pendingView!.complaint.status, issue: pendingView!.issue })!.text).toMatch(/checking/);

    // The background step (after() in production) completes the work.
    expect(await processMatchJob(id)).toBe("auto");
    const after = await getActivityVersion(pool());
    expect(after).not.toBe(before);

    const decision = await one<{ decision: string; algorithm_version: string; compatible: string[]; conflicts: string[]; verifier_verdict: string; model_version: string; explanation: string }>(
      pool(),
      `select decision, algorithm_version, compatible, conflicts, verifier_verdict, model_version, explanation from match_decisions where complaint_id = $1`,
      [id],
    );
    expect(decision).toMatchObject({ decision: "auto", algorithm_version: MATCH_ALGORITHM_VERSION, conflicts: [], verifier_verdict: "same" });
    expect(decision!.compatible).toEqual(expect.arrayContaining(["same kind of problem (missing)"]));
    expect(decision!.model_version).toMatch(/local:lexicon-v2\|fake:marker-v1\|local:attribute-rules-v1/);
    expect(decision!.explanation).not.toMatch(/schedule for our examinations/); // provenance holds no complaint text

    const live = await getLiveActivity(pool(), admin);
    expect(live.newComplaints.map((c) => c.id)).toContain(id);
    expect(live.active[0]).toMatchObject({ total_submission_count: 2, distinct_reporter_count: 2 });
    expect(live.counters.auto_24h).toBe(1);
  });

  it("keeps similar keywords describing different problems apart (spec 2)", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const first = await submit(a, "#timetable The FIN 231 exam timetable has not been released.");
    const second = await submit(b, "#timetable The FIN 231 exam timetable contains an incorrect examination date.");
    const c2 = await complaintRow(second);
    expect(c2!.consolidated_issue_id).not.toBe((await complaintRow(first))!.consolidated_issue_id);
    expect(c2!.match_status).not.toBe("auto_matched");
  });

  it("does not create duplicate issues when the same new problem is reported concurrently (spec 7)", async () => {
    const students = await Promise.all([makeStudent(), makeStudent(), makeStudent(), makeStudent()]);
    const ids = await Promise.all(students.map((s, i) => submit(s, `#timetable The exam timetable has not been published yet (${i}).`, { inline: false })));
    await Promise.all(ids.map((id) => processMatchJob(id)));
    const issues = await rows<{ id: string }>(pool(), `select distinct consolidated_issue_id as id from complaints`);
    expect(issues).toHaveLength(1);
    expect(await issueRow(issues[0].id)).toMatchObject({ total_submission_count: 4, distinct_reporter_count: 4 });
  });

  it("raises priority as distinct students report the same problem (spec 11, 12)", async () => {
    const admin = await makeAdmin("union_admin");
    const first = await submit(await makeStudent(), "#timetable Exam timetable has not been published.");
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    const start = (await issueRow(issueId))!.priority;
    const repeater = await makeStudent();
    await submit(repeater, "#timetable Exam timetable still has not been published (again).");
    await submit(repeater, "#timetable Exam timetable has not been published yet, please.");
    for (let i = 0; i < 4; i++) await submit(await makeStudent(), `#timetable The exam timetable has not been published (${i}).`);
    const row = (await issueRow(issueId))!;
    expect(row).toMatchObject({ total_submission_count: 7, distinct_reporter_count: 6 });
    expect(["elevated", "high", "critical"].indexOf(row.priority)).toBeGreaterThan(["elevated", "high", "critical"].indexOf(start));
    const live = await getLiveActivity(pool(), admin);
    expect(live.surging.map((i) => i.id)).toContain(issueId);
    expect(live.priorityUps.map((p) => p.issue_id)).toContain(issueId);
  });
});

describe("sensitive complaints", () => {
  it("are never auto-merged and never published; they go to restricted review (spec 15)", async () => {
    const admin = await makeAdmin("union_admin");
    const welfare = await categoryId("welfare");
    const first = await submit(await makeStudent(), "#harass A staff member keeps harassing female students after tutorials.", { category: welfare });
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    const issue = await one<{ sensitive: boolean; priority: string }>(pool(), `select sensitive, priority from consolidated_issues where id = $1`, [issueId]);
    expect(issue).toMatchObject({ sensitive: true });
    expect(["high", "critical"]).toContain(issue!.priority);

    const second = await submit(await makeStudent(), "#harass The same official keeps harassing students after tutorials.", { category: welfare });
    expect((await complaintRow(second))!.match_status).toBe("pending_review");
    const [review] = await listPendingReviews(pool(), admin);
    expect(review).toMatchObject({ review_reason: "sensitive", issue_sensitive: true });
    expect(await listPublicIssues()).toHaveLength(0);
  });
});

describe("resilience", () => {
  it("keeps the complaint through repeated AI failures, marks it failed, and can be retried (spec 9, 10)", async () => {
    const admin = await makeAdmin("union_admin");
    const s = await makeStudent();
    embedder.failuresRemaining = JOB_POLICY.maxAttempts;
    const id = await submit(s, "#wifi The wifi at the study centre has not worked for a week.", { category: await categoryId("facilities") });
    for (let i = 1; i < JOB_POLICY.maxAttempts; i++) {
      await pool().query(`update match_jobs set next_attempt_at = now() where complaint_id = $1`, [id]);
      await processMatchJob(id);
    }
    expect((await complaintRow(id))!.match_status).toBe("failed");
    expect((await getStudentComplaint(s, id))!.complaint.description).toContain("wifi");
    const live = await getLiveActivity(pool(), admin);
    expect(live.failures.map((f) => f.complaint_id)).toContain(id);

    await retryMatching(admin, id);
    expect(await processMatchJob(id)).toBe("new");
    expect((await complaintRow(id))!.consolidated_issue_id).toBeTruthy();
  });

  it("re-processing a completed job changes nothing (spec 8)", async () => {
    const id = await submit(await makeStudent(), "#timetable Exam timetable has not been published.");
    const issueId = (await complaintRow(id))!.consolidated_issue_id!;
    await pool().query(`update match_jobs set status = 'pending' where complaint_id = $1`, [id]);
    expect(await processMatchJob(id)).toBe("skipped");
    expect(await issueRow(issueId)).toMatchObject({ total_submission_count: 1, distinct_reporter_count: 1 });
  });
});

describe("student feedback", () => {
  it("uses the verified, published deadline from the database (spec 14)", async () => {
    const admin = await makeAdmin("union_admin");
    const a = await makeStudent();
    const b = await makeStudent();
    const first = await submit(a, "#timetable Exam timetable has not been published.");
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    await changeStatus(admin, issueId, "in_progress", null);
    const deadline = new Date(Date.now() + 5 * 86400_000);
    await setDeadline(admin, issueId, deadline, null);

    const second = await submit(b, "#timetable We have not received the examination timetable.");
    const view = await getStudentComplaint(b, second);
    expect(view!.issue!.expected_resolution_at!.getTime()).toBe(deadline.getTime());
    const msg = studentStatusMessage({ matchStatus: view!.complaint.match_status, complaintStatus: view!.complaint.status, issue: view!.issue });
    expect(msg!.text).toMatch(/currently being addressed.*expected resolution date is/);
  });
});
