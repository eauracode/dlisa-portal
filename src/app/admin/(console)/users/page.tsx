import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { listAdmins } from "@/lib/services/admin/management";
import { formatDateTime } from "@/lib/format";
import { ADMIN_ROLES } from "@/lib/validation";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { Flash } from "@/components/flash";
import { createAdminAction, updateAdminAction } from "../../actions";

export const metadata: Metadata = { title: "Staff accounts" };

const ROLE_SUMMARY: Record<string, string> = {
  union_admin: "Full management: accounts, all complaints, deadlines, publishing, settings, audit.",
  case_officer: "Works on assigned issues: statuses, notes, updates; proposes deadlines and escalations.",
  oversight_officer: "School management: escalated issues only, oversight notes, institutional responses, reports.",
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const admin = await requireAdmin("admins.manage");
  const sp = await searchParams;
  const admins = await listAdmins(pool(), admin);
  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <PageHeader title="Staff accounts" description="Create accounts for Association staff and school management oversight officers. Deactivating an account signs it out immediately." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              <Th>Change</Th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id}>
                <Td>
                  <p className="font-medium">{a.display_name}</p>
                  <p className="text-xs text-muted">{a.authentication_reference}</p>
                </Td>
                <Td className="text-sm">{ROLE_LABELS[a.role]}</Td>
                <Td>
                  {a.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                  {a.must_change_password && a.active && <Badge tone="warning" className="ml-1">Temp. password</Badge>}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">{a.last_login_at ? formatDateTime(a.last_login_at) : "Never"}</Td>
                <Td>
                  <form action={updateAdminAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="adminId" value={a.id} />
                    <Select name="role" defaultValue={a.role} aria-label={`Role for ${a.display_name}`} className="min-h-8 w-auto py-1 text-xs">
                      {ADMIN_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                    <Select name="active" defaultValue={String(a.active)} aria-label={`Status for ${a.display_name}`} className="min-h-8 w-auto py-1 text-xs">
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </Select>
                    <Button size="sm" variant="secondary">
                      Save
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Card>
          <CardHeader>
            <CardTitle>Add a staff account</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createAdminAction} className="space-y-3">
              <div>
                <Label htmlFor="displayName">Name</Label>
                <Input id="displayName" name="displayName" required maxLength={80} />
              </div>
              <div>
                <Label htmlFor="email">Email (used to sign in)</Label>
                <Input id="email" name="email" type="email" required autoComplete="off" />
              </div>
              <div>
                <Label htmlFor="role">Role</Label>
                <Select id="role" name="role" defaultValue="case_officer">
                  {ADMIN_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="password">Temporary password</Label>
                <Input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
                <p className="mt-1 text-xs text-muted">At least 12 characters with letters and numbers. They must change it at first sign-in.</p>
              </div>
              <Button>Create account</Button>
            </form>
            <dl className="mt-6 space-y-2 text-xs text-muted">
              {Object.entries(ROLE_SUMMARY).map(([r, s]) => (
                <div key={r}>
                  <dt className="font-medium text-foreground">{ROLE_LABELS[r as keyof typeof ROLE_LABELS]}</dt>
                  <dd>{s}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
