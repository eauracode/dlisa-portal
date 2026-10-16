import { z } from "zod";

export const SEVERITIES = ["routine", "moderate", "serious", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Controlled vocabulary of underlying problem types used as a structured matching signal. */
export const PROBLEM_TYPES = [
  "missing_result",
  "result_error",
  "exam_schedule",
  "exam_conduct",
  "lecture_schedule",
  "lecturer_availability",
  "course_material_access",
  "lms_portal_access",
  "registration",
  "fees_payment",
  "documents_records",
  "communication",
  "facility",
  "internet_connectivity",
  "welfare_safety",
  "welfare_health",
  "harassment",
  "suggestion",
  "general_feedback",
  "other",
] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

/**
 * What is wrong with the thing, independent of what the thing is. Two complaints about the
 * same timetable are different problems if one says it is missing and the other says it
 * is incorrect.
 */
export const PROBLEM_ASPECTS = [
  "missing", // not published / not received / not available
  "incorrect", // wrong, inaccurate, contains errors
  "delayed", // late, postponed, taking too long
  "inaccessible", // exists but cannot be accessed (login, site down, cannot open)
  "conflict", // clash, overlap, double-booking
  "poor_quality", // inadequate, broken, poor condition
  "misconduct", // behaviour of people: harassment, extortion, absence
  "cost", // charges, fees, refunds
  "request", // suggestion or request for something new
  "other",
] as const;
export type ProblemAspect = (typeof PROBLEM_ASPECTS)[number];

export const ACADEMIC_ACTIVITIES = [
  "examination",
  "lecture",
  "tutorial",
  "timetable",
  "results",
  "registration",
  "course_materials",
  "assignment",
  "project",
  "graduation",
  "fees",
  "welfare",
  "facilities",
  "other",
] as const;
export type AcademicActivity = (typeof ACADEMIC_ACTIVITIES)[number];

export const SENSITIVITY_LEVELS = ["none", "sensitive", "highly_sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Problem types too broad to count as a conflicting signal when they differ. */
export const GENERIC_PROBLEM_TYPES: ReadonlySet<ProblemType> = new Set(["other", "general_feedback"]);

/**
 * What an AI provider is asked to return. Deliberately loose (no regex patterns) so it
 * works with every structured-output mode; `normalizeClassification` then cleans it.
 * Unknown attributes must be null — never guessed.
 */
export const modelClassificationSchema = z.object({
  categorySlug: z.string().nullable(),
  summaryTitle: z.string(),
  summary: z.string(),
  underlyingProblem: z.string().nullable(),
  problemType: z.enum(PROBLEM_TYPES),
  problemAspect: z.enum(PROBLEM_ASPECTS).nullable(),
  academicActivity: z.enum(ACADEMIC_ACTIVITIES).nullable(),
  courseCodes: z.array(z.string()),
  academicPeriod: z.string().nullable(),
  timeReference: z.string().nullable(),
  affectedGroup: z.string().nullable(),
  severity: z.enum(SEVERITIES),
  urgencyIndicators: z.array(z.string()),
  academicImpact: z.boolean(),
  safetyFlag: z.boolean(),
  sensitivity: z.enum(SENSITIVITY_LEVELS),
});
export type ModelClassification = z.infer<typeof modelClassificationSchema>;

/** Server-validated structured representation of one complaint. */
export const classificationSchema = modelClassificationSchema.extend({
  summaryTitle: z.string().min(3).max(120),
  summary: z.string().min(3).max(600),
  underlyingProblem: z.string().max(300).nullable(),
  courseCodes: z.array(z.string().regex(/^[A-Z]{3} \d{3}$/)).max(10),
  academicPeriod: z.string().max(60).nullable(),
  timeReference: z.string().max(60).nullable(),
  affectedGroup: z.string().max(80).nullable(),
  urgencyIndicators: z.array(z.string().max(60)).max(8),
});
export type Classification = z.infer<typeof classificationSchema>;

export interface CategoryOption {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export interface ClassificationInput {
  subject: string;
  description: string;
  selectedCategorySlug: string;
  categories: CategoryOption[];
}

/** Classifies a complaint into a structured representation. */
export interface ComplaintClassifier {
  readonly provider: string;
  readonly model: string;
  classify(input: ClassificationInput, signal: AbortSignal): Promise<ModelClassification>;
}

/** Produces a semantic vector for a piece of text. */
export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  embed(text: string, signal: AbortSignal): Promise<number[]>;
}

/** Backwards-compatible names used across the codebase. */
export type Classifier = ComplaintClassifier;
export type Embedder = EmbeddingProvider;

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
