import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool, rows } from "@/lib/db";
import { processMatchJob } from "@/lib/matching/jobs";
import { runMaintenance } from "@/lib/matching/maintenance";
import { getStudentComplaint, submitComplaint } from "@/lib/services/student-complaints";
import { decideReview, listPendingReviews, reassignComplaint } from "@/lib/services/admin/complaints";
import { categoryId, complaintRow, issueRow, makeAdmin, makeStudent, resetData } from "../support/db";
import { basis, resetAI, useFakeAI, vectorWithSimilarity, type MarkerEmbedder } from "../support/fake-ai";
import { COPY } from "@/config/app";

let embedder: MarkerEmbedder;
let examCat: number;

beforeEach(async () => {
  await resetData();
  embedder = useFakeAI({
    lms: basis(0),
    lmsdup: basis(0),
    lmsmaybe: vectorWithSimilarity(0.36, 1),
    unrelated: basis(5),
  });
  examCat = await categoryId("materials");
});
afterAll(async () => {
  resetAI();
  await closePool();
});

const submit = (studentId: string, marker: string, extra = "") =>
  submitComplaint(
    studentId,
    { categoryId: examCat, subject: `LMS portal not loading ${extra}`.trim(), description: `#${marker} The LMS portal does not load course materials for my courses. ${extra}` },
    `client-${studentId}`,
  );

async function expectOk(p: ReturnType<typeof submit>) {
  const r = await p;
  if (!r.ok) throw new Error(`submit failed: ${r.error}`);
  return r.complaintId;
}

describe("complaint submission and consolidation", () => {
  it("stores a new complaint, acknowledges it and creates an issue for a new problem (scenarios 5, 8, 20)", async () => {
    const s = await makeStudent();
    const id = await expectOk(submit(s, "lms"));
    const c = await complaintRow(id);
    expect(c!.match_status).toBe("new_issue");
    expect(c!.consolidated_issue_id).toBeTruthy();
    const detail = await getStudentComplaint(s, id);
    expect(detail!.events[0].message).toBe(COPY.acknowledgement);
  });

  it("groups a high-confidence duplicate with the correct issue (scenario 6)", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const first = await expectOk(submit(a, "lms"));
    await expectOk(submit(b, "unrelated", "unrelated")); // a different issue exists too
    const second = await expectOk(submit(b, "lmsdup", "again"));
    const c1 = await complaintRow(first);
    const c2 = await complaintRow(second);
    expect(c2!.match_status).toBe("auto_matched");
    expect(c2!.consolidated_issue_id).toBe(c1!.consolidated_issue_id);
    const sub = await one<{ match_method: string; model_version: string }>(pool(), `select match_method, model_version from issue_submissions where complaint_id = $1`, [second]);
    expect(sub).toMatchObject({ match_method: "auto" });
    expect(sub!.model_version).toContain("marker-v1");
    const detail = await getStudentComplaint(b, second);
    expect(detail!.events.some((e) => e.message === COPY.matchedExisting)).toBe(true);
  });

  it("sends an uncertain match to the review queue and lets an admin confirm it (scenario 7)", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const admin = await makeAdmin("union_admin");
    const first = await expectOk(submit(a, "lms"));
    const second = await expectOk(submit(b, "lmsmaybe", "maybe"));
    expect((await complaintRow(second))!.match_status).toBe("pending_review");
    expect((await complaintRow(second))!.consolidated_issue_id).toBeNull();

    const queue = await listPendingReviews(pool(), admin);
    expect(queue).toHaveLength(1);
    expect(queue[0].confidence_score).toBeGreaterThanOrEqual(0.45);
    expect(queue[0].confidence_score).toBeLessThan(0.6);
    expect(queue[0].explanation).toMatch(/Similarity \d/);

    await decideReview(admin, queue[0].id, { action: "confirm" }, "Same LMS outage");
    expect((await complaintRow(second))!.consolidated_issue_id).toBe((await complaintRow(first))!.consolidated_issue_id);
  });

  it("rejecting a suggested match creates a separate issue", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const admin = await makeAdmin("union_admin");
    const first = await expectOk(submit(a, "lms"));
    const second = await expectOk(submit(b, "lmsmaybe", "maybe"));
    const [review] = await listPendingReviews(pool(), admin);
    await decideReview(admin, review.id, { action: "reject" }, "Different problem");
    const c2 = await complaintRow(second);
    expect(c2!.consolidated_issue_id).toBeTruthy();
    expect(c2!.consolidated_issue_id).not.toBe((await complaintRow(first))!.consolidated_issue_id);
  });

  it("does not inflate distinct reporters for repeat submissions from one username (scenarios 9, 10)", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const c = await makeStudent();
    const first = await expectOk(submit(a, "lms"));
    await expectOk(submit(a, "lmsdup", "still broken today"));
    await expectOk(submit(a, "lmsdup", "still broken this week"));
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    expect(await issueRow(issueId)).toMatchObject({ total_submission_count: 3, distinct_reporter_count: 1 });

    await expectOk(submit(b, "lmsdup", "for me too"));
    await expectOk(submit(c, "lmsdup", "same here"));
    expect(await issueRow(issueId)).toMatchObject({ total_submission_count: 5, distinct_reporter_count: 3 });
  });

  it("rejects repeated identical submissions and rate-limits spam (scenario 19)", async () => {
    const a = await makeStudent();
    await expectOk(submit(a, "lms"));
    const dup = await submit(a, "lms");
    expect(dup).toMatchObject({ ok: false, error: "duplicate" });

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await submit(a, "unrelated", `variation ${i}`));
    expect(results.some((r) => !r.ok && r.error === "rate_limited")).toBe(true);
  });

  it("never loses a complaint when the AI provider fails, and retries later (scenario 15)", async () => {
    const a = await makeStudent();
    embedder.failuresRemaining = 1;
    const id = await expectOk(submit(a, "lms"));
    const c = await complaintRow(id);
    expect(c!.match_status).toBe("pending");
    expect(c!.consolidated_issue_id).toBeNull();
    const job = await one<{ status: string; attempts: number; last_error: string }>(pool(), `select status, attempts, last_error from match_jobs where complaint_id = $1`, [id]);
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job!.last_error).not.toContain("LMS"); // no complaint content in logs
    // The student still sees their complaint and the acknowledgement.
    const detail = await getStudentComplaint(a, id);
    expect(detail!.complaint.subject).toContain("LMS");

    // Not yet due (back-off) -> maintenance skips; make it due and retry.
    await pool().query(`update match_jobs set next_attempt_at = now() where complaint_id = $1`, [id]);
    await runMaintenance();
    expect((await complaintRow(id))!.match_status).toBe("new_issue");
  });

  it("prevents duplicate processing of the same job", async () => {
    const a = await makeStudent();
    embedder.failuresRemaining = 1;
    const id = await expectOk(submit(a, "lms"));
    await pool().query(`update match_jobs set next_attempt_at = now() where complaint_id = $1`, [id]);
    const outcomes = await Promise.all([processMatchJob(id), processMatchJob(id), processMatchJob(id)]);
    expect(outcomes.filter((o) => o === "new")).toHaveLength(1);
    const links = await rows(pool(), `select 1 from issue_submissions where complaint_id = $1`, [id]);
    expect(links).toHaveLength(1);
    const issues = await rows(pool(), `select 1 from consolidated_issues`);
    expect(issues).toHaveLength(1);
  });

  it("re-creates a missing job so no complaint is left unprocessed", async () => {
    const a = await makeStudent();
    const id = await expectOk(submitComplaint(a, { categoryId: examCat, subject: "Queued later", description: "#lms Complaint stored but job row lost." }, "c", { matchInline: false }));
    await pool().query(`delete from match_jobs where complaint_id = $1`, [id]);
    const result = await runMaintenance();
    expect(result.requeued).toBe(1);
    expect((await complaintRow(id))!.consolidated_issue_id).toBeTruthy();
  });

  it("lets an administrator correct an incorrect match without deleting anything (scenario 16)", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const admin = await makeAdmin("union_admin");
    const first = await expectOk(submit(a, "lms"));
    const wrong = await expectOk(submit(b, "lmsdup", "but really about fees"));
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    expect((await complaintRow(wrong))!.consolidated_issue_id).toBe(issueId);

    const newIssue = await reassignComplaint(admin, wrong, "new", "This is about fee payment, not the LMS");
    expect((await complaintRow(wrong))!.consolidated_issue_id).toBe(newIssue);
    expect(await issueRow(issueId)).toMatchObject({ total_submission_count: 1, distinct_reporter_count: 1 });
    const history = await rows<{ unlinked_at: Date | null }>(pool(), `select unlinked_at from issue_submissions where complaint_id = $1 order by matched_at`, [wrong]);
    expect(history).toHaveLength(2);
    expect(history[0].unlinked_at).not.toBeNull();
    // The original submission text is unchanged and still visible to its author.
    expect((await getStudentComplaint(b, wrong))!.complaint.description).toContain("really about fees");
  });

  it("does not auto-group complaints about different courses", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    const cat = await categoryId("exams-results");
    const r1 = await submitComplaint(a, { categoryId: cat, subject: "ACC 201 result missing", description: "#lms My ACC 201 result is missing from the portal." }, "x");
    const r2 = await submitComplaint(b, { categoryId: cat, subject: "BUS 105 result missing", description: "#lmsdup My BUS 105 result is missing from the portal." }, "y");
    if (!r1.ok || !r2.ok) throw new Error();
    expect((await complaintRow(r2.complaintId))!.match_status).toBe("pending_review");
  });
});
