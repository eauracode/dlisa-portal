import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "@/lib/db";
import { requestComplaintReview, submitComplaint } from "@/lib/services/student-complaints";
import { getStudentInbox, listSentMessages, sendMessage } from "@/lib/services/messages";
import { confirmAnswerResolved, getInstantAnswers, recordAnswerFeedback, setMessageReusable } from "@/lib/services/instant-answers";
import { changeStatus } from "@/lib/services/admin/issues";
import { categoryId, complaintRow, makeAdmin, makeStudent, resetData } from "../support/db";
import { basis, resetAI, useFakeAI } from "../support/fake-ai";

beforeEach(async () => {
  await resetData();
  useFakeAI({ lms: basis(0), fees: basis(1), harass: basis(2) });
});
afterAll(async () => {
  resetAI();
  await closePool();
});

let n = 0;
async function ask(studentId: string, text: string) {
  n += 1;
  const r = await submitComplaint(studentId, { categoryId: await categoryId("materials"), subject: `Question ${n}`, description: `${text} (${n})` }, `ia-${studentId}-${n}`);
  if (!r.ok) throw new Error(r.error);
  return r.complaintId;
}

const LMS_Q = "#lms I cannot log in to the LMS portal, it keeps failing.";

describe("instant answers", () => {
  it("gives a recent memo to a new student who asks the same thing, and not to unrelated questions", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent(); // a memo needs at least one recipient
    const memo = await sendMessage(admin, { type: "all" }, { subject: "LMS restored", body: "#lms The ICT unit has restored the LMS. Clear your cache and log in again." });

    const newcomer = await makeStudent(); // joined after the memo, so never received it
    const asked = await ask(newcomer, LMS_Q);
    const answers = await getInstantAnswers(newcomer, asked);
    expect(answers.map((a) => [a.message_id, a.source, a.audience])).toEqual([[memo.messageId, "similar", "broadcast"]]);
    expect((await getStudentInbox(newcomer)).map((m) => m.subject)).toEqual(["LMS restored"]);

    const other = await ask(newcomer, "#fees The school fees portal charged me twice for the same payment.");
    expect(await getInstantAnswers(newcomer, other)).toEqual([]);
  });

  it("does not reuse a direct reply unless staff chose to", async () => {
    const admin = await makeAdmin("union_admin");
    const first = await makeStudent("first");
    const username = (await pool().query<{ username: string }>(`select username from students where id = $1`, [first])).rows[0].username;
    await sendMessage(admin, { type: "username", username }, { subject: "About your LMS login", body: "#lms Your LMS account was reset; use your matric number." });

    const second = await makeStudent();
    expect(await getInstantAnswers(second, await ask(second, LMS_Q))).toEqual([]);

    const shared = await sendMessage(admin, { type: "username", username }, { subject: "LMS login fix", body: "#lms Clear your cache and log in again.", reusable: true });
    const third = await makeStudent();
    expect((await getInstantAnswers(third, await ask(third, LMS_Q))).map((a) => a.message_id)).toEqual([shared.messageId]);
  });

  it("gives earlier replies to a grouped issue to a student whose report joins that issue", async () => {
    const admin = await makeAdmin("union_admin");
    const a = await makeStudent();
    const issueId = (await complaintRow(await ask(a, LMS_Q)))!.consolidated_issue_id!;
    const reply = await sendMessage(admin, { type: "issue", issueId }, { subject: "Working on the LMS", body: "The ICT unit expects the LMS back by Friday." });

    const b = await makeStudent();
    const joined = await ask(b, LMS_Q);
    expect((await complaintRow(joined))!.consolidated_issue_id).toBe(issueId);
    const answers = await getInstantAnswers(b, joined);
    expect(answers.map((x) => [x.message_id, x.source])).toEqual([[reply.messageId, "same_issue"]]);
  });

  it("respects staff switching reuse off, the memo time window, and course codes", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const memo = await sendMessage(admin, { type: "all" }, { subject: "LMS restored", body: "#lms The LMS is back." });
    await setMessageReusable(admin, memo.messageId, false);
    const s = await makeStudent();
    expect(await getInstantAnswers(s, await ask(s, LMS_Q))).toEqual([]);

    await setMessageReusable(admin, memo.messageId, true);
    await pool().query(`update student_messages set created_at = now() - interval '100 days' where id = $1`, [memo.messageId]);
    expect(await getInstantAnswers(s, await ask(s, `${LMS_Q} Still broken.`))).toEqual([]);

    await sendMessage(admin, { type: "all" }, { subject: "Recordings uploaded", body: "#lms Recordings for ACC 301 are on the LMS." });
    expect(await getInstantAnswers(s, await ask(s, "#lms Where are the recordings for FIN 305 on the LMS?"))).toEqual([]);
  });

  it("never sends canned answers to sensitive submissions", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    await sendMessage(admin, { type: "all" }, { subject: "Reporting harassment", body: "#harass Contact the welfare office for support." });
    const s = await makeStudent();
    const id = await ask(s, "#harass A lecturer has been sexually harassing me and threatening my grades.");
    expect(await getInstantAnswers(s, id)).toEqual([]);
  });

  it("lets only the owner give feedback, and shows reuse counts to staff", async () => {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const memo = await sendMessage(admin, { type: "all" }, { subject: "LMS restored", body: "#lms The LMS is back." });
    const owner = await makeStudent();
    const intruder = await makeStudent();
    const id = await ask(owner, LMS_Q);

    expect(await getInstantAnswers(intruder, id)).toEqual([]);
    expect(await recordAnswerFeedback(intruder, id, memo.messageId, false)).toBe(false);
    expect(await recordAnswerFeedback(owner, id, memo.messageId, true)).toBe(true);
    expect((await getInstantAnswers(owner, id))[0].helpful).toBe(true);

    const sent = (await listSentMessages(pool(), admin)).find((m) => m.id === memo.messageId)!;
    expect([sent.reused_count, sent.helpful_count]).toEqual([1, 1]);
  });
});

describe("confirming an instant answer", () => {
  async function setup() {
    const admin = await makeAdmin("union_admin");
    await makeStudent();
    const memo = await sendMessage(admin, { type: "all" }, { subject: "LMS restored", body: "#lms The LMS is back." });
    return { admin, memo };
  }
  const issueOf = async (id: string) => (await complaintRow(id))!.consolidated_issue_id!;
  const issueStatus = async (issueId: string) => (await pool().query<{ status: string }>(`select status from consolidated_issues where id = $1`, [issueId])).rows[0].status;

  it("resolves the submission, and its issue when nobody else is waiting", async () => {
    const { memo } = await setup();
    const s = await makeStudent();
    const id = await ask(s, LMS_Q);
    expect(await confirmAnswerResolved(s, id, memo.messageId)).toBe(true);
    expect((await complaintRow(id))!.status).toBe("resolved");
    expect(await issueStatus(await issueOf(id))).toBe("resolved");
  });

  it("keeps the issue open while other reporters still need help", async () => {
    const { memo } = await setup();
    const [a, b] = [await makeStudent(), await makeStudent()];
    const first = await ask(a, LMS_Q);
    const second = await ask(b, LMS_Q);
    const issueId = await issueOf(first);
    expect(await issueOf(second)).toBe(issueId);

    await confirmAnswerResolved(a, first, memo.messageId);
    expect((await complaintRow(first))!.status).toBe("resolved");
    expect((await complaintRow(second))!.status).not.toBe("resolved");
    expect(await issueStatus(issueId)).not.toBe("resolved");

    await confirmAnswerResolved(b, second, memo.messageId);
    expect(await issueStatus(issueId)).toBe("resolved");
  });

  it("is not undone by later staff status changes, but a review request hands it back to staff", async () => {
    const { admin, memo } = await setup();
    const [a, b] = [await makeStudent(), await makeStudent()];
    const mine = await ask(a, LMS_Q);
    await ask(b, LMS_Q);
    const issueId = await issueOf(mine);
    await confirmAnswerResolved(a, mine, memo.messageId);

    await changeStatus(admin, issueId, "in_progress", null);
    expect((await complaintRow(mine))!.status).toBe("resolved");

    expect((await requestComplaintReview(a, mine, "It is broken again since this morning.")).ok).toBe(true);
    expect((await complaintRow(mine))!.status).toBe("review_requested");
    expect((await pool().query(`select resolved_by_student_at from complaints where id = $1`, [mine])).rows[0].resolved_by_student_at).toBeNull();
  });

  it("does nothing for someone else's submission, or when the answer did not help", async () => {
    const { memo } = await setup();
    const [owner, intruder] = [await makeStudent(), await makeStudent()];
    const id = await ask(owner, LMS_Q);
    expect(await confirmAnswerResolved(intruder, id, memo.messageId)).toBe(false);
    expect((await complaintRow(id))!.status).not.toBe("resolved");
    await recordAnswerFeedback(owner, id, memo.messageId, false);
    expect((await complaintRow(id))!.status).not.toBe("resolved");
  });
});

describe("frequently asked questions", () => {
  it("answer a student instantly, never expire, and stop when switched off", async () => {
    const { createFaq, listFaqs, setFaqActive } = await import("@/lib/services/faqs");
    const admin = await makeAdmin("case_officer");
    const faqId = await createFaq(admin, { question: "#fees Why was I charged twice for school fees?", answer: "#fees Double charges are refunded by the bursary within 5 working days." });
    // An FAQ written long ago is still offered.
    await pool().query(`update student_messages set created_at = now() - interval '2 years' where id = $1`, [faqId]);

    const s = await makeStudent();
    const asked = await ask(s, "#fees The fees portal took my money two times.");
    expect((await getInstantAnswers(s, asked)).map((a) => [a.message_id, a.audience])).toEqual([[faqId, "faq"]]);
    expect((await listFaqs(pool(), admin))[0]).toMatchObject({ id: faqId, active: true, used: 1 });
    // FAQs are a library, not a sent message.
    expect((await listSentMessages(pool(), await makeAdmin("union_admin"))).some((m) => m.id === faqId)).toBe(false);

    await setFaqActive(admin, faqId, false);
    const later = await makeStudent();
    expect(await getInstantAnswers(later, await ask(later, "#fees I was debited twice for fees."))).toEqual([]);
  });

  it("are offered to staff as saved responses, closest to the student's question first", async () => {
    const { createFaq, listSavedResponses } = await import("@/lib/services/faqs");
    const admin = await makeAdmin("union_admin");
    await createFaq(admin, { question: "#lms How do I reset my LMS password?", answer: "#lms Use 'Forgot password' on the LMS login page." });
    const fees = await createFaq(admin, { question: "#fees When is the school fees deadline?", answer: "#fees Fees close on 30 November." });
    // Embed the library (normally done right after saving).
    const { ensureAnswerEmbeddings } = await import("@/lib/services/instant-answers");
    await ensureAnswerEmbeddings(pool());
    const student = await makeStudent();
    const c = await ask(student, "#fees Is there an extension to the fees deadline for final-year students?");
    const saved = await listSavedResponses(pool(), c);
    expect(saved[0]).toMatchObject({ id: fees, kind: "faq" });
    expect(saved[0].match).toBeGreaterThan(0.9);
    expect(saved).toHaveLength(2);
  });
});
