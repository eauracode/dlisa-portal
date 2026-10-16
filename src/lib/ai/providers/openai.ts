import { buildClassifierUserMessage, CLASSIFIER_SYSTEM_PROMPT } from "../prompt";
import { ACADEMIC_ACTIVITIES, AIProviderError, modelClassificationSchema, PROBLEM_ASPECTS, PROBLEM_TYPES, SENSITIVITY_LEVELS, SEVERITIES, type ClassificationInput, type Classifier, type Embedder, type ModelClassification } from "../types";

/**
 * Provider for any OpenAI-compatible API (OpenAI, Azure OpenAI gateways, OpenRouter, or a
 * self-hosted Ollama / vLLM server via OPENAI_BASE_URL — the latter keeps complaint text
 * on infrastructure the institution controls).
 */
interface OpenAIConfig {
  apiKey: string | undefined;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
}

async function post(config: OpenAIConfig, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new AIProviderError(`OpenAI-compatible request failed: ${(err as Error).name}`, true);
  }
  if (!res.ok) {
    // Do not include the response body: it may echo request content.
    throw new AIProviderError(`OpenAI-compatible API returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
  }
  return res.json();
}

const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "categorySlug", "summaryTitle", "summary", "underlyingProblem", "problemType", "problemAspect", "academicActivity", "courseCodes",
    "academicPeriod", "timeReference", "affectedGroup", "severity", "urgencyIndicators", "academicImpact", "safetyFlag", "sensitivity",
  ],
  properties: {
    categorySlug: { type: ["string", "null"] },
    summaryTitle: { type: "string" },
    summary: { type: "string" },
    underlyingProblem: { type: ["string", "null"] },
    problemType: { type: "string", enum: [...PROBLEM_TYPES] },
    problemAspect: { type: ["string", "null"], enum: [...PROBLEM_ASPECTS, null] },
    academicActivity: { type: ["string", "null"], enum: [...ACADEMIC_ACTIVITIES, null] },
    courseCodes: { type: "array", items: { type: "string" } },
    academicPeriod: { type: ["string", "null"] },
    timeReference: { type: ["string", "null"] },
    affectedGroup: { type: ["string", "null"] },
    severity: { type: "string", enum: [...SEVERITIES] },
    urgencyIndicators: { type: "array", items: { type: "string" } },
    academicImpact: { type: "boolean" },
    safetyFlag: { type: "boolean" },
    sensitivity: { type: "string", enum: [...SENSITIVITY_LEVELS] },
  },
};

export class OpenAIClassifier implements Classifier {
  readonly provider = "openai";
  constructor(private readonly config: OpenAIConfig) {}
  get model() {
    return this.config.chatModel;
  }

  async classify(input: ClassificationInput, signal: AbortSignal): Promise<ModelClassification> {
    const data = (await post(
      this.config,
      "/chat/completions",
      {
        model: this.config.chatModel,
        temperature: 0,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: buildClassifierUserMessage(input) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "complaint_classification", strict: true, schema: JSON_SCHEMA } },
      },
      signal,
    )) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new AIProviderError("OpenAI-compatible API returned no content", true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AIProviderError("OpenAI-compatible API returned invalid JSON", true);
    }
    const result = modelClassificationSchema.safeParse(parsed);
    if (!result.success) throw new AIProviderError("Classification did not match the expected schema", true);
    return result.data;
  }
}

export class OpenAIEmbedder implements Embedder {
  readonly provider = "openai";
  constructor(private readonly config: OpenAIConfig) {}
  get model() {
    return this.config.embeddingModel;
  }

  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    const data = (await post(this.config, "/embeddings", { model: this.config.embeddingModel, input: text }, signal)) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) throw new AIProviderError("Embedding response was empty", true);
    return embedding;
  }
}
