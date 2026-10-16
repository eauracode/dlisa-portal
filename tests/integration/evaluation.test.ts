import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closePool, pool, rows } from "@/lib/db";
import type { CategoryOption } from "@/lib/ai/types";
import { LocalClassifier } from "@/lib/ai/providers/local";
import { TransformersEmbedder } from "@/lib/ai/providers/transformers";
import { LocalVerifier } from "@/lib/ai/verifier";
import { runEvaluation, type EvalDataset } from "@/lib/matching/evaluation";

/**
 * Runs the labelled evaluation set through the REAL local semantic model (no mocks). The
 * model must already be in ./.models (run `npm run ai:eval` once with network access);
 * otherwise this suite is skipped rather than downloading during tests.
 */
const MODEL = "Xenova/all-MiniLM-L6-v2";
const modelCached = existsSync(path.resolve(".models", ...MODEL.split("/")));

afterAll(closePool);

describe.skipIf(!modelCached)("grouping accuracy on the labelled DLI dataset (real embeddings)", () => {
  it("groups different wordings of the same problem and never merges different problems (spec 1, 3, 4, 5, 6)", async () => {
    const dataset = JSON.parse(readFileSync("tests/eval/dli-complaints.json", "utf8")) as EvalDataset;
    const categories = await rows<CategoryOption>(pool(), `select id, slug, name, description from issue_categories`);
    const r = await runEvaluation(
      dataset,
      { classifier: new LocalClassifier(), embedder: new TransformersEmbedder(MODEL, ".models"), verifier: new LocalVerifier(), timeoutMs: 10_000 },
      categories,
    );
    expect(r.falseMerges).toEqual([]);
    expect(r.hardNegativeMerges).toBe(0);
    expect(r.autoPrecision).toBe(1);
    expect(r.accuracy).toBeGreaterThanOrEqual(0.75);
    // The spec's paraphrase pair must be grouped automatically.
    const paraphrase = r.details.find((d) => d.text.startsWith("We haven't received the schedule"));
    expect(paraphrase).toMatchObject({ outcome: "auto", target: "exam-timetable-missing" });
  }, 120_000);
});
