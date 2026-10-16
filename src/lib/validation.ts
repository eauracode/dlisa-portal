import { z } from "zod";
import { APP_CONFIG } from "@/config/app";
import { departmentField } from "./department-validation";

// Strip control characters (except newlines/tabs) and normalise Unicode before storing text.
export function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function cleanLine(value: string): string {
  return cleanText(value).replace(/\s+/g, " ");
}

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "moderator", "staff", "union", "dli",
  "unilag", "management", "officer", "null", "undefined", "anonymous",
]);

export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

export const usernameSchema = z
  .string()
  .transform((v) => v.normalize("NFKC").trim())
  .pipe(
    z
      .string()
      .min(3, "Username must be at least 3 characters.")
      .max(24, "Username must be at most 24 characters.")
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, numbers, dots, hyphens or underscores, starting with a letter or number.")
      .refine((v) => !/^\d+$/.test(v), "Username cannot be only numbers (avoid using your matriculation or phone number).")
      .refine((v) => !RESERVED_USERNAMES.has(v.toLowerCase()), "That username is reserved. Please choose another."),
  );

export const registerSchema = z.object({ username: usernameSchema, department: departmentField });

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username.").max(64),
});

export const SUBJECT_MIN = 5;
export const SUBJECT_MAX = 150;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 4000;

/**
 * Students do not type a subject; a short title is derived from the description for
 * dashboards, history and staff lists: the first sentence, or the opening words when the
 * first sentence is very short or very long.
 */
export function deriveSubject(description: string): string {
  const flat = cleanLine(description);
  const firstSentence = flat.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? flat;
  const base = firstSentence.length >= 15 ? firstSentence : flat;
  const max = 90;
  if (base.length <= max) return base.replace(/[.!?]+$/, "").padEnd(SUBJECT_MIN, ".");
  const cut = base.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, "")}…`;
}

export const complaintSchema = z
  .object({
    categoryId: z.coerce.number().int().positive({ message: "Choose a category." }),
    description: z
      .string()
      .transform(cleanText)
      .pipe(
        z
          .string()
          .min(DESCRIPTION_MIN, `Please describe the issue in at least ${DESCRIPTION_MIN} characters.`)
          .max(DESCRIPTION_MAX, `Description must be at most ${DESCRIPTION_MAX} characters.`),
      ),
  })
  .transform((v) => ({ ...v, subject: deriveSubject(v.description).slice(0, SUBJECT_MAX) }));

export const reviewRequestSchema = z.object({
  complaintId: z.string().uuid(),
  reason: z
    .string()
    .transform(cleanText)
    .pipe(z.string().min(10, "Please explain briefly why the concern remains unresolved (at least 10 characters).").max(1000)),
});

export const uuidSchema = z.string().uuid();

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const adminPasswordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Use a mix of letters and numbers.");

export const ADMIN_ROLES = ["union_admin", "case_officer", "oversight_officer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PRIORITIES = ["normal", "elevated", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ISSUE_STATUSES = ["new", "under_review", "in_progress", "awaiting_external_action", "resolved", "closed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number] | "merged";

export type ComplaintStatus =
  | "received"
  | "under_review"
  | "in_progress"
  | "awaiting_external_action"
  | "resolved"
  | "review_requested"
  | "closed";

/**
 * Optional datetime from an <input type="datetime-local"> ("2026-10-20T14:00"), interpreted
 * in Lagos time regardless of the server's timezone; empty string => null.
 */
export const optionalDateTime = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return null;
    const hasOffset = /(Z|[+-]\d{2}:\d{2})$/.test(v);
    const d = new Date(hasOffset ? v : `${v.length === 16 ? `${v}:00` : v}${APP_CONFIG.utcOffset}`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date and time." });
      return z.NEVER;
    }
    return d;
  });

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}
