import type { AdminRole } from "../validation";

/**
 * Explicit role → permission map (least privilege). Issue-level access is further limited by
 * `canAccessIssue`: case officers only see issues assigned to them, and oversight officers
 * only see issues escalated to school management.
 */
export const PERMISSIONS = {
  "admins.manage": ["union_admin"],
  "settings.manage": ["union_admin"],
  "audit.view": ["union_admin"],
  "reports.view": ["union_admin", "oversight_officer"],
  "complaints.view_all": ["union_admin"],
  "complaints.reassign": ["union_admin"],
  "issues.view_all": ["union_admin"],
  "issues.assign": ["union_admin"],
  "issues.set_deadline": ["union_admin"],
  "issues.propose": ["case_officer"],
  "issues.decide_proposals": ["union_admin"],
  "issues.escalate": ["union_admin"],
  "issues.update_status": ["union_admin", "case_officer"],
  "issues.reopen": ["union_admin", "case_officer"],
  "issues.set_priority": ["union_admin"],
  "issues.merge_split": ["union_admin"],
  "issues.edit_details": ["union_admin"],
  "issues.visibility": ["union_admin"],
  "issues.publish_update": ["union_admin", "case_officer"],
  "issues.internal_note": ["union_admin", "case_officer"],
  "issues.view_internal_notes": ["union_admin", "case_officer", "oversight_officer"],
  "issues.oversight_note": ["union_admin", "oversight_officer"],
  "issues.view_oversight_notes": ["union_admin", "oversight_officer"],
  "issues.institutional_response": ["union_admin", "oversight_officer"],
  "issues.escalation_status": ["oversight_officer", "union_admin"],
  "issues.handle_review_requests": ["union_admin", "case_officer"],
  "matches.review": ["union_admin"],
  // Messaging. Issue/reporter messages are further limited to issues the sender can access.
  "messages.view": ["union_admin", "case_officer"],
  "messages.send_issue": ["union_admin", "case_officer"],
  "messages.send_direct": ["union_admin"],
  "messages.broadcast": ["union_admin"],
  // Memos: Case Officers can draft; only Union Admins publish, pin, edit published memos or archive.
  "memos.draft": ["union_admin", "case_officer"],
  "memos.publish": ["union_admin"],
  "jobs.run": ["union_admin"],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLE_LABELS: Record<AdminRole, string> = {
  union_admin: "Union Administrator",
  case_officer: "Union Case Officer",
  oversight_officer: "School Management Oversight Officer",
};

export function can(role: AdminRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly AdminRole[]).includes(role);
}

export interface IssueAccessFacts {
  assigned_admin_id: string | null;
  escalated: boolean;
}

export function canAccessIssue(admin: { id: string; role: AdminRole }, issue: IssueAccessFacts): boolean {
  switch (admin.role) {
    case "union_admin":
      return true;
    case "case_officer":
      return issue.assigned_admin_id === admin.id;
    case "oversight_officer":
      return issue.escalated;
  }
}

/**
 * SQL predicate restricting consolidated issues (aliased `alias`) to those the admin may see.
 * Returns the condition text using parameter index `$n` for the admin id.
 */
export function issueScopeSql(admin: { id: string; role: AdminRole }, alias: string, paramIndex: number): { sql: string; params: unknown[] } {
  switch (admin.role) {
    case "union_admin":
      return { sql: "true", params: [] };
    case "case_officer":
      return { sql: `${alias}.assigned_admin_id = $${paramIndex}`, params: [admin.id] };
    case "oversight_officer":
      return { sql: `${alias}.escalated`, params: [] };
  }
}

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: AdminRole, permission: Permission) {
  if (!can(role, permission)) throw new ForbiddenError();
}
