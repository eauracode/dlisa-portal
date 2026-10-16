import { pool } from "../db";
import { pruneRateLimits } from "../security/rate-limit";
import { pruneSessions } from "../auth/sessions";
import { processDueJobs, recalculateOpenIssuePriorities } from "./jobs";

/**
 * One maintenance pass, run by the worker script or the scheduled /api/jobs/process call:
 *  1. re-create any missing matching jobs (safety net: no complaint is ever left behind)
 *  2. process due matching jobs (with retry/back-off)
 *  3. recalculate time-dependent priority signals
 *  4. prune expired sessions and rate-limit windows
 */
export async function runMaintenance() {
  const db = pool();
  const requeued = await db.query(
    `insert into match_jobs (complaint_id)
     select c.id from complaints c
      where c.match_status = 'pending' and c.consolidated_issue_id is null
        and not exists (select 1 from match_jobs j where j.complaint_id = c.id)
     on conflict (complaint_id) do nothing`,
  );
  const jobs = await processDueJobs(50);
  const priorities = await recalculateOpenIssuePriorities();
  await pruneSessions(db);
  await pruneRateLimits(db);
  return { requeued: requeued.rowCount ?? 0, jobs, prioritiesRecalculated: priorities };
}
