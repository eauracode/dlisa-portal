import type { Metadata } from "next";
import { getCurrentStudent } from "@/lib/auth/current";
import { listActiveCategories } from "@/lib/services/student-complaints";
import { Intake } from "./intake";

export const metadata: Metadata = { title: "Submit a complaint or suggestion" };

export default async function NewComplaintPage() {
  // Open to everyone: signed-out students pick or enter a username as part of the same flow.
  const [student, categories] = await Promise.all([getCurrentStudent(), listActiveCategories()]);
  return (
    <div className="space-y-4">
      <Intake categories={categories} signedInAs={student?.username ?? null} missingDepartment={!!student && !student.department_code} />
      <p className="mx-auto max-w-[640px] text-xs text-[var(--muted)]">
        If you or someone else is in immediate danger, contact campus security or emergency services directly. This portal is not monitored around the clock.
      </p>
    </div>
  );
}
