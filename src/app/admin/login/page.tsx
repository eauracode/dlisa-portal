import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/current";
import { brand } from "@/config/brand";
import { Card, CardContent } from "@/components/ui";
import { AdminLoginForm } from "./login-form";

export const metadata: Metadata = { title: "Staff sign in" };

export default async function AdminLoginPage() {
  if (await getCurrentAdmin()) redirect("/admin");
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6">
        <p className="text-xs text-muted">{brand.portalName}</p>
        <div>
          <h1 className="text-lg font-semibold">Staff sign in</h1>
          <p className="text-xs text-muted">DLI Student Union and authorised school management</p>
        </div>
      </div>
      <Card>
        <CardContent className="py-6">
          <AdminLoginForm />
        </CardContent>
      </Card>
      <p className="mt-4 text-xs text-muted">Accounts are created by a Union Administrator. All administrative actions are logged.</p>
    </main>
  );
}
