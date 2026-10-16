import { one, type Db } from "../db";

export interface RateLimitRule {
  /** Logical name, e.g. "login:ip". Combined with the subject to form the bucket key. */
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  studentLoginByClient: { name: "student-login:client", limit: 30, windowSeconds: 15 * 60 },
  studentRegisterByClient: { name: "student-register:client", limit: 20, windowSeconds: 60 * 60 },
  usernameCheckByClient: { name: "username-check:client", limit: 120, windowSeconds: 15 * 60 },
  adminLoginByClient: { name: "admin-login:client", limit: 10, windowSeconds: 15 * 60 },
  complaintByStudentHour: { name: "complaint:student:hour", limit: 5, windowSeconds: 60 * 60 },
  complaintByStudentDay: { name: "complaint:student:day", limit: 15, windowSeconds: 24 * 60 * 60 },
  complaintByClientHour: { name: "complaint:client:hour", limit: 20, windowSeconds: 60 * 60 },
  reviewRequestByStudentDay: { name: "review-request:student:day", limit: 5, windowSeconds: 24 * 60 * 60 },
  studentReplyHour: { name: "reply:student:hour", limit: 10, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter stored in Postgres so limits hold across server instances.
 * Atomically increments the current window and reports whether the hit is allowed.
 */
export async function consumeRateLimit(db: Db, rule: RateLimitRule, subject: string): Promise<RateLimitResult> {
  const bucket = `${rule.name}:${subject}`;
  const row = await one<{ hits: number; window_start: Date }>(
    db,
    `insert into rate_limits (bucket, window_start, hits)
       values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
     returning hits, window_start`,
    [bucket, rule.windowSeconds],
  );
  const hits = row?.hits ?? 1;
  const windowEnd = (row?.window_start.getTime() ?? Date.now()) + rule.windowSeconds * 1000;
  return {
    allowed: hits <= rule.limit,
    remaining: Math.max(0, rule.limit - hits),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000)),
  };
}

/** Removes expired windows. Called by the maintenance job. */
export async function pruneRateLimits(db: Db) {
  await db.query(`delete from rate_limits where window_start < now() - interval '2 days'`);
}
