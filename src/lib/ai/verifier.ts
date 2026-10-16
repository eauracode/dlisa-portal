import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AIProviderError } from "./types";

/**
 * Structured representation of a complaint or consolidated issue. This — not the raw
 * complaint text — is what verification compares, which keeps external requests minimal.
 */
export interface ProblemRepresentation {
  summary: string;
  underlyingProblem: string | null;
  problemType: string | null;
  problemAspect: string | null;
  academicActivity: string | null;
  courseCodes: string[];
  academicPeriod: string | null;
  timeReference: string | null;
  affectedGroup: string | null;
}

export const verificationSchema = z.object({
  verdict: z.enum(["same", "different", "uncertain"]),
  reason: z.string(),
});
export type Verification = z.infer<typeof verificationSchema>;

/** Decides whether a new complaint and an existing issue describe the same underlying problem. */
export interface IssueSimilarityMatcher {
  readonly provider: string;
  readonly model: string;
  /** Whether "uncertain" from this verifier should block automatic grouping. */
  readonly authoritative: boolean;
  verify(complaint: ProblemRepresentation, issue: ProblemRepresentation, signal: AbortSignal): Promise<Verification>;
}

const VERIFIER_PROMPT = `You compare a new student complaint with an existing grouped issue at the Distance Learning Institute, University of Lagos.
Decide whether they describe the SAME underlying problem (same thing affected, same kind of failure, same course or activity, compatible time period).
- "same": clearly the same problem, even if worded differently.
- "different": a different problem, course, period, cause or a separate occurrence (e.g. a timetable that is missing vs. one that contains a wrong date).
- "uncertain": not enough information to tell.
Unknown attributes are null; do not assume them. Give a one-sentence reason that cites the attributes you relied on.`;

function describe(label: string, r: ProblemRepresentation): string {
  return `${label}:\n${JSON.stringify(r, null, 1)}`;
}

/** Deterministic verifier based on the structured attributes alone. */
export class LocalVerifier implements IssueSimilarityMatcher {
  readonly provider = "local";
  readonly model = "attribute-rules-v1";
  readonly authoritative = false;

  async verify(a: ProblemRepresentation, b: ProblemRepresentation): Promise<Verification> {
    if (a.problemAspect && b.problemAspect && a.problemAspect !== b.problemAspect) {
      return { verdict: "different", reason: `Different kind of problem (${a.problemAspect} vs ${b.problemAspect}).` };
    }
    if (a.courseCodes.length && b.courseCodes.length && !a.courseCodes.some((c) => b.courseCodes.includes(c))) {
      return { verdict: "different", reason: `Different courses (${a.courseCodes.join(", ")} vs ${b.courseCodes.join(", ")}).` };
    }
    if (a.academicPeriod && b.academicPeriod && a.academicPeriod !== b.academicPeriod) {
      return { verdict: "different", reason: `Different academic periods (${a.academicPeriod} vs ${b.academicPeriod}).` };
    }
    const agreeing = [
      a.problemAspect && a.problemAspect === b.problemAspect && "same kind of problem",
      a.academicActivity && a.academicActivity === b.academicActivity && "same academic activity",
      a.problemType && a.problemType === b.problemType && "same problem type",
    ].filter(Boolean) as string[];
    if (agreeing.length >= 2) return { verdict: "same", reason: `Attributes agree: ${agreeing.join(", ")}.` };
    return { verdict: "uncertain", reason: "Not enough structured detail to confirm." };
  }
}

export class AnthropicVerifier implements IssueSimilarityMatcher {
  readonly provider = "anthropic";
  readonly authoritative = true;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs: number,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async verify(a: ProblemRepresentation, b: ProblemRepresentation, signal: AbortSignal): Promise<Verification> {
    let response;
    try {
      response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: 1024,
          system: VERIFIER_PROMPT,
          messages: [{ role: "user", content: `${describe("New complaint", a)}\n\n${describe("Existing issue", b)}` }],
          output_config: { effort: "low", format: zodOutputFormat(verificationSchema) },
        },
        { signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AIProviderError("Anthropic rate limit", true);
      if (err instanceof Anthropic.AuthenticationError) throw new AIProviderError("Anthropic authentication failed", false);
      if (err instanceof Anthropic.APIError) throw new AIProviderError(`Anthropic API error ${err.status ?? ""}`.trim(), (err.status ?? 500) >= 500);
      throw new AIProviderError(`Anthropic request failed: ${(err as Error).name}`, true);
    }
    if (response.stop_reason === "refusal" || !response.parsed_output) return { verdict: "uncertain", reason: "Verifier gave no usable answer." };
    const parsed = verificationSchema.safeParse(response.parsed_output);
    return parsed.success ? { verdict: parsed.data.verdict, reason: parsed.data.reason.slice(0, 300) } : { verdict: "uncertain", reason: "Verifier output was invalid." };
  }
}

export class OpenAIVerifier implements IssueSimilarityMatcher {
  readonly provider = "openai";
  readonly authoritative = true;

  constructor(private readonly config: { apiKey: string | undefined; baseUrl: string; chatModel: string }) {}
  get model() {
    return this.config.chatModel;
  }

  async verify(a: ProblemRepresentation, b: ProblemRepresentation, signal: AbortSignal): Promise<Verification> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.config.chatModel,
          temperature: 0,
          messages: [
            { role: "system", content: VERIFIER_PROMPT },
            { role: "user", content: `${describe("New complaint", a)}\n\n${describe("Existing issue", b)}` },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "match_verification",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["verdict", "reason"],
                properties: { verdict: { type: "string", enum: ["same", "different", "uncertain"] }, reason: { type: "string" } },
              },
            },
          },
        }),
        signal,
      });
    } catch (err) {
      throw new AIProviderError(`OpenAI-compatible request failed: ${(err as Error).name}`, true);
    }
    if (!res.ok) throw new AIProviderError(`OpenAI-compatible API returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    try {
      const parsed = verificationSchema.safeParse(JSON.parse(data.choices?.[0]?.message?.content ?? ""));
      if (parsed.success) return { verdict: parsed.data.verdict, reason: parsed.data.reason.slice(0, 300) };
    } catch {
      /* fall through */
    }
    return { verdict: "uncertain", reason: "Verifier output was invalid." };
  }
}
