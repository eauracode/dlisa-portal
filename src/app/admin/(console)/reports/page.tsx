import type { Metadata } from "next";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { getReports } from "@/lib/services/admin/overview";
import { Card, CardContent, CardHeader, CardTitle, PageHeader, StatCard, Table, Td, Th } from "@/components/ui";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const admin = await requireAdmin("reports.view");
  const r = await getReports(pool(), admin);
  const maxMonthly = Math.max(1, ...r.monthly.map((m) => m.submissions));

  return (
    <>
      <PageHeader
        title="Reports and trends"
        description={admin.role === "oversight_officer" ? "Figures for issues escalated to school management." : "Figures across all issues and submissions."}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Issues with a confirmed date" value={r.deadlines.with_deadline} />
        <StatCard label="Resolved by the date" value={r.deadlines.met} tone="success" />
        <StatCard label="Resolved after the date" value={r.deadlines.missed} tone={r.deadlines.missed ? "warning" : "neutral"} />
        <StatCard label="Currently overdue" value={r.deadlines.open_overdue} tone={r.deadlines.open_overdue ? "danger" : "neutral"} />
      </div>

      <section className="mb-8">
        <h2 className="mb-2 font-semibold">By category</h2>
        <Table>
          <thead>
            <tr>
              <Th>Category</Th>
              <Th className="text-right">Issues</Th>
              <Th className="text-right">Submissions</Th>
              <Th className="text-right">Open</Th>
              <Th className="text-right">Resolved</Th>
              <Th className="text-right">Avg. days to resolve</Th>
            </tr>
          </thead>
          <tbody>
            {r.byCategory.map((c) => (
              <tr key={c.category}>
                <Td>{c.category}</Td>
                <Td className="text-right tabular-nums">{c.issues}</Td>
                <Td className="text-right tabular-nums">{c.submissions}</Td>
                <Td className="text-right tabular-nums">{c.open}</Td>
                <Td className="text-right tabular-nums">{c.resolved}</Td>
                <Td className="text-right tabular-nums">{c.avg_days_to_resolve ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Submissions per month (last 12 months)</CardTitle>
          </CardHeader>
          <CardContent>
            {r.monthly.length === 0 ? (
              <p className="text-sm text-muted">No submissions yet.</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Monthly submissions and distinct students</caption>
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="pb-1 font-medium">Month</th>
                    <th scope="col" className="pb-1 font-medium">Submissions</th>
                    <th scope="col" className="pb-1 text-right font-medium">Students</th>
                  </tr>
                </thead>
                <tbody>
                  {r.monthly.map((m) => (
                    <tr key={m.month}>
                      <td className="py-1 pr-3 tabular-nums">{m.month}</td>
                      <td className="w-full py-1">
                        <div className="flex items-center gap-2">
                          <div className="h-2 rounded-sm bg-brand-500" style={{ width: `${(m.submissions / maxMonthly) * 100}%`, minWidth: 2 }} aria-hidden />
                          <span className="tabular-nums">{m.submissions}</span>
                        </div>
                      </td>
                      <td className="py-1 text-right tabular-nums">{m.distinct_students}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        {r.matching.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>How submissions were grouped</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="pb-1 font-medium">Method</th>
                    <th scope="col" className="pb-1 text-right font-medium">Submissions</th>
                    <th scope="col" className="pb-1 text-right font-medium">Avg. confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {r.matching.map((m) => (
                    <tr key={m.match_method}>
                      <td className="py-1">{m.match_method.replace("_", " ")}</td>
                      <td className="py-1 text-right tabular-nums">{m.n}</td>
                      <td className="py-1 text-right tabular-nums">{m.avg_confidence ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted">A high share of corrections (manual, split, merge) suggests the matching thresholds need tuning in Settings.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
