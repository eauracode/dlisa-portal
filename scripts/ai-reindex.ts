import "./load-env";
import { closePool, one, pool, rows, withTransaction } from "../src/lib/db";
import { analyzeComplaint, getAIProviders } from "../src/lib/ai";
import type { CategoryOption } from "../src/lib/ai/types";
import { refreshIssueAggregates } from "../src/lib/services/consolidation";

/**
 * Re-analyses every complaint with the CURRENTLY configured classifier and embedding model,
 * then rebuilds each issue's matching vector and attributes. Run after changing
 * AI_EMBEDDING_PROVIDER / model (vectors from different models are never compared).
 * Non-destructive: groupings, statuses and complaint text are not changed.
 *   npm run ai:reindex
 */
async function main() {
  const { embedder } = getAIProviders();
  console.log(`Re-indexing with ${embedder.provider}/${embedder.model} …`);
  const categories = await rows<CategoryOption>(pool(), `select id, slug, name, description from issue_categories`);
  const complaints = await rows<{ id: string; subject: string; description: string; slug: string }>(
    pool(),
    `select c.id, c.subject, c.description, cat.slug from complaints c join issue_categories cat on cat.id = c.category_id
      where exists (select 1 from complaint_analyses a where a.complaint_id = c.id) order by c.created_at`,
  );
  let done = 0;
  for (const c of complaints) {
    const a = await analyzeComplaint({ subject: c.subject, description: c.description, selectedCategorySlug: c.slug, categories });
    const k = a.classification;
    await pool().query(
      `update complaint_analyses set classifier_provider = $2, classifier_model = $3, embedding_provider = $4, embedding_model = $5,
              embedding = $6, underlying_problem = $7, problem_aspect = $8, academic_activity = $9, time_reference = $10,
              affected_group = $11, sensitivity = $12, urgency_indicators = $13, summary = $14, course_codes = $15,
              problem_type = $16, severity = $17, safety_flag = $18, academic_impact = $19
        where complaint_id = $1`,
      [c.id, a.classifierProvider, a.classifierModel, a.embeddingProvider, a.embeddingModel, a.embedding, k.underlyingProblem, k.problemAspect,
        k.academicActivity, k.timeReference, k.affectedGroup, k.sensitivity, k.urgencyIndicators, k.summary, k.courseCodes, k.problemType,
        k.severity, k.safetyFlag, k.academicImpact],
    );
    done++;
  }
  const issues = await rows<{ id: string }>(pool(), `select id from consolidated_issues where status <> 'merged'`);
  for (const { id } of issues) {
    await withTransaction(async (tx) => {
      // Attributes come from the issue's first report; the vector is rebuilt from all reports.
      const first = await one<{ problem_aspect: string | null; academic_activity: string | null; affected_group: string | null; problem_type: string | null }>(
        tx,
        `select a.problem_aspect, a.academic_activity, a.affected_group, a.problem_type from complaint_analyses a
           join complaints c on c.id = a.complaint_id where c.consolidated_issue_id = $1 order by c.created_at limit 1`,
        [id],
      );
      await tx.query(
        `update consolidated_issues set embedding = null, embedding_model = $2,
                problem_aspect = coalesce($3, problem_aspect), academic_activity = coalesce($4, academic_activity),
                affected_group = coalesce($5, affected_group), problem_type = coalesce($6, problem_type)
          where id = $1`,
        [id, embedder.model, first?.problem_aspect ?? null, first?.academic_activity ?? null, first?.affected_group ?? null, first?.problem_type ?? null],
      );
      await refreshIssueAggregates(tx, id);
    });
  }
  console.log(`Re-indexed ${done} complaints and ${issues.length} issues.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
