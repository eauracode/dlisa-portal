import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/current";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { Alert, Card, CardContent, PageHeader } from "@/components/ui";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Account" };

export default async function AdminAccountPage({ searchParams }: { searchParams: Promise<{ first?: string }> }) {
  const admin = await requireAdmin(undefined, { allowPasswordChange: true });
  const { first } = await searchParams;
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10">
      {!admin.must_change_password && (
        <Link href="/admin" className="text-sm text-link hover:underline">
          ← Back to dashboard
        </Link>
      )}
      <PageHeader title="Account" description={`${admin.display_name} · ${admin.authentication_reference} · ${ROLE_LABELS[admin.role]}`} />
      {(first || admin.must_change_password) && (
        <Alert tone="warning" className="mb-4">
          Please replace your temporary password before continuing.
        </Alert>
      )}
      <Card>
        <CardContent className="py-6">
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </main>
  );
}
