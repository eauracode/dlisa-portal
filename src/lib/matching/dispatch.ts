import { headers } from "next/headers";
import { pool } from "../db";
import { env } from "../env";
import { processMatchJob } from "./jobs";
import { runMaintenance } from "./maintenance";
import { ensureAnswerEmbeddings } from "../services/instant-answers";

/*
 * Where AI work (embeddings, matching) runs.
 *
 * Locally and on ordinary servers it runs in-process. On Vercel the embedding runtime (~68 MB)
 * is packaged only into the /api/jobs/* function (see next.config.ts): attaching it to every
 * route stops Vercel from bundling routes together and exceeds the Hobby plan's 12-function
 * limit. Pages and actions therefore hand the work to that endpoint over HTTP.
 */
export type AiTask = { task: "match"; complaintId: string } | { task: "maintenance" } | { task: "embed-answers" };

export function aiRunsRemotely(): boolean {
  return !!process.env.VERCEL;
}

/** Runs the task here, or asks the job endpoint to run it. Call inside `after()` or an action. */
export async function dispatchAiTask(task: AiTask, origin?: string): Promise<void> {
  if (!aiRunsRemotely()) return runAiTask(task).then(() => undefined);
  const secret = env().CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is required to run AI work on Vercel");
  const res = await fetch(`${origin ?? (await requestOrigin())}/api/jobs/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(task),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`AI job endpoint returned ${res.status}`);
}

/** The origin of the current request (read before `after()` callbacks, where headers are gone). */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL}`;
}

/** Executes a task in this process (used by the job endpoint, and directly off Vercel). */
export async function runAiTask(task: AiTask): Promise<unknown> {
  switch (task.task) {
    case "match":
      return processMatchJob(task.complaintId);
    case "maintenance":
      return runMaintenance();
    case "embed-answers":
      return ensureAnswerEmbeddings(pool());
  }
}
