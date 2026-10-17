import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { runAiTask } from "@/lib/matching/dispatch";

/**
 * Runs one AI task (matching a submission, maintenance, preparing answers for reuse).
 *   POST /api/jobs/run   Authorization: Bearer <CRON_SECRET>   { "task": "match", "complaintId": "…" }
 * Called by the app itself on Vercel, where only /api/jobs/* carries the embedding runtime.
 */
export const dynamic = "force-dynamic";
// A cold start downloads the ~23 MB model before the first embedding.
export const maxDuration = 120;

const taskSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("match"), complaintId: z.string().uuid() }),
  z.object({ task: z.literal("maintenance") }),
  z.object({ task: z.literal("embed-answers") }),
]);

function authorised(request: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function POST(request: Request) {
  if (!authorised(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = taskSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid task" }, { status: 400 });
  try {
    return Response.json({ ok: true, result: await runAiTask(parsed.data) });
  } catch (err) {
    console.error("AI task failed", { task: parsed.data.task, error: (err as Error).name });
    return Response.json({ error: "Task failed" }, { status: 500 });
  }
}
