import { setAIProvidersForTesting } from "@/lib/ai";
import { LocalClassifier } from "@/lib/ai/providers/local";
import { AIProviderError, type Embedder } from "@/lib/ai/types";

const DIM = 64;

/** Unit vector whose cosine similarity with `basis(0)` equals `cos`. */
export function vectorWithSimilarity(cos: number, axis = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = cos;
  v[axis] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

export function basis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

/**
 * Embedder whose output is chosen by a `#marker` in the complaint text, so tests control
 * the exact similarity between complaints. Text without a known marker gets a unique axis.
 */
export class MarkerEmbedder implements Embedder {
  readonly provider = "fake";
  readonly model = "marker-v1";
  failuresRemaining = 0;
  calls = 0;
  private nextAxis = 2;
  constructor(private readonly vectors: Record<string, number[]>) {}

  async embed(text: string): Promise<number[]> {
    this.calls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new AIProviderError("simulated provider outage", true);
    }
    const marker = Object.keys(this.vectors).find((k) => new RegExp(`#${k}\\b`).test(text));
    if (marker) return this.vectors[marker];
    return basis(Math.min(DIM - 1, this.nextAxis++));
  }
}

export function useFakeAI(vectors: Record<string, number[]>): MarkerEmbedder {
  const embedder = new MarkerEmbedder(vectors);
  setAIProvidersForTesting({ classifier: new LocalClassifier(), embedder, timeoutMs: 2000 });
  return embedder;
}

export function resetAI() {
  setAIProvidersForTesting(null);
}
