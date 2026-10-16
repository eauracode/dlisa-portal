import { env } from "../env";
import { extractAcademicPeriod, extractCourseCodes, truncate } from "./extract";
import { embeddingText } from "./prompt";
import { redactIdentifiers } from "./redact";
import { AnthropicClassifier } from "./providers/anthropic";
import { LocalClassifier, LocalEmbedder } from "./providers/local";
import { OpenAIClassifier, OpenAIEmbedder } from "./providers/openai";
import { TransformersEmbedder } from "./providers/transformers";
import { AnthropicVerifier, LocalVerifier, OpenAIVerifier, type IssueSimilarityMatcher } from "./verifier";
import {
  AIProviderError,
  classificationSchema,
  type Classification,
  type ClassificationInput,
  type ComplaintClassifier,
  type EmbeddingProvider,
  type ModelClassification,
} from "./types";

export interface AIProviders {
  classifier: ComplaintClassifier;
  embedder: EmbeddingProvider;
  verifier: IssueSimilarityMatcher;
  timeoutMs: number;
}

let override: Partial<AIProviders> | null = null;

/** Test hook: replace providers (e.g. with a failing or deterministic fake). */
export function setAIProvidersForTesting(providers: Partial<AIProviders> | null) {
  override = providers;
}

function configuredProviders(): AIProviders {
  const e = env();
  const openaiConfig = {
    apiKey: e.OPENAI_API_KEY,
    baseUrl: e.OPENAI_BASE_URL,
    chatModel: e.OPENAI_CHAT_MODEL,
    embeddingModel: e.OPENAI_EMBEDDING_MODEL,
  };
  const requireAnthropicKey = () => {
    if (!e.ANTHROPIC_API_KEY) throw new Error("The anthropic provider requires ANTHROPIC_API_KEY");
    return e.ANTHROPIC_API_KEY;
  };

  let classifier: ComplaintClassifier;
  switch (e.AI_CLASSIFIER_PROVIDER) {
    case "anthropic":
      classifier = new AnthropicClassifier(requireAnthropicKey(), e.ANTHROPIC_MODEL, e.AI_TIMEOUT_MS);
      break;
    case "openai":
      classifier = new OpenAIClassifier(openaiConfig);
      break;
    default:
      classifier = new LocalClassifier();
  }

  let embedder: EmbeddingProvider;
  switch (e.AI_EMBEDDING_PROVIDER) {
    case "openai":
      embedder = new OpenAIEmbedder(openaiConfig);
      break;
    case "transformers":
      embedder = new TransformersEmbedder(e.LOCAL_EMBEDDING_MODEL, e.MODEL_CACHE_DIR);
      break;
    default:
      embedder = new LocalEmbedder();
  }

  let verifier: IssueSimilarityMatcher;
  switch (e.AI_VERIFIER_PROVIDER ?? e.AI_CLASSIFIER_PROVIDER) {
    case "anthropic":
      verifier = new AnthropicVerifier(requireAnthropicKey(), e.ANTHROPIC_MODEL, e.AI_TIMEOUT_MS);
      break;
    case "openai":
      verifier = new OpenAIVerifier(openaiConfig);
      break;
    default:
      verifier = new LocalVerifier();
  }
  return { classifier, embedder, verifier, timeoutMs: e.AI_TIMEOUT_MS };
}

export function getAIProviders(): AIProviders {
  if (!override) return configuredProviders();
  return {
    classifier: override.classifier ?? new LocalClassifier(),
    embedder: override.embedder ?? new LocalEmbedder(),
    verifier: override.verifier ?? new LocalVerifier(),
    timeoutMs: override.timeoutMs ?? 2000,
  };
}

export interface ComplaintAnalysis {
  classification: Classification;
  classifierProvider: string;
  classifierModel: string;
  embedding: number[];
  embeddingProvider: string;
  embeddingModel: string;
}

export function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    fn(controller.signal),
    new Promise<T>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new AIProviderError("AI request timed out", true))),
    ),
  ]).finally(() => clearTimeout(timer));
}

const optionalText = (v: string | null | undefined, max: number) => {
  const t = v?.trim();
  return t && !/^(unknown|n\/a|none|null)$/i.test(t) ? truncate(redactIdentifiers(t), max) : null;
};

/**
 * Server-side validation of model output: AI results are recommendations, never trusted
 * as-is. Cleans, redacts, truncates and re-validates against the strict schema; anything
 * that still fails is rejected (and the job retried or handled by staff).
 */
export function normalizeClassification(raw: ModelClassification, input: ClassificationInput): Classification {
  const text = `${input.subject}\n${input.description}`;
  const knownSlugs = new Set(input.categories.map((c) => c.slug));
  const courseCodes = [
    ...new Set([
      ...raw.courseCodes.map((c) => c.toUpperCase().replace(/^([A-Z]{3})\s*-?\s*(\d{3})$/, "$1 $2")).filter((c) => /^[A-Z]{3} \d{3}$/.test(c)),
      ...extractCourseCodes(text),
    ]),
  ]
    .sort()
    .slice(0, 10);
  const candidate = {
    ...raw,
    categorySlug: raw.categorySlug && knownSlugs.has(raw.categorySlug) ? raw.categorySlug : input.selectedCategorySlug,
    summaryTitle: truncate(redactIdentifiers(raw.summaryTitle.trim() || input.subject), 100),
    summary: truncate(redactIdentifiers(raw.summary.trim() || input.description), 400),
    underlyingProblem: optionalText(raw.underlyingProblem, 300),
    courseCodes,
    academicPeriod: optionalText(raw.academicPeriod, 60) ?? extractAcademicPeriod(text),
    timeReference: optionalText(raw.timeReference, 60),
    affectedGroup: optionalText(raw.affectedGroup, 80),
    urgencyIndicators: raw.urgencyIndicators.map((u) => u.trim().slice(0, 60)).filter(Boolean).slice(0, 8),
    // A safety flag always implies at least "sensitive".
    sensitivity: raw.safetyFlag && raw.sensitivity === "none" ? "sensitive" : raw.sensitivity,
  };
  const parsed = classificationSchema.safeParse(candidate);
  if (!parsed.success) throw new AIProviderError("Classification failed server-side validation", true);
  return parsed.data;
}

/**
 * Classify and embed one complaint. A permanent classifier failure (refusal, invalid
 * request) falls back to the local classifier; transient failures throw a retryable
 * AIProviderError so the background job can try again later.
 */
export async function analyzeComplaint(input: ClassificationInput): Promise<ComplaintAnalysis> {
  const { classifier, embedder, timeoutMs } = getAIProviders();

  let raw: ModelClassification;
  let classifierProvider = classifier.provider;
  let classifierModel = classifier.model;
  try {
    raw = await withTimeout(timeoutMs, (signal) => classifier.classify(input, signal));
  } catch (err) {
    if (err instanceof AIProviderError && !err.retryable && classifier.provider !== "local") {
      const local = new LocalClassifier();
      raw = await local.classify(input);
      classifierProvider = `${classifier.provider}->local`;
      classifierModel = local.model;
    } else {
      throw err instanceof AIProviderError ? err : new AIProviderError(`Classifier failed: ${(err as Error).name}`, true);
    }
  }
  const classification = normalizeClassification(raw, input);

  let embedding: number[];
  try {
    // First load of a local model can take several seconds; allow extra time once.
    const budget = embedder.provider === "transformers" ? Math.max(timeoutMs, 60_000) : timeoutMs;
    embedding = await withTimeout(budget, (signal) => embedder.embed(embeddingText(input.subject, input.description), signal));
  } catch (err) {
    throw err instanceof AIProviderError ? err : new AIProviderError(`Embedder failed: ${(err as Error).name}`, true);
  }

  return {
    classification,
    classifierProvider,
    classifierModel,
    embedding,
    embeddingProvider: embedder.provider,
    embeddingModel: embedder.model,
  };
}

export { AIProviderError };
