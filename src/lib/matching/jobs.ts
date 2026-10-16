import type { PoolClient } from "pg";
import { one, pool, rows, withTransaction, type Db } from "../db";
import { analyzeComplaint, AIProviderError, getAIProviders, withTimeout, type ComplaintAnalysis } from "../ai";
import type { CategoryOption } from "../ai/types";
import { LocalVerifier, type ProblemRepresentation, type Verification } from "../ai/verifier";
import { COPY } from "@/config/app";
import { addComplaintEvent, createIssueFromComplaint, linkComplaintToIssue, recalculatePriority } from "../services/consolidation";
import { getMatchingConfig, getPriorityConfig } from "../services/settings";
import { findInstantAnswers, recordInstantAnswers, type InstantAnswerMatch } from "../services/instant-answers";
import { applyVerification, decideMatch, MATCH_ALGORITHM_VERSION, type MatchCandidate, type MatchDecision, type MatchingConfig } from "./engine";

export const JOB_POLICY = {
  maxAttempts: 6,
  // Back-off after each failed attempt (minutes), indexed by attempt number.
  backoffMinutes: [1, 5, 15, 60, 180, 720],
  staleLockMinutes: 5,
};

/** Idempotent: a complaint has at most one matching job (unique constraint). */
export async function enqueueMatchJob(db: Db, complaintId: string) {
  await db.query(
    `insert into match_jobs (complaint_id) values ($1)
     on conflict (complaint_id) do update
       set status = 'pending', next_attempt_at = now(), updated_at = now()
       where match_jobs.status in ('failed', 'cancelled')`,
    [complaintId],
  );
}

export type JobOutcome = "auto" | "review" | "new" | "skipped" | "retry" | "failed";

/** Atomically claim a job so concurrent workers never process the same complaint. */
async function claimJob(complaintId: string): Promise<{ attempts: number } | null> {
  return one<{ attempts: number }>(
    pool(),
    `update match_jobs
        set status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
      where complaint_id = $1
        and (status = 'pending' or (status = 'processing' and locked_at < now() - make_interval(mins => $2)))
      returning attempts`,
    [complaintId, JOB_POLICY.staleLockMinutes],
  );
}

async function recordFailure(complaintId: string, attempts: number, err: unknown): Promise<JobOutcome> {
  const retryable = !(err instanceof AIProviderError) || err.retryable;
  const exhausted = !retryable || attempts >= JOB_POLICY.maxAttempts;
  // Only the error class/message is stored; provider messages never include complaint text.
  const message = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "Unknown error";
  const delay = JOB_POLICY.backoffMinutes[Math.min(attempts - 1, JOB_POLICY.backoffMinutes.length - 1)];
  console.error("Matching job failed", { complaintId, attempts, exhausted, error: message });
  await withTransaction(async (tx) => {
    await tx.query(
      `update match_jobs
          set status = $2, last_error = $3, locked_at = null, updated_at = now(),
              next_attempt_at = now() + make_interval(mins => $4)
        where complaint_id = $1`,
      [complaintId, exhausted ? "failed" : "pending", message, delay],
    );
    if (exhausted) {
      // Still safe: the complaint is stored and appears in the admin "needs grouping" list.
      await tx.query(`update complaints set match_status = 'failed', updated_at = now() where id = $1 and match_status = 'pending'`, [complaintId]);
    }
  });
  return exhausted ? "failed" : "retry";
}

interface CandidateRow {
  id: string;
  status: string;
  category_id: number;
  embedding: number[];
  course_codes: string[];
  academic_period: string | null;
  problem_type: string | null;
  problem_aspect: string | null;
  academic_activity: string | null;
  affected_group: string | null;
  sensitive: boolean;
  title: string;
  summary: string;
  created_at: Date;
}

async function loadCandidates(db: Db, embeddingModel: string, config: MatchingConfig): Promise<CandidateRow[]> {
  // Open issues plus recently resolved ones (recurrence check). The candidate set is small
  // (open issues), so similarity is computed in the application; see README for pgvector.
  return rows<CandidateRow>(
    db,
    `select id, status, category_id, embedding, course_codes, academic_period, problem_type, problem_aspect,
            academic_activity, affected_group, sensitive, title, summary, created_at
       from consolidated_issues
      where embedding is not null and embedding_model = $1 and status <> 'merged'
        and (status not in ('resolved', 'closed') or coalesce(resolved_at, updated_at) > now() - make_interval(days => $2))`,
    [embeddingModel, config.resolvedLookbackDays],
  );
}

const toCandidate = (r: CandidateRow): MatchCandidate => ({
  issueId: r.id,
  status: r.status,
  categoryId: r.category_id,
  embedding: r.embedding,
  courseCodes: r.course_codes,
  academicPeriod: r.academic_period,
  problemType: r.problem_type,
  problemAspect: r.problem_aspect,
  academicActivity: r.academic_activity,
  affectedGroup: r.affected_group,
  sensitive: r.sensitive,
});

const toRepresentation = (r: CandidateRow): ProblemRepresentation => ({
  summary: r.summary || r.title,
  underlyingProblem: null,
  problemType: r.problem_type,
  problemAspect: r.problem_aspect,
  academicActivity: r.academic_activity,
  courseCodes: r.course_codes,
  academicPeriod: r.academic_period,
  timeReference: null,
  affectedGroup: r.affected_group,
});

/**
 * The AI Issue Intelligence pipeline for one complaint:
 * classify → embed → find similar issues → score with compatibility checks → verify the
 * proposed match → group / flag for review / create issue → update counts and priority →
 * record provenance. Safe to run repeatedly and concurrently (idempotent, locked).
 */
export async function processMatchJob(complaintId: string): Promise<JobOutcome> {
  const job = await claimJob(complaintId);
  if (!job) return "skipped";

  const complaint = await one<{ subject: string; description: string; category_id: number; category_slug: string; consolidated_issue_id: string | null; match_status: string }>(
    pool(),
    `select c.subject, c.description, c.category_id, cat.slug as category_slug, c.consolidated_issue_id, c.match_status
       from complaints c join issue_categories cat on cat.id = c.category_id where c.id = $1`,
    [complaintId],
  );
  if (!complaint || complaint.consolidated_issue_id || complaint.match_status !== "pending") {
    // Already grouped manually by staff, or otherwise handled.
    await pool().query(`update match_jobs set status = 'cancelled', locked_at = null, updated_at = now() where complaint_id = $1`, [complaintId]);
    return "skipped";
  }

  const categories = await rows<CategoryOption>(pool(), `select id, slug, name, description from issue_categories where active order by sort_order`);
  const { verifier, timeoutMs } = getAIProviders();

  // --- Network-bound work happens outside any transaction (no locks held). ---
  let analysis: ComplaintAnalysis;
  let preliminary: MatchDecision;
  let verification: Verification | null = null;
  let verifiedIssueId: string | null = null;
  let answers: InstantAnswerMatch[] = [];
  const config = await getMatchingConfig(pool());
  try {
    analysis = await analyzeComplaint({
      subject: complaint.subject,
      description: complaint.description,
      selectedCategorySlug: complaint.category_slug,
      categories,
    });
    const c = analysis.classification;
    const subjectRep: ProblemRepresentation = {
      summary: c.summary,
      underlyingProblem: c.underlyingProblem,
      problemType: c.problemType,
      problemAspect: c.problemAspect,
      academicActivity: c.academicActivity,
      courseCodes: c.courseCodes,
      academicPeriod: c.academicPeriod,
      timeReference: c.timeReference,
      affectedGroup: c.affectedGroup,
    };
    const candidates = await loadCandidates(pool(), analysis.embeddingModel, config);
    preliminary = decideMatch(subjectFor(analysis, categories, complaint.category_id), candidates.map(toCandidate), config, analysis.embeddingModel);
    if (preliminary.kind !== "new") {
      const target = candidates.find((r) => r.id === preliminary.issueId)!;
      verification = await withTimeout(timeoutMs, (signal) => verifier.verify(subjectRep, toRepresentation(target), signal));
      verifiedIssueId = target.id;
    }
  } catch (err) {
    return recordFailure(complaintId, job.attempts, err);
  }
  try {
    // Earlier answers to the same question. Optional: a failure here never fails matching.
    const c = analysis.classification;
    answers = await findInstantAnswers(pool(), {
      embedding: analysis.embedding,
      embeddingModel: analysis.embeddingModel,
      courseCodes: c.courseCodes,
      sensitive: c.sensitivity !== "none" || c.safetyFlag,
    });
  } catch (err) {
    console.error("Instant answer lookup failed", { complaintId, error: (err as Error).name });
  }

  try {
    return await withTransaction(async (tx) => {
      // Serialise consolidation decisions so simultaneous reports of a brand-new problem do
      // not each create their own issue. Held only for fast, local work.
      await tx.query(`select pg_advisory_xact_lock(hashtext('dli:consolidation'))`);
      const fresh = await one<{ consolidated_issue_id: string | null; match_status: string }>(
        tx,
        `select consolidated_issue_id, match_status from complaints where id = $1 for update`,
        [complaintId],
      );
      if (!fresh || fresh.consolidated_issue_id || fresh.match_status !== "pending") {
        await tx.query(`update match_jobs set status = 'cancelled', locked_at = null, updated_at = now() where complaint_id = $1`, [complaintId]);
        return "skipped" as const;
      }

      const c = analysis.classification;
      const inferredCategoryId = categories.find((cat) => cat.slug === c.categorySlug)?.id ?? null;
      await saveAnalysis(tx, complaintId, analysis, inferredCategoryId);

      // Re-decide against the current set of issues: another submission may have created
      // a matching issue while this one was being analysed.
      const candidates = await loadCandidates(tx, analysis.embeddingModel, config);
      let decision = decideMatch(subjectFor(analysis, categories, complaint.category_id), candidates.map(toCandidate), config, analysis.embeddingModel);
      if (decision.kind !== "new") {
        const target = candidates.find((r) => r.id === decision.issueId)!;
        const v =
          decision.issueId === verifiedIssueId && verification
            ? verification
            : await new LocalVerifier().verify(
                { summary: c.summary, underlyingProblem: c.underlyingProblem, problemType: c.problemType, problemAspect: c.problemAspect, academicActivity: c.academicActivity, courseCodes: c.courseCodes, academicPeriod: c.academicPeriod, timeReference: c.timeReference, affectedGroup: c.affectedGroup },
                toRepresentation(target),
              );
        decision = applyVerification(decision, v, decision.issueId === verifiedIssueId ? verifier.authoritative : false);
      }
      const modelVersion = `${analysis.classifierProvider}:${analysis.classifierModel}|${analysis.embeddingProvider}:${analysis.embeddingModel}|${verifier.provider}:${verifier.model}`;
      const actor = { type: "system" as const };

      let outcome: JobOutcome;
      let issueId: string | null = decision.kind === "new" ? null : decision.issueId;
      if (decision.kind === "auto") {
        await linkComplaintToIssue(tx, { complaintId, issueId: decision.issueId, method: "auto", confidence: decision.confidence, modelVersion, actor });
        outcome = "auto";
      } else if (decision.kind === "review") {
        await tx.query(
          `insert into ai_match_reviews (complaint_id, candidate_issue_id, confidence_score, explanation, review_kind, model_version, review_reason)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [complaintId, decision.issueId, decision.confidence, decision.explanation.slice(0, 1000), decision.reviewKind, modelVersion, decision.reason],
        );
        await tx.query(`update complaints set match_status = 'pending_review', updated_at = now() where id = $1`, [complaintId]);
        await addComplaintEvent(tx, { complaintId, actorType: "system", eventType: "awaiting_review", message: COPY.awaitingReview });
        outcome = "review";
      } else {
        issueId = await createIssueFromComplaint(tx, complaintId, actor);
        await linkComplaintToIssue(tx, { complaintId, issueId, method: "new_issue", confidence: decision.bestConfidence, modelVersion, actor });
        outcome = "new";
      }

      // Same transaction as the status change, so the receipt shows the answers as soon as
      // it stops showing "Checking…".
      await recordInstantAnswers(tx, complaintId, answers);

      await tx.query(
        `insert into match_decisions (complaint_id, candidate_issue_id, decision, similarity, confidence, verifier_verdict,
                                      explanation, compatible, conflicts, alternatives, model_version, algorithm_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          complaintId,
          issueId,
          decision.kind,
          decision.similarity,
          decision.kind === "new" ? decision.bestConfidence : decision.confidence,
          decision.kind !== "new" && decision.issueId === verifiedIssueId ? verification?.verdict ?? null : null,
          decision.explanation.slice(0, 1000),
          decision.compatible,
          decision.conflicts,
          JSON.stringify(decision.alternatives),
          modelVersion,
          MATCH_ALGORITHM_VERSION,
        ],
      );
      await tx.query(`update match_jobs set status = 'completed', locked_at = null, last_error = null, updated_at = now() where complaint_id = $1`, [complaintId]);
      return outcome;
    });
  } catch (err) {
    return recordFailure(complaintId, job.attempts, err);
  }
}

function subjectFor(analysis: ComplaintAnalysis, categories: CategoryOption[], fallbackCategoryId: number) {
  const c = analysis.classification;
  return {
    categoryId: categories.find((cat) => cat.slug === c.categorySlug)?.id ?? fallbackCategoryId,
    embedding: analysis.embedding,
    courseCodes: c.courseCodes,
    academicPeriod: c.academicPeriod,
    problemType: c.problemType,
    problemAspect: c.problemAspect,
    academicActivity: c.academicActivity,
    affectedGroup: c.affectedGroup,
    sensitivity: c.sensitivity,
  };
}

async function saveAnalysis(tx: PoolClient, complaintId: string, analysis: ComplaintAnalysis, inferredCategoryId: number | null) {
  const c = analysis.classification;
  await tx.query(
    `insert into complaint_analyses
       (complaint_id, classifier_provider, classifier_model, embedding_provider, embedding_model, inferred_category_id,
        summary_title, summary, course_codes, academic_period, problem_type, severity, academic_impact, safety_flag, embedding,
        underlying_problem, problem_aspect, academic_activity, time_reference, affected_group, sensitivity, urgency_indicators)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     on conflict (complaint_id) do update set
       classifier_provider = excluded.classifier_provider, classifier_model = excluded.classifier_model,
       embedding_provider = excluded.embedding_provider, embedding_model = excluded.embedding_model,
       inferred_category_id = excluded.inferred_category_id, summary_title = excluded.summary_title,
       summary = excluded.summary, course_codes = excluded.course_codes, academic_period = excluded.academic_period,
       problem_type = excluded.problem_type, severity = excluded.severity, academic_impact = excluded.academic_impact,
       safety_flag = excluded.safety_flag, embedding = excluded.embedding, underlying_problem = excluded.underlying_problem,
       problem_aspect = excluded.problem_aspect, academic_activity = excluded.academic_activity,
       time_reference = excluded.time_reference, affected_group = excluded.affected_group,
       sensitivity = excluded.sensitivity, urgency_indicators = excluded.urgency_indicators, created_at = now()`,
    [
      complaintId, analysis.classifierProvider, analysis.classifierModel, analysis.embeddingProvider, analysis.embeddingModel,
      inferredCategoryId, c.summaryTitle, c.summary, c.courseCodes, c.academicPeriod, c.problemType, c.severity,
      c.academicImpact, c.safetyFlag, analysis.embedding, c.underlyingProblem, c.problemAspect, c.academicActivity,
      c.timeReference, c.affectedGroup, c.sensitivity, c.urgencyIndicators,
    ],
  );
}

/** Process due jobs (used by the worker script, cron endpoint and admin button). */
export async function processDueJobs(limit = 20): Promise<Record<JobOutcome, number>> {
  const due = await rows<{ complaint_id: string }>(
    pool(),
    `select complaint_id from match_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_at < now() - make_interval(mins => $2))
      order by next_attempt_at limit $1`,
    [limit, JOB_POLICY.staleLockMinutes],
  );
  const tally: Record<JobOutcome, number> = { auto: 0, review: 0, new: 0, skipped: 0, retry: 0, failed: 0 };
  for (const { complaint_id } of due) tally[await processMatchJob(complaint_id)]++;
  return tally;
}

/** Periodic maintenance: priority drifts with time (age, overdue deadlines). */
export async function recalculateOpenIssuePriorities() {
  const ids = await rows<{ id: string }>(pool(), `select id from consolidated_issues where status not in ('resolved','closed','merged')`);
  const config = await getPriorityConfig(pool());
  for (const { id } of ids) await withTransaction((tx) => recalculatePriority(tx, id, config));
  return ids.length;
}
