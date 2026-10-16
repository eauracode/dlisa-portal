import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { listComplaints } from "@/lib/services/admin/complaints";
import { COMPLAINT_STATUS_LABELS, formatDateTime, MATCH_STATUS_LABELS } from "@/lib/format";
import { ComplaintStatusBadge, MatchStatusBadge } from "@/components/status";
import { Badge, buttonVariants, EmptyState, Input, Label, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { Flash } from "@/components/flash";
import { DepartmentFilterSelect, endOfDay, filterOptions, parseDate, parseDepartment } from "../filters";

export const metadata: Metadata = { title: "Submissions" };

export default async function AdminComplaintsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const { categories } = await filterOptions();
  const list = await listComplaints(pool(), admin, {
    q: sp.q?.slice(0, 100),
    status: sp.status || undefined,
    matchStatus: sp.match || undefined,
    categoryId: sp.category ? Number(sp.category) || undefined : undefined,
    department: parseDepartment(sp.department),
    from: parseDate(sp.from),
    to: endOfDay(sp.to),
  });

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <PageHeader
        title="Individual submissions"
        description="Original student submissions. Duplicates are never deleted; each stays linked to its consolidated issue. Reporters are shown as pseudonymous codes."
      />
      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-7 lg:items-end">
        <div className="sm:col-span-3 lg:col-span-2">
          <Label htmlFor="q">Search</Label>
          <Input id="q" name="q" defaultValue={sp.q} placeholder="Subject or description" />
        </div>
        <div>
          <Label htmlFor="status">Status</Label>
          <Select id="status" name="status" defaultValue={sp.status ?? ""}>
            <option value="">All</option>
            {Object.entries(COMPLAINT_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="match">Grouping</Label>
          <Select id="match" name="match" defaultValue={sp.match ?? ""}>
            <option value="">All</option>
            {Object.entries(MATCH_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="category">Category</Label>
          <Select id="category" name="category" defaultValue={sp.category ?? ""}>
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="department">Department</Label>
          <DepartmentFilterSelect value={sp.department} />
        </div>
        <div className="flex gap-2">
          <button type="submit" className={buttonVariants({ variant: "ghost" })}>
            Apply
          </button>
          <a href="?" className={buttonVariants({ variant: "ghost" })}>
            Reset
          </a>
        </div>
      </form>

      {list.length === 0 ? (
        <EmptyState title="No submissions match these filters." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Submission</Th>
              <Th>Status</Th>
              <Th>Grouping</Th>
              <Th>Consolidated issue</Th>
              <Th>Submitted</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="hover:bg-brand-50/50">
                <Td className="max-w-sm">
                  <Link href={`/admin/complaints/${c.id}`} className="font-medium hover:underline">
                    {c.subject}
                  </Link>
                  <p className="text-xs text-muted">
                    {c.category} · {c.reporter}
                    {c.department && <Badge className="ml-1.5">{c.department}</Badge>}
                  </p>
                </Td>
                <Td>
                  <ComplaintStatusBadge status={c.status} />
                </Td>
                <Td>
                  <MatchStatusBadge status={c.match_status} />
                </Td>
                <Td className="max-w-xs text-sm">
                  {c.consolidated_issue_id ? (
                    <Link href={`/admin/issues/${c.consolidated_issue_id}`} className="text-link hover:underline">
                      {c.issue_title}
                    </Link>
                  ) : (
                    <span className="text-muted">Not grouped yet</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted">{formatDateTime(c.created_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
