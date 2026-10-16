import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildClassifierUserMessage, CLASSIFIER_SYSTEM_PROMPT } from "../prompt";
import { AIProviderError, modelClassificationSchema, type ClassificationInput, type Classifier, type ModelClassification } from "../types";

/**
 * Classification through the Anthropic Messages API using structured outputs, so the
 * response is validated against `classificationSchema`. Anthropic does not provide an
 * embeddings endpoint; pair this with the local or an OpenAI-compatible embedder.
 */
export class AnthropicClassifier implements Classifier {
  readonly provider = "anthropic";
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs: number,
  ) {
    // The matching job has its own retry/back-off; keep SDK retries low so a request
    // cannot exceed the job's time budget by much.
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async classify(input: ClassificationInput, signal: AbortSignal): Promise<ModelClassification> {
    let response;
    try {
      response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: 2048,
          system: CLASSIFIER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildClassifierUserMessage(input) }],
          // Short, well-specified extraction task: low effort keeps latency and cost down.
          output_config: { effort: "low", format: zodOutputFormat(modelClassificationSchema) },
        },
        { signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AIProviderError("Anthropic rate limit", true);
      if (err instanceof Anthropic.AuthenticationError) throw new AIProviderError("Anthropic authentication failed", false);
      if (err instanceof Anthropic.BadRequestError) throw new AIProviderError("Anthropic rejected the request", false);
      if (err instanceof Anthropic.APIError) throw new AIProviderError(`Anthropic API error ${err.status ?? ""}`.trim(), true);
      throw new AIProviderError(`Anthropic request failed: ${(err as Error).name}`, true);
    }
    if (response.stop_reason === "refusal") throw new AIProviderError("Anthropic declined to classify", false);
    if (!response.parsed_output) throw new AIProviderError("Anthropic returned no parsable output", true);
    return response.parsed_output;
  }
}
