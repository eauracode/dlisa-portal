import path from "node:path";
import { AIProviderError, type EmbeddingProvider } from "../types";

/**
 * Semantic sentence embeddings computed on this server with a small transformer model
 * (default: all-MiniLM-L6-v2, 384 dimensions, ~23 MB quantised) via ONNX Runtime.
 * No API key; complaint text never leaves the server. The model is downloaded once from
 * the Hugging Face hub into MODEL_CACHE_DIR (or pre-provisioned there for offline hosts).
 */
type FeatureExtractor = (text: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

const globalForModel = globalThis as unknown as { __dliEmbedders?: Map<string, Promise<FeatureExtractor>> };

async function loadExtractor(model: string, cacheDir: string): Promise<FeatureExtractor> {
  globalForModel.__dliEmbedders ??= new Map();
  const key = `${model}|${cacheDir}`;
  let pending = globalForModel.__dliEmbedders.get(key);
  if (!pending) {
    pending = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = cacheDir;
      return (await pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as FeatureExtractor;
    })();
    // Do not cache a failed load (e.g. no network on first start); allow a later retry.
    pending.catch(() => globalForModel.__dliEmbedders?.delete(key));
    globalForModel.__dliEmbedders.set(key, pending);
  }
  return pending;
}

export class TransformersEmbedder implements EmbeddingProvider {
  readonly provider = "transformers";
  private readonly cacheDir: string;

  constructor(
    readonly model: string,
    cacheDir: string,
  ) {
    this.cacheDir = path.resolve(cacheDir);
  }

  async embed(text: string, signal: AbortSignal): Promise<number[]> {
    let extractor: FeatureExtractor;
    try {
      extractor = await loadExtractor(this.model, this.cacheDir);
    } catch (err) {
      throw new AIProviderError(`Embedding model could not be loaded: ${(err as Error).name}`, true);
    }
    if (signal.aborted) throw new AIProviderError("AI request timed out", true);
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const vector = output.tolist()[0];
    if (!Array.isArray(vector) || vector.length === 0) throw new AIProviderError("Embedding model returned no vector", true);
    return vector;
  }
}

/** Load the model ahead of the first complaint (used by the worker and health checks). */
export async function warmUpTransformers(model: string, cacheDir: string) {
  await loadExtractor(model, path.resolve(cacheDir));
}
