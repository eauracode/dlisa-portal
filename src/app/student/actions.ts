"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { processMatchJob } from "@/lib/matching/jobs";
import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { findActiveStudent, isUsernameAvailable, registerStudent, setStudentDepartment, signInStudent } from "@/lib/auth/student-auth";
import { departmentField } from "@/lib/department-validation";
import { endStudentSession, getClientKey, getCurrentStudent, startStudentSession } from "@/lib/auth/current";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";
import { complaintSchema, fieldErrors, loginSchema, registerSchema, reviewRequestSchema, usernameSchema, uuidSchema } from "@/lib/validation";
import { getStudentComplaint, requestComplaintReview, submitComplaint } from "@/lib/services/student-complaints";
import { studentStatusMessage } from "@/lib/services/student-messages";
import { issueIsUnresolved } from "@/lib/services/student-thread";
import { COPY } from "@/config/app";
import { confirmAnswerResolved, getInstantAnswers, recordAnswerFeedback } from "@/lib/services/instant-answers";
import { sendStudentReply } from "@/lib/services/conversations";
import { requireStudent } from "@/lib/auth/current";

export interface FormState {
  error?: string;
  success?: string;
  info?: string;
  /** A returning or signed-in student has no department yet: show the one-time step. */
  needsDepartment?: boolean;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};

const TAKEN_MESSAGE = "This username has already been picked. Please choose another one.";
const NOT_FOUND_MESSAGE = "We could not find that username. Check the spelling, or choose “New here” to pick one.";

/** Only allow same-site relative redirects after sign-in. */
function safeNext(next: string): string | null {
  return /^\/student\/[A-Za-z0-9/_-]*$/.test(next) ? next : null;
}

// ---------------------------------------------------------------------------
// Username availability (live check while typing)
// ---------------------------------------------------------------------------

export type UsernameCheck = { status: "available" | "taken" | "invalid"; message: string };

export async function checkUsernameAction(username: string): Promise<UsernameCheck> {
  const parsed = usernameSchema.safeParse(String(username ?? ""));
  if (!parsed.success) return { status: "invalid", message: parsed.error.issues[0].message };
  const limit = await consumeRateLimit(pool(), RATE_LIMITS.usernameCheckByClient, await getClientKey());
  if (!limit.allowed) return { status: "invalid", message: "Too many checks. Please wait a moment." };
  return (await isUsernameAvailable(pool(), parsed.data))
    ? { status: "available", message: "Great — this username is available." }
    : { status: "taken", message: TAKEN_MESSAGE };
}

// ---------------------------------------------------------------------------
// Identity (shared by the access page and the complaint form)
// ---------------------------------------------------------------------------

type IdentityResult = { ok: true; studentId: string } | { ok: false; state: FormState };

const DEPARTMENT_STEP = "One more step: choose your department. You only need to do this once.";

/**
 * New students choose a username and a department. Returning students give their username;
 * if they signed up before departments existed, they are asked for it once (the form shows
 * the department field and the same submission continues).
 */
async function establishIdentity(mode: string, fd: FormData, values: Record<string, string>): Promise<IdentityResult> {
  const clientKey = await getClientKey();
  const rawUsername = str(fd, "username");
  if (mode === "new") {
    const parsed = registerSchema.safeParse({ username: rawUsername, department: str(fd, "department") });
    if (!parsed.success) return { ok: false, state: { fieldErrors: fieldErrors(parsed.error), values } };
    const limit = await consumeRateLimit(pool(), RATE_LIMITS.studentRegisterByClient, clientKey);
    if (!limit.allowed) return { ok: false, state: { error: "Too many new usernames have been created from this connection. Please try again later.", values } };
    const res = await registerStudent({ username: parsed.data.username, department: parsed.data.department });
    if (!res.ok) return { ok: false, state: { fieldErrors: { username: TAKEN_MESSAGE }, values } };
    await startStudentSession(res.studentId);
    return { ok: true, studentId: res.studentId };
  }
  const parsed = loginSchema.safeParse({ username: rawUsername });
  if (!parsed.success) return { ok: false, state: { fieldErrors: fieldErrors(parsed.error), values } };
  const limit = await consumeRateLimit(pool(), RATE_LIMITS.studentLoginByClient, clientKey);
  if (!limit.allowed) return { ok: false, state: { error: "Too many attempts. Please wait a few minutes and try again.", values } };
  const found = await findActiveStudent(pool(), parsed.data.username);
  if (!found) return { ok: false, state: { fieldErrors: { username: NOT_FOUND_MESSAGE }, values } };
  if (!found.department_code) {
    const dept = departmentField.safeParse(str(fd, "department"));
    if (!dept.success) {
      // First time: show the one-time department step without an error; after that, the error.
      return {
        ok: false,
        state: { needsDepartment: true, info: DEPARTMENT_STEP, fieldErrors: fd.has("department") ? { department: "Choose your department." } : {}, values },
      };
    }
    await setStudentDepartment(pool(), found.id, dept.data);
  }
  const res = await signInStudent(pool(), parsed.data.username);
  if (!res.ok) return { ok: false, state: { fieldErrors: { username: NOT_FOUND_MESSAGE }, values } };
  await startStudentSession(res.studentId);
  return { ok: true, studentId: res.studentId };
}

export async function accessAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const mode = str(fd, "mode") === "new" ? "new" : "returning";
  const values = { username: str(fd, "username"), mode, department: str(fd, "department") };
  const identity = await establishIdentity(mode, fd, values);
  if (!identity.ok) return identity.state;
  redirect(safeNext(str(fd, "next")) ?? (mode === "new" ? "/student/complaints/new" : "/student/dashboard"));
}

export async function logoutStudentAction() {
  await endStudentSession();
  redirect("/");
}

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

type CreateResult = { ok: true; complaintId: string } | { ok: false; state: FormState } | { ok: false; duplicateOf: string };

/**
 * Logs a complaint or suggestion in one step, for both the form and the chat. A signed-in
 * student just submits; a signed-out student picks a new username (or enters their existing
 * one) in the same submission. Rate limits and duplicate detection apply either way.
 */
async function createComplaintFromForm(fd: FormData): Promise<CreateResult> {
  const values = {
    categoryId: str(fd, "categoryId"),
    description: str(fd, "description"),
    username: str(fd, "username"),
    mode: str(fd, "mode") === "returning" ? "returning" : "new",
    department: str(fd, "department"),
  };
  const parsed = complaintSchema.safeParse(values);

  const student = await getCurrentStudent();
  let studentId: string;
  if (!student) {
    // Validate the complaint first so the student does not end up with a username but no complaint.
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error);
      if (!values.username.trim()) errs.username = "Enter a username.";
      if (values.mode === "new" && !departmentField.safeParse(values.department).success) errs.department = "Choose your department.";
      return { ok: false, state: { fieldErrors: errs, values } };
    }
    const identity = await establishIdentity(values.mode, fd, values);
    if (!identity.ok) return { ok: false, state: identity.state };
    studentId = identity.studentId;
  } else {
    if (!parsed.success) return { ok: false, state: { fieldErrors: fieldErrors(parsed.error), values, needsDepartment: !student.department_code } };
    if (!student.department_code) {
      // Signed in from before departments existed: ask once, on this form.
      const dept = departmentField.safeParse(values.department);
      if (!dept.success) {
        return { ok: false, state: { needsDepartment: true, info: DEPARTMENT_STEP, fieldErrors: fd.has("department") ? { department: "Choose your department." } : {}, values } };
      }
      await setStudentDepartment(pool(), student.id, dept.data);
    }
    studentId = student.id;
  }

  // Save first and respond immediately; AI processing runs right after the response.
  const res = await submitComplaint(studentId, parsed.data!, await getClientKey(), { matchInline: false });
  if (!res.ok) {
    switch (res.error) {
      case "rate_limited":
        return { ok: false, state: { error: `You have sent several complaints or suggestions recently. Please wait about ${res.retryAfterMinutes} minutes before sending another.`, values } };
      case "duplicate":
        return { ok: false, duplicateOf: res.existingComplaintId };
      case "invalid_category":
        return { ok: false, state: { fieldErrors: { categoryId: "Choose a category." }, values } };
    }
  }
  const complaintId = res.complaintId;
  after(async () => {
    try {
      await processMatchJob(complaintId);
    } catch (err) {
      // The job stays queued; the worker / cron retries it.
      console.error("Background matching failed to start", { complaintId, error: (err as Error).name });
    }
  });
  revalidatePath("/", "layout");
  return { ok: true, complaintId };
}

/** The classic form (also the no-JavaScript path). */
export async function submitComplaintAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const res = await createComplaintFromForm(fd);
  if (res.ok) redirect(`/student/complaints/${res.complaintId}?submitted=1`);
  if ("duplicateOf" in res) redirect(`/student/complaints/${res.duplicateOf}?duplicate=1`);
  return res.state;
}

export type ChatSubmitResult =
  | { ok: true; complaintId: string }
  | { ok: false; duplicateOf?: string; message: string; needsDepartment?: boolean; field?: string };

/** The chat intake: same rules as the form, but returns a result instead of redirecting. */
export async function submitChatComplaintAction(fd: FormData): Promise<ChatSubmitResult> {
  const res = await createComplaintFromForm(fd);
  if (res.ok) return res;
  if ("duplicateOf" in res) return { ok: false, duplicateOf: res.duplicateOf, message: "You have already sent this same complaint recently, so it was not sent again." };
  const { state } = res;
  const [field, message] = Object.entries(state.fieldErrors ?? {})[0] ?? [];
  return {
    ok: false,
    needsDepartment: state.needsDepartment,
    field,
    message: message ?? state.error ?? state.info ?? "Something went wrong sending that. Please try again.",
  };
}

export type ReturningCheck = { ok: boolean; message: string; needsDepartment?: boolean };

/** Chat: does this returning username exist? (New usernames use checkUsernameAction.) */
export async function checkReturningUsernameAction(username: string): Promise<ReturningCheck> {
  const parsed = loginSchema.safeParse({ username: String(username ?? "") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const limit = await consumeRateLimit(pool(), RATE_LIMITS.usernameCheckByClient, await getClientKey());
  if (!limit.allowed) return { ok: false, message: "Too many checks. Please wait a moment." };
  const found = await findActiveStudent(pool(), parsed.data.username);
  if (!found) return { ok: false, message: NOT_FOUND_MESSAGE };
  return { ok: true, message: "Found it.", needsDepartment: !found.department_code };
}

export interface ChatStatus {
  state: "checking" | "grouped" | "done";
  message: string;
  answers: { subject: string; body: string }[];
}

/** Chat: the same fixed status wording the conversation page shows, plus any instant answers. */
export async function chatStatusAction(complaintId: string): Promise<ChatStatus | null> {
  const student = await getCurrentStudent();
  if (!student || !uuidSchema.safeParse(complaintId).success) return null;
  const detail = await getStudentComplaint(student.id, complaintId);
  if (!detail) return null;
  const { complaint, issue } = detail;
  const message = studentStatusMessage({ matchStatus: complaint.match_status, complaintStatus: complaint.status, issue })?.text ?? COPY.acknowledgement;
  if (complaint.match_status === "pending") return { state: "checking", message, answers: [] };
  const grouped = ["auto_matched", "manual"].includes(complaint.match_status) && issueIsUnresolved(issue?.status);
  const answers = (await getInstantAnswers(student.id, complaintId)).map((a) => ({ subject: a.subject, body: a.body }));
  return { state: grouped ? "grouped" : "done", message, answers };
}

/** "Did this answer your question?" Yes resolves the submission. Ownership is enforced by RLS. */
export async function answerFeedbackAction(fd: FormData) {
  const student = await requireStudent();
  const ids = { complaintId: uuidSchema.safeParse(str(fd, "complaintId")), messageId: uuidSchema.safeParse(str(fd, "messageId")) };
  if (!ids.complaintId.success || !ids.messageId.success) redirect("/student/dashboard");
  if (str(fd, "helpful") === "yes") await confirmAnswerResolved(student.id, ids.complaintId.data, ids.messageId.data);
  else await recordAnswerFeedback(student.id, ids.complaintId.data, ids.messageId.data, false);
  revalidatePath("/student/dashboard");
  revalidatePath(`/student/complaints/${ids.complaintId.data}`);
  redirect(`/student/complaints/${ids.complaintId.data}`);
}

/** A message in the complaint's chat. Plain form post, so it works without JavaScript. */
export async function sendReplyAction(fd: FormData) {
  const student = await requireStudent();
  const id = uuidSchema.safeParse(str(fd, "complaintId"));
  if (!id.success) redirect("/student/complaints");
  const res = await sendStudentReply(student.id, id.data, str(fd, "body"));
  revalidatePath(`/student/complaints/${id.data}`);
  redirect(res.ok ? `/student/complaints/${id.data}#latest` : `/student/complaints/${id.data}?replyErr=${res.error}#reply`);
}

/** "Still unresolved?" from the conversation's progress panel. Plain form post. */
export async function requestReviewFormAction(fd: FormData) {
  const student = await requireStudent();
  const parsed = reviewRequestSchema.safeParse({ complaintId: str(fd, "complaintId"), reason: str(fd, "reason") });
  const back = `/student/complaints/${uuidSchema.safeParse(str(fd, "complaintId")).success ? str(fd, "complaintId") : ""}`;
  if (!parsed.success) redirect(`${back}?reviewErr=short#review`);
  const res = await requestComplaintReview(student.id, parsed.data.complaintId, parsed.data.reason);
  revalidatePath(back);
  redirect(res.ok ? `${back}?review=sent#latest` : `${back}?reviewErr=${res.error}#review`);
}
