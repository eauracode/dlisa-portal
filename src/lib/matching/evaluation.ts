import { normalizeClassification, withTimeout } from "../ai";
import { deriveSubject } from "../validation";
import { embeddingText } from "../ai/prompt";
import type { CategoryOption, ComplaintClassifier, EmbeddingProvider } from "../ai/types";
import type { IssueSimilarityMatcher, ProblemRepresentation } from "../ai/verifier";
import { applyVerification, decideMatch, DEFAULT_MATCHING_CONFIG, type MatchCandidate, type MatchingConfig } from "./engine";

/**
 * Offline evaluation harness: replays a labelled set of complaints through the real
 * classifier → embedding → engine → verifier pipeline (no database) and measures how often
 * grouping is right, how often it wrongly merges different problems, and how much is left
 * to human review. Uncertain cases are resolved "as a person would" (gold label) so the
 * stream continues realistically.
 */
export interface EvalItem {
  group: string;
  category: string;
  text: string;
}

export interface EvalDataset {
  hardNegatives: Array<[string, string]>;
  items: EvalItem[];
}

export interface EvalResult {
  total: number;
  correctAuto: number;
  correctNew: number;
  falseMerges: Array<{ item: string; joined: string; expected: string; confidence: number }>;
  hardNegativeMerges: number;
  reviews: number;
  reviewsPointingRight: number;
  missed: number;
  accuracy: number;
  autoPrecision: number;
  details: Array<{ text: string; group: string; outcome: string; confidence: number | null; target: string | null }>;
}

interface SimIssue extends MatchCandidate {
  group: string;
  members: number[][];
  rep: ProblemRepresentation;
}

export async function runEvaluation(
  dataset: EvalDataset,
  providers: { classifier: ComplaintClassifier; embedder: EmbeddingProvider; verifier: IssueSimilarityMatcher; timeoutMs: number },
  categories: CategoryOption[],
  config: MatchingConfig = DEFAULT_MATCHING_CONFIG,
): Promise<EvalResult> {
  const issues: SimIssue[] = [];
  const hard = new Set(dataset.hardNegatives.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const r: EvalResult = {
    total: dataset.items.length,
    correctAuto: 0,
    correctNew: 0,
    falseMerges: [],
    hardNegativeMerges: 0,
    reviews: 0,
    reviewsPointingRight: 0,
    missed: 0,
    accuracy: 0,
    autoPrecision: 0,
    details: [],
  };
  let autoCount = 0;

  for (const item of dataset.items) {
    const subject = deriveSubject(item.text);
    const input = { subject, description: item.text, selectedCategorySlug: item.category, categories };
    const raw = await withTimeout(providers.timeoutMs, (s) => providers.classifier.classify(input, s));
    const c = normalizeClassification(raw, input);
    const embedding = await withTimeout(Math.max(providers.timeoutMs, 60_000), (s) => providers.embedder.embed(embeddingText(subject, item.text), s));
    const categoryId = categories.find((x) => x.slug === c.categorySlug)?.id ?? 0;
    const rep: ProblemRepresentation = {
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

    let decision = decideMatch(
      { categoryId, embedding, courseCodes: c.courseCodes, academicPeriod: c.academicPeriod, problemType: c.problemType, problemAspect: c.problemAspect, academicActivity: c.academicActivity, affectedGroup: c.affectedGroup, sensitivity: c.sensitivity },
      issues,
      config,
      providers.embedder.model,
    );
    if (decision.kind !== "new") {
      const target = issues.find((i) => i.issueId === decision.issueId)!;
      const v = await withTimeout(providers.timeoutMs, (s) => providers.verifier.verify(rep, target.rep, s));
      decision = applyVerification(decision, v, providers.verifier.authoritative);
    }

    const goldIssue = issues.find((i) => i.group === item.group);
    let joined: SimIssue | undefined;
    if (decision.kind === "auto") {
      autoCount++;
      joined = issues.find((i) => i.issueId === decision.issueId)!;
      if (joined.group === item.group) r.correctAuto++;
      else {
        r.falseMerges.push({ item: item.text, joined: joined.group, expected: item.group, confidence: decision.confidence });
        if (hard.has(`${joined.group}|${item.group}`)) r.hardNegativeMerges++;
      }
    } else if (decision.kind === "review") {
      r.reviews++;
      if (goldIssue && decision.issueId === goldIssue.issueId) r.reviewsPointingRight++;
      joined = goldIssue; // a reviewer attaches it correctly (or starts a new issue)
    } else {
      if (goldIssue) r.missed++;
      else r.correctNew++;
      joined = undefined;
    }

    if (!joined) {
      joined = {
        issueId: `issue-${issues.length + 1}`,
        group: item.group,
        status: "in_progress",
        categoryId,
        embedding,
        members: [],
        courseCodes: c.courseCodes,
        academicPeriod: c.academicPeriod,
        problemType: c.problemType,
        problemAspect: c.problemAspect,
        academicActivity: c.academicActivity,
        affectedGroup: c.affectedGroup,
        sensitive: c.sensitivity !== "none",
        rep,
      };
      issues.push(joined);
    }
    joined.members.push(embedding);
    joined.embedding = centroid(joined.members);
    joined.courseCodes = [...new Set([...joined.courseCodes, ...c.courseCodes])];

    r.details.push({
      text: item.text,
      group: item.group,
      outcome: decision.kind,
      confidence: decision.kind === "new" ? decision.bestConfidence : decision.confidence,
      target: decision.kind === "new" ? null : issues.find((i) => i.issueId === decision.issueId)?.group ?? null,
    });
  }

  r.accuracy = (r.correctAuto + r.correctNew) / r.total;
  r.autoPrecision = autoCount ? r.correctAuto / autoCount : 1;
  return r;
}

function centroid(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
  return sum.map((x) => x / norm);
}
