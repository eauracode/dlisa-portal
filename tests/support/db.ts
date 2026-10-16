import { one, pool } from "@/lib/db";
import { registerStudent } from "@/lib/auth/student-auth";
import { createAdminUser } from "@/lib/auth/admin-auth";
import type { AdminContext } from "@/lib/services/admin/context";
import type { AdminRole } from "@/lib/validation";

/** Remove all transactional data between tests (keeps categories and schema). */
export async function resetData() {
  await pool().query(`
    truncate audit_logs, match_jobs, ai_match_reviews, complaint_events, issue_events, issue_proposals,
             issue_assignments, administrative_notes, issue_updates, issue_submissions, complaint_analyses,
             complaints, consolidated_issues, sessions, rate_limits, app_settings, students, admin_users
    restart identity cascade`);
}

let counter = 0;
export async function makeStudent(prefix = "student"): Promise<string> {
  counter += 1;
  const res = await registerStudent({ username: `${prefix}${counter}${Date.now() % 100000}` });
  if (!res.ok) throw new Error("could not create student");
  return res.studentId;
}

export async function makeAdmin(role: AdminRole, name = role): Promise<AdminContext> {
  counter += 1;
  const res = await createAdminUser(
    pool(),
    { email: `${name}${counter}@test.local`, displayName: `${name} ${counter}`, role, password: "correct-horse-42-battery", mustChangePassword: false },
    null,
  );
  if (!res.ok) throw new Error("could not create admin");
  return { id: res.id, role, display_name: `${name} ${counter}` };
}

export async function categoryId(slug: string): Promise<number> {
  const row = await one<{ id: number }>(pool(), `select id from issue_categories where slug = $1`, [slug]);
  return row!.id;
}

export async function complaintRow(id: string) {
  return one<{ status: string; match_status: string; consolidated_issue_id: string | null }>(
    pool(),
    `select status, match_status, consolidated_issue_id from complaints where id = $1`,
    [id],
  );
}

export async function issueRow(id: string) {
  return one<{ total_submission_count: number; distinct_reporter_count: number; status: string; priority: string; expected_resolution_at: Date | null }>(
    pool(),
    `select total_submission_count, distinct_reporter_count, status, priority, expected_resolution_at from consolidated_issues where id = $1`,
    [id],
  );
}
