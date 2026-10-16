import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentStudent } from "@/lib/auth/current";
import { AccessForms } from "./access-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function StudentAccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentStudent()) redirect("/student/dashboard");
  return (
    <div className="-mx-4 -mb-12 -mt-6 bg-[var(--sunken)] px-4 py-10 sm:-mx-6 sm:px-6 sm:py-14">
      <div className="mx-auto max-w-[460px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-card sm:p-7">
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="mt-1.5 text-[var(--muted)]">Enter the username you used before. That&apos;s all you need.</p>
        <AccessForms next={next} />
      </div>
    </div>
  );
}
