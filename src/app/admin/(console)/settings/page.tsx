import type { Metadata } from "next";
import { pool, rows } from "@/lib/db";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/auth/current";
import { listAllCategories } from "@/lib/services/admin/management";
import { getMatchingConfig, getPriorityConfig } from "@/lib/services/settings";
import { getAIProviders } from "@/lib/ai";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, PageHeader, Table, Td, Th } from "@/components/ui";
import { Flash } from "@/components/flash";
import { runJobsAction, saveCategoryAction, saveMatchingSettingsAction, savePrioritySettingsAction } from "../../actions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdmin("settings.manage");
  const sp = await searchParams;
  const [categories, matching, priority, jobs] = await Promise.all([
    listAllCategories(pool()),
    getMatchingConfig(pool()),
    getPriorityConfig(pool()),
    rows<{ status: string; n: number }>(pool(), `select status, count(*)::int as n from match_jobs group by status`),
  ]);
  const ai = getAIProviders();
  const e = env();

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <PageHeader title="Settings" description="Categories, matching thresholds, priority rules and the background matching queue. Changes are audit-logged." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Matching thresholds</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveMatchingSettingsAction} className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="autoThreshold">Automatic grouping at or above</Label>
                <Input id="autoThreshold" name="autoThreshold" type="number" step="0.01" min="0" max="1" defaultValue={matching.autoThreshold} />
              </div>
              <div>
                <Label htmlFor="reviewThreshold">Send to review at or above</Label>
                <Input id="reviewThreshold" name="reviewThreshold" type="number" step="0.01" min="0" max="1" defaultValue={matching.reviewThreshold} />
              </div>
              <div>
                <Label htmlFor="ambiguityMargin">Ambiguity margin</Label>
                <Input id="ambiguityMargin" name="ambiguityMargin" type="number" step="0.01" min="0" max="0.5" defaultValue={matching.ambiguityMargin} />
              </div>
              <div>
                <Label htmlFor="resolvedLookbackDays">Compare with issues resolved in the last (days)</Label>
                <Input id="resolvedLookbackDays" name="resolvedLookbackDays" type="number" min="0" max="730" defaultValue={matching.resolvedLookbackDays} />
              </div>
              <p className="text-xs text-muted sm:col-span-2">
                Scores combine text similarity with category, problem type and course signals. They are tuning parameters for the configured
                embedding model, not probabilities. Different courses or academic periods are never grouped automatically.
              </p>
              <div className="sm:col-span-2">
                <Button size="sm">Save thresholds</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Priority rules</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={savePrioritySettingsAction} className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="elevated">Elevated from score</Label>
                <Input id="elevated" name="elevated" type="number" min="0" max="100" defaultValue={priority.thresholds.elevated} />
              </div>
              <div>
                <Label htmlFor="high">High from score</Label>
                <Input id="high" name="high" type="number" min="0" max="100" defaultValue={priority.thresholds.high} />
              </div>
              <div>
                <Label htmlFor="critical">Critical from score</Label>
                <Input id="critical" name="critical" type="number" min="0" max="100" defaultValue={priority.thresholds.critical} />
              </div>
              <div>
                <Label htmlFor="overduePoints">Points when overdue</Label>
                <Input id="overduePoints" name="overduePoints" type="number" min="0" max="100" defaultValue={priority.overduePoints} />
              </div>
              <div>
                <Label htmlFor="academicImpactPoints">Points for academic impact</Label>
                <Input id="academicImpactPoints" name="academicImpactPoints" type="number" min="0" max="100" defaultValue={priority.academicImpactPoints} />
              </div>
              <p className="text-xs text-muted sm:col-span-3">
                Severity points: routine {priority.severityPoints.routine}, moderate {priority.severityPoints.moderate}, serious {priority.severityPoints.serious}, urgent{" "}
                {priority.severityPoints.urgent}. Distinct students add up to {priority.reporterPointsCap} points (log-scaled); repeat submissions by the same student add at most{" "}
                {priority.repeatSubmissionCap}. Safety concerns are at least High.
              </p>
              <div className="sm:col-span-3">
                <Button size="sm">Save priority rules</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI provider and matching queue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Classifier: <Badge>{ai.classifier.provider}</Badge> {ai.classifier.model}
              <br />
              Embeddings: <Badge>{ai.embedder.provider}</Badge> {ai.embedder.model}
            </p>
            {(e.AI_CLASSIFIER_PROVIDER === "local" || e.AI_EMBEDDING_PROVIDER === "local") && (
              <p className="text-xs text-muted">
                The local provider keeps all text on this server but matches on shared wording rather than meaning. Configure an embedding provider for semantic matching (see README).
              </p>
            )}
            <p>Jobs: {jobs.length ? jobs.map((j) => `${j.status} ${j.n}`).join(" · ") : "none"}</p>
            <form action={runJobsAction}>
              <Button size="sm" variant="secondary">
                Process queue now
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <section className="mt-8">
        <h2 className="mb-2 font-semibold">Categories</h2>
        <Table>
          <thead>
            <tr>
              <Th>Name and description</Th>
              <Th>Order</Th>
              <Th>Academic</Th>
              <Th>Active</Th>
              <Th>Used</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <Td colSpan={6} className="p-0">
                  <form action={saveCategoryAction} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_80px_80px_80px_60px_auto]">
                    <input type="hidden" name="categoryId" value={c.id} />
                    <div className="space-y-1">
                      <Input name="name" defaultValue={c.name} aria-label="Name" />
                      <Input name="description" defaultValue={c.description} aria-label="Description" className="text-xs" />
                    </div>
                    <Input name="sortOrder" type="number" defaultValue={c.sort_order} aria-label="Order" />
                    <input type="checkbox" name="academic" defaultChecked={c.academic} aria-label="Academic" className="h-4 w-4 accent-brand-600" />
                    <input type="checkbox" name="active" defaultChecked={c.active} aria-label="Active" className="h-4 w-4 accent-brand-600" />
                    <span className="text-xs text-muted tabular-nums">{c.complaint_count}</span>
                    <Button size="sm" variant="secondary">
                      Save
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
            <tr>
              <Td colSpan={6} className="p-0">
                <form action={saveCategoryAction} className="grid items-center gap-2 bg-brand-50/40 px-3 py-2 sm:grid-cols-[1fr_80px_80px_80px_60px_auto]">
                  <div className="space-y-1">
                    <Input name="name" placeholder="New category name" aria-label="New category name" required />
                    <Input name="description" placeholder="Description" aria-label="New category description" className="text-xs" />
                  </div>
                  <Input name="sortOrder" type="number" defaultValue={200} aria-label="Order" />
                  <input type="checkbox" name="academic" aria-label="Academic" className="h-4 w-4 accent-brand-600" />
                  <input type="checkbox" name="active" defaultChecked aria-label="Active" className="h-4 w-4 accent-brand-600" />
                  <span />
                  <Button size="sm">Add</Button>
                </form>
              </Td>
            </tr>
          </tbody>
        </Table>
        <p className="mt-2 text-xs text-muted">Deactivate a category instead of deleting it so existing complaints keep their history.</p>
      </section>
    </>
  );
}
