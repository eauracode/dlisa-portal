import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  // Used to HMAC client identifiers (IP addresses) before they are stored for rate limiting.
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  // Bearer token for the scheduled job endpoint (/api/jobs/process).
  CRON_SECRET: z.string().min(16).optional(),
  // Number of reverse proxies in front of the app whose X-Forwarded-For entries are trusted.
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(5).default(1),

  AI_CLASSIFIER_PROVIDER: z.enum(["local", "openai", "anthropic"]).default("local"),
  AI_EMBEDDING_PROVIDER: z.enum(["local", "transformers", "openai"]).default("local"),
  // Optional LLM that double-checks candidate matches; defaults to the classifier provider.
  AI_VERIFIER_PROVIDER: z.enum(["local", "openai", "anthropic"]).optional(),
  LOCAL_EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
  MODEL_CACHE_DIR: z.string().default("./.models"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
