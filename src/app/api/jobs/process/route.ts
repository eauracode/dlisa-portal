import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runMaintenance } from "@/lib/matching/maintenance";

/**
 * Scheduled maintenance endpoint (e.g. Vercel Cron or any external scheduler):
 *   GET/POST /api/jobs/process   with header  Authorization: Bearer <CRON_SECRET>
 * Not callable from browsers without the secret; returns only counts.
 */
export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function handle(request: Request) {
  if (!authorised(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await runMaintenance());
  } catch {
    return Response.json({ error: "Maintenance failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
