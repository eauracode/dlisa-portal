import "./load-env";
import { randomBytes } from "node:crypto";
import { closePool, one, pool } from "../src/lib/db";
import { registerStudent } from "../src/lib/auth/student-auth";
import { createAdminUser } from "../src/lib/auth/admin-auth";
import { submitComplaint } from "../src/lib/services/student-complaints";
import * as issues from "../src/lib/services/admin/issues";
import type { AdminContext } from "../src/lib/services/admin/context";

/**
 * Local demo data. Refuses to run in production or against a database that already has
 * students, so demo records are never mixed with real ones.
 *   npm run db:reset && npm run db:seed
 */
const COMPLAINTS: Array<{ student: string; category: string; subject: string; description: string }> = [
  // LMS outage: several students, near-identical wording -> automatic grouping
  { student: "quiet_owl", category: "materials", subject: "LMS portal not loading", description: "The LMS portal has not been loading since Monday. I cannot access my course materials or submit assignments on the LMS." },
  { student: "lagos_learner", category: "materials", subject: "LMS portal not loading for days", description: "The LMS portal is not loading since Monday. I cannot access course materials or submit my assignments on the LMS portal." },
  { student: "night_reader", category: "materials", subject: "Cannot access LMS portal", description: "The LMS portal has not been loading since Monday and I cannot access course materials or submit assignments on the LMS." },
  { student: "quiet_owl", category: "materials", subject: "LMS portal still not loading", description: "The LMS portal is still not loading since Monday. I still cannot access my course materials or submit assignments on the LMS." },
  // Related but possibly different (mobile only?) -> uncertain, goes to the match review queue
  { student: "yaba_centre", category: "materials", subject: "LMS portal not loading on phone", description: "The LMS portal is not loading on my phone since Monday. I can access course materials on a laptop but cannot submit assignments from the LMS on my phone." },
  // Missing results with course codes
  { student: "accounting_ade", category: "exams-results", subject: "ACC 201 result not uploaded", description: "My ACC 201 result for first semester 2025/2026 has not been uploaded on the portal. Other courses are showing but ACC 201 result is missing." },
  { student: "ledger_love", category: "exams-results", subject: "ACC 201 result missing on portal", description: "My ACC 201 result for first semester 2025/2026 is missing on the portal. Other course results are showing but the ACC 201 result has not been uploaded." },
  // Same wording, different course -> must go to review, never auto-grouped
  { student: "biz_student", category: "exams-results", subject: "BUS 105 result not uploaded", description: "My BUS 105 result for first semester 2025/2026 has not been uploaded on the portal. Other courses are showing but BUS 105 result is missing." },
  // Exam timetable clash
  { student: "eco_kemi", category: "exams-results", subject: "GST 102 and ECO 201 exams clash", description: "The examination timetable schedules GST 102 and ECO 201 at the same time on Thursday 10am. Many of us registered for both courses." },
  { student: "night_reader", category: "exams-results", subject: "Exam timetable clash GST 102 and ECO 201", description: "The exam timetable has GST 102 and ECO 201 scheduled at the same time on Thursday 10am. Many students registered for both courses." },
  // Facilities
  { student: "yaba_centre", category: "facilities", subject: "No power at Yaba study centre", description: "There has been no electricity at the Yaba study centre during weekend tutorials for three weeks. The generator is not switched on and we sit in the dark." },
  // Fees
  { student: "lagos_learner", category: "admin-services", subject: "Remita fee payment not reflecting", description: "I paid my school fees through Remita two weeks ago but the payment is not reflecting on my student portal, so I cannot register courses." },
  // Suggestion
  { student: "accounting_ade", category: "suggestions", subject: "Record weekend tutorials", description: "It would be good if weekend tutorials were recorded and uploaded so students who work on Saturdays can watch later." },
  // Sensitive welfare concern
  { student: "safe_space", category: "welfare", subject: "Harassment at study centre", description: "A man who says he is a staff member keeps harassing female students after evening tutorials at the study centre. Several of us feel unsafe walking out." },
  // Course materials
  { student: "biz_student", category: "materials", subject: "BUS 105 course material not available", description: "The BUS 105 course material for this semester has not been distributed at the study centre or uploaded online. The exam is in four weeks." },
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production.");
  const existing = await one<{ n: number }>(pool(), `select count(*)::int as n from students`);
  if (existing!.n > 0) throw new Error("Database already contains students. Run `npm run db:reset` first (development only).");

  const passwords: Record<string, string> = {};
  const makeAdmin = async (email: string, displayName: string, role: AdminContext["role"]): Promise<AdminContext> => {
    const password = process.env.SEED_ADMIN_PASSWORD ?? `Demo-${randomBytes(6).toString("base64url")}-7`;
    passwords[email] = password;
    const res = await createAdminUser(pool(), { email, displayName, role, password, mustChangePassword: false }, null);
    if (!res.ok) throw new Error(`Could not create ${email}`);
    return { id: res.id, role, display_name: displayName };
  };
  const chair = await makeAdmin("union.admin@demo.local", "Demo Union Administrator", "union_admin");
  const officer = await makeAdmin("case.officer@demo.local", "Demo Case Officer", "case_officer");
  await makeAdmin("oversight@demo.local", "Demo Oversight Officer", "oversight_officer");

  const students = new Map<string, string>();
  for (const name of new Set(COMPLAINTS.map((c) => c.student))) {
    const res = await registerStudent({ username: name });
    if (!res.ok) throw new Error(`Could not create student ${name}`);
    students.set(name, res.studentId);
  }
  const categoryIds = new Map((await pool().query<{ slug: string; id: number }>(`select slug, id from issue_categories`)).rows.map((r) => [r.slug, r.id]));

  for (const [i, c] of COMPLAINTS.entries()) {
    const res = await submitComplaint(students.get(c.student)!, { categoryId: categoryIds.get(c.category)!, subject: c.subject, description: c.description }, `seed-client-${i}`);
    if (!res.ok) throw new Error(`Seed complaint failed: ${res.error}`);
  }
  // Spread submission dates over the past weeks for realistic timelines.
  await pool().query(`update complaints set created_at = created_at - (random() * interval '20 days')`);

  const issueOf = async (subject: string) =>
    (await one<{ consolidated_issue_id: string | null }>(pool(), `select consolidated_issue_id from complaints where subject = $1`, [subject]))?.consolidated_issue_id ?? null;

  const lms = await issueOf("LMS portal not loading");
  if (lms) {
    await issues.assignOfficer(chair, lms, officer.id);
    await issues.changeStatus(officer, lms, "in_progress", null);
    await issues.publishUpdate(chair, lms, { message: "The ICT unit has confirmed a server fault affecting the LMS and is working on it. We will post another update here.", visibility: "reporters" });
    await issues.setPublicVisibility(chair, lms, { visible: true, publicTitle: "LMS portal not loading", publicSummary: "Students report that the LMS portal has not loaded since Monday, affecting access to course materials and assignment submission." });
    await issues.publishUpdate(chair, lms, { message: "The ICT unit is restoring the LMS server. Assignment deadlines this week will be reviewed.", visibility: "public" });
    await issues.addNote(officer, lms, "ICT contact says hardware replacement is pending procurement approval.", "internal");
  }
  const acc = await issueOf("ACC 201 result not uploaded");
  if (acc) {
    await issues.assignOfficer(chair, acc, officer.id);
    await issues.setDeadline(chair, acc, new Date(Date.now() + 10 * 86400_000), null);
    // Simulate a confirmed date that has since passed -> shows as overdue.
    await pool().query(`update consolidated_issues set expected_resolution_at = now() - interval '2 days' where id = $1`, [acc]);
  }
  const clash = await issueOf("GST 102 and ECO 201 exams clash");
  if (clash) {
    await issues.escalateIssue(chair, clash, "Only the Examinations Office can change the timetable.");
    await issues.addNote(chair, clash, "Raised informally with the Exams Officer on Tuesday.", "oversight");
  }
  const fees = await issueOf("Remita fee payment not reflecting");
  if (fees) {
    await issues.changeStatus(chair, fees, "resolved", "The Bursary has reconciled the delayed Remita payments. Please check your portal; if your payment still does not show, request a review here.");
  }
  const power = await issueOf("No power at Yaba study centre");
  if (power) await issues.changeStatus(chair, power, "awaiting_external_action", null);

  const summary = await one<{ issues: number; reviews: number; complaints: number }>(
    pool(),
    `select (select count(*)::int from consolidated_issues) as issues,
            (select count(*)::int from ai_match_reviews where review_status = 'pending') as reviews,
            (select count(*)::int from complaints) as complaints`,
  );
  console.log(`\nSeeded ${summary!.complaints} complaints into ${summary!.issues} issues (${summary!.reviews} awaiting match review).`);
  console.log(`\nDemo student usernames: ${[...students.keys()].join(", ")}`);
  console.log("\nDemo staff accounts (local only, sign in at /admin/login):");
  for (const [email, pw] of Object.entries(passwords)) console.log(`  ${email}  ${pw}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
