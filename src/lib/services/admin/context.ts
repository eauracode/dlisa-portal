import { one, rows, type Db } from "../../db";
import { env } from "../../env";
import { hmac } from "../../security/crypto";
import { assertCan, canAccessIssue, type Permission } from "../../auth/permissions";
import type { AdminRole } from "../../validation";

export interface AdminContext {
  id: string;
  role: AdminRole;
  display_name: string;
}

/** An error whose message is safe to show to the acting administrator. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

export class NotFoundError extends ActionError {
  constructor(what = "Record") {
    super(`${what} not found or you do not have access to it.`);
    this.name = "NotFoundError";
  }
}

export interface IssueRow {
  id: string;
  title: string;
  summary: string;
  category_id: number;
  status: string;
  priority: string;
  computed_priority: string;
  priority_score: number;
  priority_override: string | null;
  priority_override_reason: string | null;
  total_submission_count: number;
  distinct_reporter_count: number;
  assigned_admin_id: string | null;
  expected_resolution_at: Date | null;
  proposed_resolution_at: Date | null;
  public_visibility: boolean;
  public_title: string | null;
  public_summary: string | null;
  severity: string;
  academic_impact: boolean;
  safety_flag: boolean;
  sensitive: boolean;
  course_codes: string[];
  academic_period: string | null;
  problem_type: string | null;
  escalated: boolean;
  escalated_at: Date | null;
  escalation_reason: string | null;
  escalation_status: string | null;
  merged_into_id: string | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  resolved_at: Date | null;
}

export const ISSUE_COLUMNS = `id, title, summary, category_id, status, priority, computed_priority, priority_score, priority_override,
  priority_override_reason, total_submission_count, distinct_reporter_count, assigned_admin_id, expected_resolution_at,
  proposed_resolution_at, public_visibility, public_title, public_summary, severity, academic_impact, safety_flag, sensitive,
  course_codes, academic_period, problem_type, escalated, escalated_at, escalation_reason, escalation_status, merged_into_id,
  resolution_note, created_at, updated_at, last_activity_at, resolved_at`;

/**
 * Load an issue and enforce issue-level access (assignment / escalation scope) and,
 * optionally, a role permission. Missing and forbidden issues look the same.
 */
export async function loadIssueForAdmin(
  db: Db,
  admin: AdminContext,
  issueId: string,
  opts: { permission?: Permission; forUpdate?: boolean } = {},
): Promise<IssueRow> {
  if (opts.permission) assertCan(admin.role, opts.permission);
  const issue = await one<IssueRow>(
    db,
    `select ${ISSUE_COLUMNS} from consolidated_issues where id = $1 ${opts.forUpdate ? "for update" : ""}`,
    [issueId],
  );
  if (!issue || !canAccessIssue(admin, issue)) throw new NotFoundError("Issue");
  return issue;
}

/** Stable pseudonym for a reporting student, so staff never need to see usernames. */
export function reporterLabel(studentId: string): string {
  return `Reporter ${hmac(env().APP_SECRET, `reporter:${studentId}`).slice(0, 6).toUpperCase()}`;
}

/**
 * Association staff (administrators and case officers) see each student's username and
 * department. School-management oversight officers keep the pseudonymous reporter code and
 * the department privacy rule.
 */
export function seesStudentIdentity(admin: AdminContext): boolean {
  return admin.role !== "oversight_officer";
}

/** Returns a labeller for reporters: "@username" for Association staff, else a reporter code. */
export async function reporterNamer(db: Db, admin: AdminContext, studentIds: string[]): Promise<(studentId: string) => string> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  if (!seesStudentIdentity(admin) || ids.length === 0) return reporterLabel;
  const list = await rows<{ id: string; username: string }>(db, `select id, username from students where id = any($1::uuid[])`, [ids]);
  const names = new Map(list.map((r) => [r.id, r.username]));
  return (studentId) => (names.has(studentId) ? `@${names.get(studentId)}` : reporterLabel(studentId));
}

