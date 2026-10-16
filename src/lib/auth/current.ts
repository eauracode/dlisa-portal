import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { one, pool } from "../db";
import { env, isProduction } from "../env";
import { hmac } from "../security/crypto";
import { createSession, destroySession, resolveSession, SESSION_POLICY } from "./sessions";
import { getAdminById, type AdminUser } from "./admin-auth";
import { can, type Permission } from "./permissions";

// __Host- prefix (production): cookie is Secure, host-only and path=/, so it cannot be
// set or overwritten by subdomains.
const STUDENT_COOKIE = () => (isProduction() ? "__Host-dli_student" : "dli_student");
const ADMIN_COOKIE = () => (isProduction() ? "__Host-dli_admin" : "dli_admin");

async function setCookie(name: string, token: string, maxAgeSeconds: number) {
  (await cookies()).set(name, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

/**
 * Pseudonymous client key for rate limiting: HMAC of the client IP, so raw IP addresses
 * are never written to the database.
 */
export async function getClientKey(): Promise<string> {
  const h = await headers();
  const forwarded = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const trusted = env().TRUSTED_PROXY_COUNT;
  // With N trusted proxies, the client address is the Nth entry from the right.
  const ip = (trusted > 0 ? forwarded[forwarded.length - trusted] : undefined) ?? h.get("x-real-ip") ?? "unknown";
  return hmac(env().APP_SECRET, `ip:${ip}`);
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export async function startStudentSession(studentId: string) {
  const { token } = await createSession(pool(), { type: "student", studentId });
  await setCookie(STUDENT_COOKIE(), token, SESSION_POLICY.student.absoluteHours * 3600);
}

export async function endStudentSession() {
  const store = await cookies();
  await destroySession(pool(), store.get(STUDENT_COOKIE())?.value);
  store.delete(STUDENT_COOKIE());
}

export interface CurrentStudent {
  id: string;
  username: string;
  department_code: string | null;
}

export const getCurrentStudent = cache(async (): Promise<CurrentStudent | null> => {
  const token = (await cookies()).get(STUDENT_COOKIE())?.value;
  const studentId = await resolveSession(pool(), token, "student");
  if (!studentId) return null;
  return one<CurrentStudent>(pool(), `select id, username, department_code from students where id = $1`, [studentId]);
});

export async function requireStudent(returnTo?: { path: string; mode?: "new" | "returning" }): Promise<CurrentStudent> {
  const student = await getCurrentStudent();
  if (!student) {
    const qs = new URLSearchParams();
    if (returnTo) qs.set("next", returnTo.path);
    if (returnTo?.mode) qs.set("mode", returnTo.mode);
    redirect(`/student/access${qs.size ? `?${qs}` : ""}`);
  }
  return student;
}

// ---------------------------------------------------------------------------
// Administrators
// ---------------------------------------------------------------------------

export async function startAdminSession(adminId: string) {
  const { token } = await createSession(pool(), { type: "admin", adminId });
  await setCookie(ADMIN_COOKIE(), token, SESSION_POLICY.admin.absoluteHours * 3600);
}

export async function endAdminSession() {
  const store = await cookies();
  await destroySession(pool(), store.get(ADMIN_COOKIE())?.value);
  store.delete(ADMIN_COOKIE());
}

export const getCurrentAdmin = cache(async (): Promise<AdminUser | null> => {
  const token = (await cookies()).get(ADMIN_COOKIE())?.value;
  const adminId = await resolveSession(pool(), token, "admin");
  if (!adminId) return null;
  return getAdminById(pool(), adminId);
});

/**
 * Server-side guard for every admin page and action. Redirects to login when there is no
 * valid session, forces a password change on first login, and 404s on missing permission.
 */
export async function requireAdmin(permission?: Permission, opts: { allowPasswordChange?: boolean } = {}): Promise<AdminUser> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");
  if (admin.must_change_password && !opts.allowPasswordChange) redirect("/admin/account?first=1");
  if (permission && !can(admin.role, permission)) redirect("/admin?denied=1");
  return admin;
}
