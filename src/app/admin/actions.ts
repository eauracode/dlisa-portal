"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { pool } from "@/lib/db";
import { authenticateAdmin, setAdminPassword, verifyAdminPassword } from "@/lib/auth/admin-auth";
import { endAdminSession, getClientKey, requireAdmin, startAdminSession } from "@/lib/auth/current";
import { ForbiddenError } from "@/lib/auth/permissions";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";
import { adminLoginSchema, adminPasswordSchema, ADMIN_ROLES, fieldErrors, ISSUE_STATUSES, optionalDateTime, PRIORITIES, uuidSchema, type AdminRole } from "@/lib/validation";
import { ActionError, type AdminContext } from "@/lib/services/admin/context";
import * as issues from "@/lib/services/admin/issues";
import { decideReview, reassignComplaint, retryMatching } from "@/lib/services/admin/complaints";
import { createAdmin, saveCategory, updateAdmin } from "@/lib/services/admin/management";
import { matchingSettingsSchema, prioritySettingsSchema, saveSetting } from "@/lib/services/settings";
import { aiRunsRemotely, dispatchAiTask, requestOrigin } from "@/lib/matching/dispatch";
import { sendMessage, type MessageTarget } from "@/lib/services/messages";
import { setMessageReusable } from "@/lib/services/instant-answers";
import { sendStaffReply } from "@/lib/services/conversations";
import { archiveMemo, createMemo, editMemo, publishDraft, setMemoPinned } from "@/lib/services/memos";
import { after } from "next/server";

export interface AdminFormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function adminLoginAction(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const values = { email: str(fd, "email") };
  const parsed = adminLoginSchema.safeParse({ email: values.email, password: fd.get("password") ?? "" });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const limit = await consumeRateLimit(pool(), RATE_LIMITS.adminLoginByClient, await getClientKey());
  if (!limit.allowed) return { error: "Too many sign-in attempts. Please wait and try again.", values };
  const res = await authenticateAdmin(pool(), parsed.data.email, parsed.data.password);
  if (!res.ok) {
    return { error: res.error === "locked" ? `This account is temporarily locked. Try again in about ${res.retryAfterMinutes} minutes.` : "The email or password is incorrect.", values };
  }
  await startAdminSession(res.admin.id);
  redirect(res.admin.must_change_password ? "/admin/account?first=1" : "/admin");
}

export async function adminLogoutAction() {
  await endAdminSession();
  redirect("/admin/login");
}

export async function changeAdminPasswordAction(_prev: AdminFormState, fd: FormData): Promise<AdminFormState> {
  const admin = await requireAdmin(undefined, { allowPasswordChange: true });
  const next = adminPasswordSchema.safeParse(fd.get("newPassword") ?? "");
  if (!next.success) return { fieldErrors: { newPassword: next.error.issues[0].message } };
  if (fd.get("newPassword") !== fd.get("confirmPassword")) return { fieldErrors: { confirmPassword: "The passwords do not match." } };
  if (!(await verifyAdminPassword(pool(), admin.id, String(fd.get("currentPassword") ?? "")))) return { fieldErrors: { currentPassword: "Your current password is incorrect." } };
  if (fd.get("newPassword") === fd.get("currentPassword")) return { fieldErrors: { newPassword: "Choose a password different from the current one." } };
  await setAdminPassword(pool(), admin.id, next.data);
  // Rotate the session after a credential change.
  await endAdminSession();
  await startAdminSession(admin.id);
  redirect("/admin?ok=Password%20changed");
}

// ---------------------------------------------------------------------------
// Helper: run a mutation, then redirect back with a flash message
// ---------------------------------------------------------------------------

async function run(back: string, okMessage: string, fn: (admin: AdminContext) => Promise<unknown>): Promise<never> {
  const admin = await requireAdmin();
  let error: string | null = null;
  try {
    await fn({ id: admin.id, role: admin.role, display_name: admin.display_name });
  } catch (err) {
    if (err instanceof ActionError || err instanceof ForbiddenError) error = err.message;
    else if (err instanceof z.ZodError) error = err.issues[0]?.message ?? "Invalid input.";
    else {
      console.error("Admin action failed", { action: okMessage, error: (err as Error).name });
      error = "Something went wrong. No changes were saved.";
    }
  }
  revalidatePath("/admin", "layout");
  const sep = back.includes("?") ? "&" : "?";
  redirect(`${back}${sep}${error ? `err=${encodeURIComponent(error)}` : `ok=${encodeURIComponent(okMessage)}`}`);
}

const id = (fd: FormData, key = "issueId") => uuidSchema.parse(str(fd, key));
const issuePath = (fd: FormData) => `/admin/issues/${id(fd)}`;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export async function assignAction(fd: FormData) {
  const officer = str(fd, "officerId");
  await run(issuePath(fd), "Assignment updated", (a) => issues.assignOfficer(a, id(fd), officer ? uuidSchema.parse(officer) : null));
}

export async function deadlineAction(fd: FormData) {
  await run(issuePath(fd), "Expected resolution date updated", (a) =>
    issues.setDeadline(a, id(fd), optionalDateTime.parse(str(fd, "deadline")), str(fd, "reason") || null),
  );
}

export async function statusAction(fd: FormData) {
  const status = z.enum(ISSUE_STATUSES).parse(str(fd, "status"));
  await run(issuePath(fd), "Status updated", (a) => issues.changeStatus(a, id(fd), status, str(fd, "note") || null));
}

export async function priorityAction(fd: FormData) {
  const raw = str(fd, "priority");
  const priority = raw === "auto" ? null : z.enum(PRIORITIES).parse(raw);
  await run(issuePath(fd), "Priority updated", (a) => issues.overridePriority(a, id(fd), priority, str(fd, "reason") || null));
}

export async function publishUpdateAction(fd: FormData) {
  const visibility = z.enum(["reporters", "public"]).parse(str(fd, "visibility") || "reporters");
  const type = z.enum(["progress", "institutional_response"]).parse(str(fd, "type") || "progress");
  await run(issuePath(fd), "Update published", (a) => issues.publishUpdate(a, id(fd), { message: str(fd, "message"), visibility, type }));
}

export async function noteAction(fd: FormData) {
  const visibility = z.enum(["internal", "oversight"]).parse(str(fd, "visibility"));
  await run(issuePath(fd), "Note added", (a) => issues.addNote(a, id(fd), str(fd, "note"), visibility));
}

export async function visibilityAction(fd: FormData) {
  const visible = str(fd, "visible") === "true";
  await run(issuePath(fd), visible ? "Issue is now publicly visible" : "Issue is now private", (a) =>
    issues.setPublicVisibility(a, id(fd), { visible, publicTitle: str(fd, "publicTitle"), publicSummary: str(fd, "publicSummary") }),
  );
}

export async function editIssueAction(fd: FormData) {
  await run(issuePath(fd), "Issue details saved", (a) =>
    issues.editIssueDetails(a, id(fd), {
      title: str(fd, "title"),
      summary: str(fd, "summary"),
      categoryId: z.coerce.number().int().parse(str(fd, "categoryId")),
      sensitive: fd.get("sensitive") === "on",
    }),
  );
}

export async function escalateAction(fd: FormData) {
  await run(issuePath(fd), "Escalated to school management", (a) => issues.escalateIssue(a, id(fd), str(fd, "reason")));
}

export async function escalationStatusAction(fd: FormData) {
  const status = z.enum(["acknowledged", "responded", "closed"]).parse(str(fd, "escalationStatus"));
  await run(issuePath(fd), "Escalation status updated", (a) => issues.setEscalationStatus(a, id(fd), status, str(fd, "note") || null));
}

export async function proposeAction(fd: FormData) {
  const type = z.enum(["deadline", "escalation"]).parse(str(fd, "type"));
  await run(issuePath(fd), "Proposal sent to the Association Administrator", (a) =>
    issues.createProposal(a, id(fd), { type, deadline: type === "deadline" ? optionalDateTime.parse(str(fd, "deadline")) : null, reason: str(fd, "reason") }),
  );
}

export async function decideProposalAction(fd: FormData) {
  await run(issuePath(fd), "Proposal decided", (a) => issues.decideProposal(a, id(fd, "proposalId"), str(fd, "decision") === "approve", str(fd, "note") || null));
}

export async function mergeAction(fd: FormData) {
  const target = id(fd, "targetIssueId");
  await run(`/admin/issues/${target}`, "Issues merged", (a) => issues.mergeIssues(a, id(fd), target, str(fd, "reason")));
}

export async function splitAction(fd: FormData) {
  const complaintIds = fd.getAll("complaintIds").map((v) => uuidSchema.parse(String(v)));
  const target = str(fd, "targetIssueId");
  await run(issuePath(fd), "Selected submissions were separated", (a) =>
    issues.splitIssue(a, id(fd), complaintIds, target && target !== "new" ? uuidSchema.parse(target) : null, str(fd, "reason")),
  );
}

export async function reviewRequestAction(fd: FormData) {
  const action = z.enum(["reopen", "separate", "decline"]).parse(str(fd, "decision"));
  await run(issuePath(fd), "Review request handled", (a) => issues.handleReviewRequest(a, id(fd, "complaintId"), action, str(fd, "message")));
}

// ---------------------------------------------------------------------------
// Complaints and match review
// ---------------------------------------------------------------------------

export async function reassignComplaintAction(fd: FormData) {
  const complaintId = id(fd, "complaintId");
  const target = str(fd, "targetIssueId");
  await run(`/admin/complaints/${complaintId}`, "Complaint regrouped", (a) =>
    reassignComplaint(a, complaintId, target === "new" ? "new" : uuidSchema.parse(target), str(fd, "reason")),
  );
}

export async function retryMatchingAction(fd: FormData) {
  const complaintId = id(fd, "complaintId");
  await run(`/admin/complaints/${complaintId}`, "Automatic matching was retried", async (a) => {
    await retryMatching(a, complaintId);
    // If the provider is still unavailable the job stays queued for the worker.
    await dispatchAiTask({ task: "match", complaintId });
  });
}

export async function matchReviewAction(fd: FormData) {
  const reviewId = id(fd, "reviewId");
  const decision = str(fd, "decision");
  const reason = str(fd, "reason") || null;
  await run("/admin/match-review", "Match review recorded", (a) => {
    if (decision === "confirm") return decideReview(a, reviewId, { action: "confirm" }, reason);
    if (decision === "confirm_reopen") return decideReview(a, reviewId, { action: "confirm", reopenIfResolved: true }, reason);
    if (decision === "reject") return decideReview(a, reviewId, { action: "reject" }, reason);
    if (decision === "reassign") return decideReview(a, reviewId, { action: "reassign", issueId: uuidSchema.parse(str(fd, "targetIssueId")) }, reason);
    throw new ActionError("Choose a decision.");
  });
}

export async function runJobsAction() {
  await run("/admin/settings", "Matching queue processed", async (a) => {
    if (a.role !== "union_admin") throw new ForbiddenError();
    await dispatchAiTask({ task: "maintenance" });
  });
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export async function createAdminAction(fd: FormData) {
  await run("/admin/users", "Administrator created. Share the temporary password securely; it must be changed at first login.", (a) => {
    const role = z.enum(ADMIN_ROLES).parse(str(fd, "role")) as AdminRole;
    const email = z.string().email("Enter a valid email address.").parse(str(fd, "email").toLowerCase());
    const password = adminPasswordSchema.parse(fd.get("password") ?? "");
    return createAdmin(a, { email, displayName: str(fd, "displayName") || email, role, password });
  });
}

export async function updateAdminAction(fd: FormData) {
  const role = z.enum(ADMIN_ROLES).parse(str(fd, "role")) as AdminRole;
  await run("/admin/users", "Administrator updated", (a) => updateAdmin(a, id(fd, "adminId"), { role, active: str(fd, "active") === "true" }));
}

export async function saveCategoryAction(fd: FormData) {
  const rawId = str(fd, "categoryId");
  await run("/admin/settings", "Category saved", (a) =>
    saveCategory(a, {
      id: rawId ? z.coerce.number().int().parse(rawId) : undefined,
      name: str(fd, "name"),
      description: str(fd, "description"),
      academic: fd.get("academic") === "on",
      active: fd.get("active") === "on",
      sortOrder: z.coerce.number().int().min(0).max(1000).parse(str(fd, "sortOrder") || "100"),
    }),
  );
}

export async function saveMatchingSettingsAction(fd: FormData) {
  await run("/admin/settings", "Matching thresholds saved", async (a) => {
    if (a.role !== "union_admin") throw new ForbiddenError();
    const parsed = matchingSettingsSchema.parse(Object.fromEntries(["autoThreshold", "reviewThreshold", "ambiguityMargin", "resolvedLookbackDays"].map((k) => [k, str(fd, k)])));
    await saveSetting(pool(), "matching", parsed, a.id);
  });
}

export async function savePrioritySettingsAction(fd: FormData) {
  await run("/admin/settings", "Priority rules saved", async (a) => {
    if (a.role !== "union_admin") throw new ForbiddenError();
    const parsed = prioritySettingsSchema.parse(Object.fromEntries(["elevated", "high", "critical", "overduePoints", "academicImpactPoints"].map((k) => [k, str(fd, k)])));
    await saveSetting(pool(), "priority", parsed, a.id);
  });
}

// ---------------------------------------------------------------------------
// Messages to students
// ---------------------------------------------------------------------------

/** Only return to admin pages (an optional simple query string such as ?tab=memos is kept). */
function adminBack(fd: FormData, fallback: string): string {
  const back = str(fd, "back");
  return /^\/admin\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$/.test(back) ? back : fallback;
}

export async function sendMessageAction(fd: FormData) {
  const back = adminBack(fd, "/admin/messages");
  await run(back, "Message sent", async (a) => {
    const type = z.enum(["issue", "username", "reporter", "all", "department", "open_complaints"]).parse(str(fd, "targetType"));
    if (type === "all" && str(fd, "confirmAll") !== "on") throw new ActionError("Tick the box to confirm sending a memo to every student.");
    const target: MessageTarget =
      type === "issue"
        ? { type, issueId: uuidSchema.parse(str(fd, "issueId")) }
        : type === "username"
          ? { type, username: z.string().min(1, "Enter a username.").parse(str(fd, "username")) }
          : type === "reporter"
            ? { type, complaintId: uuidSchema.parse(str(fd, "complaintId")) }
            : type === "department"
              ? { type, department: z.string().min(1, "Choose a department.").parse(str(fd, "department")) }
              : { type };
    // Forms that show the reuse checkbox send reuseShown; others keep the audience default.
    const reusable = fd.has("reuseShown") ? str(fd, "reusable") === "on" : undefined;
    await sendMessage(a, target, { subject: str(fd, "subject"), body: String(fd.get("body") ?? ""), reusable });
    // Prepare the answer for instant reuse now, rather than on the next student's submission.
    const origin = aiRunsRemotely() ? await requestOrigin() : undefined;
    after(() => dispatchAiTask({ task: "embed-answers" }, origin).catch((err) => console.error("Answer embedding failed", { error: (err as Error).name })));
  });
}

export async function setMessageReuseAction(fd: FormData) {
  await run("/admin/messages?tab=bulk", str(fd, "reusable") === "on" ? "Answer will be reused" : "Answer will no longer be reused", (a) =>
    setMessageReusable(a, uuidSchema.parse(str(fd, "messageId")), str(fd, "reusable") === "on"),
  );
}

// ---------------------------------------------------------------------------
// Conversations and memos
// ---------------------------------------------------------------------------

/** A staff reply in one complaint's conversation (only that student sees it). */
export async function staffReplyAction(fd: FormData) {
  const complaintId = uuidSchema.parse(str(fd, "complaintId"));
  await run(`/admin/messages?tab=conversations&c=${complaintId}`, "Reply sent", (a) => sendStaffReply(a, complaintId, String(fd.get("body") ?? "")));
}

export async function createMemoAction(fd: FormData) {
  const publish = str(fd, "intent") === "publish";
  await run("/admin/messages?tab=memos", publish ? "Memo published" : "Draft saved", (a) =>
    createMemo(a, { title: str(fd, "title"), body: String(fd.get("body") ?? ""), pinned: str(fd, "pinned") === "on", public: str(fd, "public") === "on", publish }),
  );
}

export async function memoAction(fd: FormData) {
  const id = uuidSchema.parse(str(fd, "memoId"));
  const op = z.enum(["publish", "pin", "unpin", "archive", "edit"]).parse(str(fd, "op"));
  const ok = { publish: "Memo published", pin: "Memo pinned", unpin: "Memo unpinned", archive: "Memo archived", edit: "Memo updated" }[op];
  await run("/admin/messages?tab=memos", ok, (a) =>
    op === "publish"
      ? publishDraft(a, id)
      : op === "pin" || op === "unpin"
        ? setMemoPinned(a, id, op === "pin")
        : op === "archive"
          ? archiveMemo(a, id)
          : editMemo(a, id, { title: str(fd, "title"), body: String(fd.get("body") ?? ""), public: str(fd, "public") === "on" }),
  );
}
