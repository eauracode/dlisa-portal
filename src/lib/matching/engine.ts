import { GENERIC_PROBLEM_TYPES, type ProblemType } from "../ai/types";
import type { Verification } from "../ai/verifier";

/**
 * Pure decision logic for complaint consolidation (no I/O, fully unit-tested).
 * Thresholds are tuning parameters for the configured embedding model, not calibrated
 * probabilities of correctness.
 */
export const MATCH_ALGORITHM_VERSION = "match-v2";

export interface MatchingConfig {
  /** At or above: eligible for automatic grouping (subject to compatibility checks). */
  autoThreshold: number;
  /** At or above (and below auto): sent to the administrator review queue. */
  reviewThreshold: number;
  /** Auto-grouping requires the best candidate to beat the runner-up by this margin. */
  ambiguityMargin: number;
  /** Resolved/closed issues within this many days are still considered (recurrence check). */
  resolvedLookbackDays: number;
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  autoThreshold: 0.9,
  reviewThreshold: 0.7,
  ambiguityMargin: 0.03,
  resolvedLookbackDays: 120,
};

/**
 * Raw cosine similarity is not comparable across embedding models (small sentence models
 * score paraphrases around 0.6–0.8). Each model's useful range is mapped linearly onto 0–1
 * so the configured thresholds mean the same thing whichever model is active. Values come
 * from the labelled evaluation set (`npm run ai:eval`).
 */
export const SIMILARITY_CALIBRATION: Record<string, { floor: number; ceiling: number }> = {
  "Xenova/all-MiniLM-L6-v2": { floor: 0.2, ceiling: 0.75 },
};

export function calibrateSimilarity(raw: number, embeddingModel?: string | null): number {
  const c = embeddingModel ? SIMILARITY_CALIBRATION[embeddingModel] : undefined;
  if (!c) return clamp(raw);
  return clamp((raw - c.floor) / (c.ceiling - c.floor));
}

export interface MatchSubject {
  categoryId: number;
  embedding: number[];
  courseCodes: string[];
  academicPeriod: string | null;
  problemType: ProblemType | string | null;
  problemAspect?: string | null;
  academicActivity?: string | null;
  affectedGroup?: string | null;
  sensitivity?: "none" | "sensitive" | "highly_sensitive";
}

export interface MatchCandidate extends MatchSubject {
  issueId: string;
  status: string;
  sensitive?: boolean;
}

export interface ScoredCandidate {
  issueId: string;
  status: string;
  semantic: number;
  similarity: number;
  confidence: number;
  compatible: boolean;
  sensitive: boolean;
  evidence: string[];
  conflicts: string[];
}

interface DecisionDetail {
  similarity: number | null;
  compatible: string[];
  conflicts: string[];
  alternatives: Array<{ issueId: string; confidence: number }>;
}

export type MatchDecision =
  | ({ kind: "auto"; issueId: string; confidence: number; explanation: string } & DecisionDetail)
  | ({
      kind: "review";
      issueId: string;
      confidence: number;
      explanation: string;
      reviewKind: "possible_duplicate" | "possible_recurrence";
      reason: "uncertain" | "ambiguous" | "incompatible" | "sensitive" | "recurrence" | "verifier";
    } & DecisionDetail)
  | ({ kind: "new"; bestConfidence: number | null; issueId?: undefined; explanation: string } & DecisionDetail);

const CLOSED_STATUSES = new Set(["resolved", "closed"]);

// Activity pairs that commonly describe the same thing and should not count as a conflict.
const RELATED_ACTIVITIES = [
  ["examination", "timetable"],
  ["examination", "results"],
  ["lecture", "tutorial"],
  ["lecture", "timetable"],
  ["course_materials", "assignment"],
  ["fees", "registration"],
  ["facilities", "tutorial"],
  ["facilities", "lecture"],
].map(([a, b]) => `${a}|${b}`);

function activitiesRelated(a: string, b: string) {
  return a === b || RELATED_ACTIVITIES.includes(`${a}|${b}`) || RELATED_ACTIVITIES.includes(`${b}|${a}`);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clamp(v: number) {
  return Math.min(1, Math.max(0, v));
}
const label = (p: string) => p.replace(/_/g, " ");

export function scoreCandidate(subject: MatchSubject, candidate: MatchCandidate, embeddingModel?: string | null): ScoredCandidate {
  const semantic = clamp(cosineSimilarity(subject.embedding, candidate.embedding));
  const similarity = calibrateSimilarity(semantic, embeddingModel);
  let adjust = 0;
  const evidence: string[] = [`Similarity ${similarity.toFixed(2)}`];
  const conflicts: string[] = [];

  if (subject.categoryId === candidate.categoryId) {
    adjust += 0.03;
    evidence.push("same category");
  } else {
    adjust -= 0.05;
  }

  const specific = (p: string | null | undefined) => !!p && !GENERIC_PROBLEM_TYPES.has(p as ProblemType);
  if (subject.problemType && subject.problemType === candidate.problemType) {
    adjust += 0.04;
    evidence.push(`same problem type (${label(subject.problemType)})`);
  } else if (specific(subject.problemType) && specific(candidate.problemType)) {
    adjust -= 0.08;
    conflicts.push(`different problem types (${label(subject.problemType!)} vs ${label(candidate.problemType!)})`);
  }

  // Same thing, different failure (e.g. timetable missing vs. timetable incorrect).
  if (subject.problemAspect && candidate.problemAspect) {
    if (subject.problemAspect === candidate.problemAspect) {
      adjust += 0.04;
      evidence.push(`same kind of problem (${label(subject.problemAspect)})`);
    } else {
      adjust -= 0.12;
      conflicts.push(`different kind of problem (${label(subject.problemAspect)} vs ${label(candidate.problemAspect)})`);
    }
  }

  if (subject.academicActivity && candidate.academicActivity) {
    if (subject.academicActivity === candidate.academicActivity) {
      adjust += 0.02;
      evidence.push(`same activity (${label(subject.academicActivity)})`);
    } else if (!activitiesRelated(subject.academicActivity, candidate.academicActivity)) {
      adjust -= 0.05;
      conflicts.push(`different activities (${label(subject.academicActivity)} vs ${label(candidate.academicActivity)})`);
    }
  }

  if (subject.courseCodes.length && candidate.courseCodes.length) {
    const shared = subject.courseCodes.filter((c) => candidate.courseCodes.includes(c));
    if (shared.length) {
      adjust += 0.05;
      evidence.push(`both mention ${shared.join(", ")}`);
    } else {
      conflicts.push(`different courses (${subject.courseCodes.join(", ")} vs ${candidate.courseCodes.join(", ")})`);
    }
  }

  if (subject.academicPeriod && candidate.academicPeriod) {
    if (subject.academicPeriod === candidate.academicPeriod) evidence.push(`same period (${subject.academicPeriod})`);
    else conflicts.push(`different academic periods (${subject.academicPeriod} vs ${candidate.academicPeriod})`);
  }

  if (subject.affectedGroup && candidate.affectedGroup) {
    const a = subject.affectedGroup.toLowerCase().split(/,\s*/);
    const b = candidate.affectedGroup.toLowerCase().split(/,\s*/);
    if (a.some((x) => b.includes(x))) evidence.push(`same group (${subject.affectedGroup})`);
    else conflicts.push(`different groups (${subject.affectedGroup} vs ${candidate.affectedGroup})`);
  }

  return {
    issueId: candidate.issueId,
    status: candidate.status,
    semantic,
    similarity,
    confidence: clamp(similarity + adjust),
    compatible: conflicts.length === 0,
    sensitive: !!candidate.sensitive,
    evidence,
    conflicts,
  };
}

export function explain(scored: ScoredCandidate): string {
  const parts = [scored.evidence.join("; ")];
  if (scored.conflicts.length) parts.push(`Check: ${scored.conflicts.join("; ")}`);
  if (scored.sensitive) parts.push("Candidate issue is sensitive");
  if (CLOSED_STATUSES.has(scored.status)) parts.push("Candidate issue was previously resolved");
  return `${parts.join(". ")}.`;
}

function detail(s: ScoredCandidate | undefined, all: ScoredCandidate[]): DecisionDetail {
  return {
    similarity: s ? Math.round(s.similarity * 1000) / 1000 : null,
    compatible: s?.evidence.slice(1) ?? [],
    conflicts: s?.conflicts ?? [],
    alternatives: all
      .filter((x) => x !== s)
      .slice(0, 3)
      .map((x) => ({ issueId: x.issueId, confidence: Math.round(x.confidence * 1000) / 1000 })),
  };
}

export function decideMatch(subject: MatchSubject, candidates: MatchCandidate[], config: MatchingConfig, embeddingModel?: string | null): MatchDecision {
  const scored = candidates.map((c) => scoreCandidate(subject, c, embeddingModel)).sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  if (!best || best.confidence < config.reviewThreshold) {
    return {
      kind: "new",
      bestConfidence: best ? best.confidence : null,
      explanation: best ? `Closest existing issue scored ${best.confidence.toFixed(2)}, below the review threshold.` : "No comparable open issues.",
      ...detail(best, scored),
    };
  }

  const subjectSensitive = !!subject.sensitivity && subject.sensitivity !== "none";
  const bestCompatible = scored.find((s) => s.compatible);
  if (bestCompatible && bestCompatible.confidence >= config.autoThreshold && !CLOSED_STATUSES.has(bestCompatible.status)) {
    // Any other plausible candidate that is nearly as strong makes the choice ambiguous.
    const runnerUp = scored.find((s) => s !== bestCompatible && s.confidence >= config.reviewThreshold);
    const ambiguous = !!runnerUp && bestCompatible.confidence - runnerUp.confidence < config.ambiguityMargin;
    // Sensitive welfare cases are never merged automatically, however similar the wording.
    const sensitive = subjectSensitive || bestCompatible.sensitive;
    if (!ambiguous && !sensitive) {
      return { kind: "auto", issueId: bestCompatible.issueId, confidence: bestCompatible.confidence, explanation: explain(bestCompatible), ...detail(bestCompatible, scored) };
    }
    return {
      kind: "review",
      issueId: bestCompatible.issueId,
      confidence: bestCompatible.confidence,
      explanation: explain(bestCompatible) + (sensitive ? " Sensitive case: restricted human review required." : " Another issue is almost as similar."),
      reviewKind: "possible_duplicate",
      reason: sensitive ? "sensitive" : "ambiguous",
      ...detail(bestCompatible, scored),
    };
  }

  // Uncertain, incompatible-but-similar, or a possible recurrence of a resolved issue:
  // a person decides. Prefer the strongest compatible candidate to propose.
  const proposal = bestCompatible && bestCompatible.confidence >= config.reviewThreshold ? bestCompatible : best;
  const recurrence = CLOSED_STATUSES.has(proposal.status);
  return {
    kind: "review",
    issueId: proposal.issueId,
    confidence: proposal.confidence,
    explanation: explain(proposal),
    reviewKind: recurrence ? "possible_recurrence" : "possible_duplicate",
    reason: recurrence ? "recurrence" : proposal.compatible ? "uncertain" : "incompatible",
    ...detail(proposal, scored),
  };
}

/**
 * Combine the engine's decision with an independent verification of the proposed match.
 * Verification can only make the outcome more cautious: a "different" verdict (or an
 * "uncertain" verdict from an authoritative LLM verifier) turns automatic grouping into
 * human review. It never upgrades a review into an automatic merge.
 */
export function applyVerification(decision: MatchDecision, verification: Verification | null, authoritative: boolean): MatchDecision {
  if (!verification || decision.kind === "new") return decision;
  const note = ` Verifier: ${verification.verdict} — ${verification.reason}`;
  if (decision.kind === "auto" && (verification.verdict === "different" || (verification.verdict === "uncertain" && authoritative))) {
    return {
      kind: "review",
      issueId: decision.issueId,
      confidence: decision.confidence,
      explanation: decision.explanation + note,
      reviewKind: "possible_duplicate",
      reason: "verifier",
      similarity: decision.similarity,
      compatible: decision.compatible,
      conflicts: verification.verdict === "different" ? [...decision.conflicts, verification.reason] : decision.conflicts,
      alternatives: decision.alternatives,
    };
  }
  return { ...decision, explanation: decision.explanation + note };
}
