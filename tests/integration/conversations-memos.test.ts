import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, pool } from "@/lib/db";
import { getStudentComplaint, listMyComplaints, requestComplaintReview, submitComplaint } from "@/lib/services/student-complaints";
import { assignOfficer, changeStatus, mergeIssues, setPublicVisibility } from "@/lib/services/admin/issues";
import { getStudentMessagesOverview, getUnreadMessageCount, sendMessage } from "@/lib/services/messages";
import { countUnreadForStaff, getStaffConversation, listConversations, sendStaffReply, sendStudentReply } from "@/lib/services/conversations";
import { buildStudentThread, loadStudentThread } from "@/lib/services/student-thread";
import { archiveMemo, countUnreadMemos, createMemo, getMemoFeed, listMemosForStaff, mergeMemoFeed, publishDraft, type MemoCard } from "@/lib/services/memos";
import { getInstantAnswers, recordAnswerFeedback } from "@/lib/services/instant-answers";
import { ForbiddenError } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/services/admin/context";
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

let n = 0;
async function report(studentId: string, text = "#lms The LMS portal is not loading at all.") {
  n += 1;
  const r = await submitComplaint(studentId, { categoryId: await categoryId("materials"), subject: `Report ${n}`, description: `${text} (${n})` }, `cm-${studentId}-${n}`);
  if (!r.ok) throw new Error(r.error);
  return r.complaintId;
}

async function auditCount(action: string) {
  return (await one<{ n: number }>(pool(), `select count(*)::int as n from audit_logs where action = $1`, [action]))!.n;
}

describe("the student conversation", () => {
  const base = {
    complaint: { createdAt: new Date("2026-10-01T09:00:00Z"), description: "x", matchStatus: "auto_matched" },
    publishedUpdates: [],
    statusHistory: [],
    dateHistory: [],
    messages: [],
    answers: [],
    reviewRequests: [],
    reviewResponses: [],
  };

  it("says other students reported it only while the issue is unresolved", () => {
    const at = new Date("2026-10-01T09:01:00Z");
    const open = buildStudentThread({ ...base, issue: { status: "in_progress", groupedAt: at } });
    expect(open.some((e) => e.type === "grouped")).toBe(true);
    for (const status of ["resolved", "closed", "merged"]) {
      expect(buildStudentThread({ ...base, issue: { status, groupedAt: at } }).some((e) => e.type === "grouped")).toBe(false);
    }
    // A submission that started its own issue was not "added to" anything.
    expect(buildStudentThread({ ...base, complaint: { ...base.complaint, matchStatus: "new_issue" }, issue: { status: "new", groupedAt: at } }).some((e) => e.type === "grouped")).toBe(false);
  });

  it("lets a student write only in their own complaint's chat", async () => {
    const [owner, other] = [await makeStudent(), await makeStudent()];
    const id = await report(owner);
    expect(await sendStudentReply(owner, id, "Any news on this?")).toEqual({ ok: true });
    expect(await sendStudentReply(other, id, "Hijack")).toEqual({ ok: false, error: "not_found" });
    expect(await auditCount("complaint.message_sent")).toBe(1);
  });

  it("delivers staff replies to that student only, and tracks reads both ways", async () => {
    const admin = await makeAdmin("union_admin");
    const [owner, bystander] = [await makeStudent(), await makeStudent()];
    const id = await report(owner);
    await report(bystander); // same issue
    await sendStudentReply(owner, id, "Is anyone looking at this?");
    expect(await countUnreadForStaff(pool(), admin)).toBe(1);

    const convo = await getStaffConversation(admin, id);
    const username = (await one<{ username: string }>(pool(), `select username from students where id = $1`, [owner]))!.username;
    expect(convo.reporter).toBe(`@${username}`); // Association staff see the username
    expect(await countUnreadForStaff(pool(), admin)).toBe(0);

    await sendStaffReply(admin, id, "Yes, the ICT unit is on it.");
    expect(await getUnreadMessageCount(owner)).toBeGreaterThanOrEqual(1);
    expect(await getUnreadMessageCount(bystander)).toBe(0);

    const detail = (await getStudentComplaint(owner, id))!;
    const thread = await loadStudentThread(owner, detail.complaint, detail.issue);
    expect(thread.filter((e) => e.type === "message").map((e) => (e as { body: string }).body)).toEqual(["Is anyone looking at this?", "Yes, the ICT unit is on it."]);
    expect(await getUnreadMessageCount(owner)).toBe(0); // reading the thread reads it
    expect(await auditCount("complaint.staff_reply")).toBe(1);
  });

  it("allows staff replies only from roles and issues the staff member may handle", async () => {
    const [admin, officer, oversight] = [await makeAdmin("union_admin"), await makeAdmin("case_officer"), await makeAdmin("oversight_officer")];
    const id = await report(await makeStudent());
    await expect(sendStaffReply(oversight, id, "Hello")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendStaffReply(officer, id, "Hello")).rejects.toBeInstanceOf(NotFoundError); // not assigned
    await assignOfficer(admin, (await complaintRow(id))!.consolidated_issue_id!, officer.id);
    await sendStaffReply(officer, id, "Hello from your case officer.");
    expect((await listConversations(pool(), officer)).map((c) => c.complaint_id)).toEqual([id]);
  });

  it("puts a review request's reason into the conversation for staff", async () => {
    const admin = await makeAdmin("union_admin");
    const s = await makeStudent();
    const id = await report(s);
    await changeStatus(admin, (await complaintRow(id))!.consolidated_issue_id!, "resolved", "The LMS was restored.");
    expect((await requestComplaintReview(s, id, "It broke again this morning.")).ok).toBe(true);
    const convo = await getStaffConversation(admin, id);
    expect(convo.messages.map((m) => [m.body, m.is_review_request])).toEqual([["It broke again this morning.", true]]);
  });
});

describe("memos", () => {
  it("only Association Admins publish; Case Officers save drafts that students never see", async () => {
    const [admin, officer] = [await makeAdmin("union_admin"), await makeAdmin("case_officer")];
    const early = await makeStudent();
    await expect(createMemo(officer, { title: "Exam week", body: "#lms Exams start Monday.", pinned: false, public: false, publish: true })).rejects.toBeInstanceOf(ForbiddenError);
    const draft = await createMemo(officer, { title: "Exam week", body: "#lms Exams start Monday.", pinned: false, public: false, publish: false });
    expect(await getMemoFeed(early, "notice")).toEqual([]);
    // A draft is never used as an instant answer.
    const asker = await makeStudent();
    expect(await getInstantAnswers(asker, await report(asker))).toEqual([]);

    await expect(publishDraft(officer, draft)).rejects.toBeInstanceOf(ForbiddenError);
    await publishDraft(admin, draft);
    expect((await getMemoFeed(early, "notice")).map((c) => c.id)).toEqual([draft]);
    expect(await auditCount("memo.published")).toBe(1);
  });

  it("shows published memos to students who joined later, with New until opened", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const id = await createMemo(admin, { title: "Library hours", body: "The study centre opens at 8am.", pinned: true, public: false, publish: true });
    const late = await makeStudent();
    expect(await countUnreadMemos(late)).toBe(1);
    const first = await getMemoFeed(late, "all");
    expect(first[0]).toMatchObject({ kind: "notice", id, pinned: true, isNew: true });
    expect(await countUnreadMemos(late)).toBe(0);
    expect((await getMemoFeed(late, "all"))[0]).toMatchObject({ isNew: false });
    expect((await listMemosForStaff(pool(), admin))[0].seen).toBe(1);
  });

  it("shows signed-out visitors only public memos, and archived memos to nobody", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const priv = await createMemo(admin, { title: "Students only", body: "For students only.", pinned: false, public: false, publish: true });
    const pub = await createMemo(admin, { title: "Open notice", body: "For everyone to see.", pinned: false, public: true, publish: true });
    expect((await getMemoFeed(null, "notice")).map((c) => c.id)).toEqual([pub]);
    await archiveMemo(admin, pub);
    expect(await getMemoFeed(null, "notice")).toEqual([]);
    const s = await makeStudent();
    expect((await getMemoFeed(s, "notice")).map((c) => c.id)).toEqual([priv]);
  });

  it("lists only unresolved public issues, never sensitive ones, and never any counts", async () => {
    const admin = await makeAdmin("union_admin");
    const issueId = (await complaintRow(await report(await makeStudent())))!.consolidated_issue_id!;
    await report(await makeStudent());
    await setPublicVisibility(admin, issueId, { visible: true, publicTitle: "LMS access problems", publicSummary: "Students cannot reach the LMS." });
    const s = await makeStudent();
    const cards = await getMemoFeed(s, "issue");
    expect(cards.map((c) => c.id)).toEqual([issueId]);
    for (const key of Object.keys(cards[0])) expect(key).not.toMatch(/count|reporter|submission|students/i);
    await changeStatus(admin, issueId, "resolved", "Restored.");
    expect(await getMemoFeed(s, "issue")).toEqual([]);
    await pool().query(`update consolidated_issues set status = 'in_progress', sensitive = true where id = $1`, [issueId]);
    expect(await getMemoFeed(s, "issue")).toEqual([]);
  });

  it("puts pinned notices first, then newest first", () => {
    const notice = (id: string, pinned: boolean, at: string): MemoCard => ({ kind: "notice", id, title: id, body: "", pinned, publishedAt: new Date(at), isNew: false });
    const issue: MemoCard = { kind: "issue", id: "i", title: "i", summary: "", category: "", status: "new", latest: null, expectedAt: null, updatedAt: new Date("2026-10-03") };
    const feed = mergeMemoFeed([notice("old-pin", true, "2026-09-01"), notice("new", false, "2026-10-02")], [issue], "all");
    expect(feed.map((c) => c.id)).toEqual(["old-pin", "i", "new"]);
    expect(mergeMemoFeed([notice("a", false, "2026-10-01")], [issue], "issue").map((c) => c.id)).toEqual(["i"]);
  });
});

describe("bulk messages", () => {
  it("reach a department, or students with an open complaint, and land in Messages", async () => {
    const admin = await makeAdmin("union_admin");
    const fin = (await registerStudent({ username: `fin${Date.now() % 100000}`, department: "FIN" })) as { ok: true; studentId: string };
    const acc = (await registerStudent({ username: `acc${Date.now() % 100000}`, department: "ACC" })) as { ok: true; studentId: string };
    const res = await sendMessage(admin, { type: "department", department: "FIN" }, { subject: "Finance students", body: "A note for Finance students." });
    expect(res.recipients).toBe(1);
    expect((await getStudentMessagesOverview(fin.studentId)).general.map((m) => m.subject)).toEqual(["Finance students"]);
    expect((await getStudentMessagesOverview(acc.studentId)).general).toEqual([]);

    await report(acc.studentId);
    const open = await sendMessage(admin, { type: "open_complaints" }, { subject: "Open cases", body: "We are working through open cases." });
    expect(open.recipients).toBe(1);
    const officer = await makeAdmin("case_officer");
    await expect(sendMessage(officer, { type: "department", department: "FIN" }, { subject: "Nope", body: "Not allowed." })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never sends counts to the student complaint list", async () => {
    const s = await makeStudent();
    await report(s);
    await report(await makeStudent());
    const [row] = await listMyComplaints(s);
    for (const key of Object.keys(row)) expect(key).not.toMatch(/count|reporter/i);
  });
});

describe("merging issues and not-helpful answers", () => {
  it("gives merged-in reporters every earlier reply to the surviving issue, once, with feedback", async () => {
    const admin = await makeAdmin("union_admin");
    const [a, b] = [await makeStudent(), await makeStudent()];
    const kept = await report(a); // #lms issue
    const moved = await report(b, "#fees The fees portal charged me twice for one payment.");
    const [keptIssue, movedIssue] = [(await complaintRow(kept))!.consolidated_issue_id!, (await complaintRow(moved))!.consolidated_issue_id!];
    expect(keptIssue).not.toBe(movedIssue);

    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) ids.push((await sendMessage(admin, { type: "issue", issueId: keptIssue }, { subject: `Update ${i}`, body: `Progress note number ${i}.`, reusable: i !== 2 })).messageId);
    const ownReply = await sendMessage(admin, { type: "issue", issueId: movedIssue }, { subject: "About your fees", body: "We are checking the double charge." });

    await mergeIssues(admin, movedIssue, keptIssue, "Same underlying problem");
    const answers = await getInstantAnswers(b, moved);
    // All four (including the one not marked for reuse), none of their own earlier replies.
    expect(answers.map((x) => x.message_id).sort()).toEqual([...ids].sort());
    expect(answers.every((x) => x.source === "same_issue" && x.helpful === null)).toBe(true);
    expect(answers.some((x) => x.message_id === ownReply.messageId)).toBe(false);
  });

  it("flags a not-helpful answer for a personal reply until staff respond", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const memo = await sendMessage(admin, { type: "all" }, { subject: "LMS restored", body: "#lms The LMS is back." });
    const s = await makeStudent();
    const id = await report(s);
    expect((await listConversations(pool(), admin)).find((c) => c.complaint_id === id)).toBeUndefined();

    await recordAnswerFeedback(s, id, memo.messageId, false);
    const row = (await listConversations(pool(), admin)).find((c) => c.complaint_id === id)!;
    expect(row.needs_personal_reply).toBe(true);
    expect(await countUnreadForStaff(pool(), admin)).toBe(1);
    expect((await getStaffConversation(admin, id)).needs_personal_reply).toBe(true);

    await sendStudentReply(s, id, "It still does not load for me.");
    expect(await countUnreadForStaff(pool(), admin)).toBe(1); // counted once, not twice

    await sendStaffReply(admin, id, "Sorry about that. We have reset your LMS access; please try again.");
    expect((await listConversations(pool(), admin)).find((c) => c.complaint_id === id)!.needs_personal_reply).toBe(false);
    expect(await countUnreadForStaff(pool(), admin)).toBe(0);
  });
});

describe("how a submission's status moves", () => {
  it("goes Received → In progress on a staff reply, and Resolved on Reply & resolve; the issue follows once all are resolved", async () => {
    const admin = await makeAdmin("union_admin");
    const [a, b] = [await makeStudent(), await makeStudent()];
    const first = await report(a);
    const second = await report(b); // grouped onto the same issue
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    expect((await complaintRow(second))!.consolidated_issue_id).toBe(issueId);
    expect((await complaintRow(first))!.status).toBe("received");

    await sendStaffReply(admin, first, "We are looking into the LMS problem now.");
    expect((await complaintRow(first))!.status).toBe("in_progress");
    expect((await one<{ status: string }>(pool(), `select status from consolidated_issues where id = $1`, [issueId]))!.status).toBe("in_progress");

    await sendStaffReply(admin, first, "Fixed: please log in again.", { resolve: true });
    expect((await complaintRow(first))!.status).toBe("resolved");
    // Student B is still waiting, so the issue stays open.
    expect((await one<{ status: string }>(pool(), `select status from consolidated_issues where id = $1`, [issueId]))!.status).toBe("in_progress");

    await sendStaffReply(admin, second, "Fixed for you too.", { resolve: true });
    expect((await complaintRow(second))!.status).toBe("resolved");
    expect((await complaintRow(first))!.status).toBe("resolved");
    expect((await one<{ status: string }>(pool(), `select status from consolidated_issues where id = $1`, [issueId]))!.status).toBe("resolved");
  });

  it("moves the whole issue with a message to all reporters, or resolves it with Send & resolve", async () => {
    const admin = await makeAdmin("union_admin");
    const ids = [await report(await makeStudent()), await report(await makeStudent())];
    const issueId = (await complaintRow(ids[0]))!.consolidated_issue_id!;
    await sendMessage(admin, { type: "issue", issueId }, { subject: "LMS outage", body: "ICT is restoring the LMS today." });
    for (const id of ids) expect((await complaintRow(id))!.status).toBe("in_progress");
    await sendMessage(admin, { type: "issue", issueId }, { subject: "LMS restored", body: "The LMS is working again.", resolve: true });
    for (const id of ids) expect((await complaintRow(id))!.status).toBe("resolved");
  });

  it("gives a newly grouped student every reply already sent to the issue, instantly", async () => {
    const admin = await makeAdmin("union_admin");
    const first = await report(await makeStudent());
    const issueId = (await complaintRow(first))!.consolidated_issue_id!;
    for (let i = 1; i <= 4; i++) await sendMessage(admin, { type: "issue", issueId }, { subject: `Update ${i}`, body: `Progress note number ${i}.`, reusable: i !== 2 });
    const late = await makeStudent();
    const id = await report(late);
    expect((await complaintRow(id))!.consolidated_issue_id).toBe(issueId);
    expect(await getInstantAnswers(late, id)).toHaveLength(4);
  });

  it("summarises messages on the Overview and lists who is waiting", async () => {
    const { getOverview } = await import("@/lib/services/admin/overview");
    const admin = await makeAdmin("union_admin");
    const s = await makeStudent();
    const waiting = await report(s, "#fees My fees receipt is missing.");
    let o = await getOverview(pool(), admin, {});
    expect(o.messages).toMatchObject({ submissions: 1, needs_reply: 1, not_answered: 1 });
    const username = (await one<{ username: string }>(pool(), `select username from students where id = $1`, [s]))!.username;
    expect(o.attention[0]).toMatchObject({ complaint_id: waiting, reporter: `@${username}`, reason: "not_answered" });
    await sendStaffReply(admin, waiting, "The bursary has re-issued it.", { resolve: true });
    o = await getOverview(pool(), admin, {});
    expect(o.messages).toMatchObject({ needs_reply: 0, resolved: 1, staff_replies: 1 });
    expect(o.attention).toHaveLength(0);
  });
});
