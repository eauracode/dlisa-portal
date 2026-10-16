import "./load-env";
import { closePool } from "../src/lib/db";
import { runMaintenance } from "../src/lib/matching/maintenance";

/**
 * Background worker: processes matching retries and maintenance.
 *   npm run worker          run continuously (every WORKER_INTERVAL_SECONDS, default 60)
 *   npm run worker -- --once  single pass (for cron)
 */
const once = process.argv.includes("--once");
const interval = Number(process.env.WORKER_INTERVAL_SECONDS ?? 60) * 1000;
let stopping = false;

async function pass() {
  try {
    const result = await runMaintenance();
    console.log(new Date().toISOString(), JSON.stringify(result));
  } catch (err) {
    console.error(new Date().toISOString(), "maintenance failed:", err instanceof Error ? err.message : err);
  }
}

async function main() {
  await pass();
  while (!once && !stopping) {
    await new Promise((r) => setTimeout(r, interval));
    if (!stopping) await pass();
  }
  await closePool();
}

process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));
main();
