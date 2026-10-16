import "./load-env";
import { readFile } from "node:fs/promises";
import { closePool, pool, rows } from "../src/lib/db";
import { getAIProviders } from "../src/lib/ai";
import type { CategoryOption } from "../src/lib/ai/types";
import { runEvaluation, type EvalDataset } from "../src/lib/matching/evaluation";
import { getMatchingConfig } from "../src/lib/services/settings";

/**
 * Measures grouping accuracy and false merges of the CONFIGURED providers and thresholds
 * against the labelled dataset. Run before enabling automatic grouping in production:
 *   npm run ai:eval            (add -- --verbose for per-item results)
 */
async function main() {
  const dataset = JSON.parse(await readFile("tests/eval/dli-complaints.json", "utf8")) as EvalDataset;
  const categories = await rows<CategoryOption>(pool(), `select id, slug, name, description from issue_categories order by sort_order`);
  const providers = getAIProviders();
  const config = await getMatchingConfig(pool());
  console.log(`Classifier: ${providers.classifier.provider}/${providers.classifier.model}`);
  console.log(`Embeddings: ${providers.embedder.provider}/${providers.embedder.model}`);
  console.log(`Verifier:   ${providers.verifier.provider}/${providers.verifier.model}`);
  console.log(`Thresholds: auto ≥ ${config.autoThreshold}, review ≥ ${config.reviewThreshold}\n`);

  const r = await runEvaluation(dataset, providers, categories, config);
  if (process.argv.includes("--verbose")) {
    for (const d of r.details) {
      console.log(`${d.outcome.padEnd(6)} ${(d.confidence ?? 0).toFixed(2)}  [${d.group}]${d.target && d.target !== d.group ? ` -> ${d.target}` : ""}  ${d.text.slice(0, 70)}`);
    }
    console.log();
  }
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  console.log(`Items:                      ${r.total}`);
  console.log(`Correct automatic grouping: ${r.correctAuto}`);
  console.log(`Correct new issues:         ${r.correctNew}`);
  console.log(`Sent to human review:       ${r.reviews} (${r.reviewsPointingRight} suggested the right issue)`);
  console.log(`Missed matches (new):       ${r.missed}`);
  console.log(`FALSE MERGES:               ${r.falseMerges.length} (hard negatives: ${r.hardNegativeMerges})`);
  console.log(`Fully automatic accuracy:   ${pct(r.accuracy)}  ·  automatic-grouping precision: ${pct(r.autoPrecision)}`);
  for (const f of r.falseMerges) console.log(`  ✗ [${f.expected}] joined [${f.joined}] at ${f.confidence.toFixed(2)}: ${f.item}`);
  if (r.falseMerges.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
