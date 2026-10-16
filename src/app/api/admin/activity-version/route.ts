import { pool } from "@/lib/db";
import { getCurrentAdmin } from "@/lib/auth/current";
import { getActivityVersion } from "@/lib/services/admin/live";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * Read-only polling endpoint for the admin dashboards. Requires a staff session and
 * returns only an opaque hash, so it leaks nothing about the data itself.
 */
export async function GET() {
  const admin = await getCurrentAdmin();
  if (!admin || admin.must_change_password) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const version = createHash("sha256").update(await getActivityVersion(pool())).digest("hex").slice(0, 16);
  return Response.json({ version }, { headers: { "cache-control": "no-store" } });
}
