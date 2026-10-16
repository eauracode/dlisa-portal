import type { Severity } from "../ai/types";
import type { Priority } from "../validation";

/**
 * Configurable priority scoring. Severity and academic/safety impact carry more weight
 * than raw volume, so one urgent examination problem outranks a frequently repeated
 * routine suggestion. Volume uses *distinct* reporters (log-scaled); repeat submissions
 * from the same username add only a small, capped amount.
 */
export interface PriorityConfig {
  severityPoints: Record<Severity, number>;
  reporterPointsPerDoubling: number;
  reporterPointsCap: number;
  repeatSubmissionPoint: number;
  repeatSubmissionCap: number;
  growth24hThresholds: Array<{ minReports: number; points: number }>;
  pointsPerUnresolvedDays: { days: number; points: number; cap: number };
  overduePoints: number;
  academicImpactPoints: number;
  thresholds: { elevated: number; high: number; critical: number };
  /** Minimum level for issues flagged as a safety or serious welfare concern. */
  safetyFloor: Priority;
}

export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  severityPoints: { routine: 0, moderate: 10, serious: 25, urgent: 45 },
  reporterPointsPerDoubling: 6,
  reporterPointsCap: 30,
  repeatSubmissionPoint: 1,
  repeatSubmissionCap: 5,
  growth24hThresholds: [
    { minReports: 10, points: 15 },
    { minReports: 3, points: 8 },
  ],
  pointsPerUnresolvedDays: { days: 3, points: 1, cap: 10 },
  overduePoints: 12,
  academicImpactPoints: 10,
  thresholds: { elevated: 20, high: 40, critical: 60 },
  safetyFloor: "high",
};

export interface PrioritySignals {
  severity: Severity;
  distinctReporters: number;
  totalSubmissions: number;
  reportsLast24h: number;
  daysUnresolved: number;
  overdue: boolean;
  academicImpact: boolean;
  safetyFlag: boolean;
}

export interface PriorityResult {
  priority: Priority;
  score: number;
  factors: Array<{ factor: string; points: number }>;
}

export const PRIORITY_RANK: Record<Priority, number> = { normal: 0, elevated: 1, high: 2, critical: 3 };

export function computePriority(signals: PrioritySignals, config: PriorityConfig = DEFAULT_PRIORITY_CONFIG): PriorityResult {
  const factors: Array<{ factor: string; points: number }> = [];
  const add = (factor: string, points: number) => {
    if (points > 0) factors.push({ factor, points: Math.round(points * 10) / 10 });
  };

  add(`severity: ${signals.severity}`, config.severityPoints[signals.severity]);
  add(
    `${signals.distinctReporters} distinct reporter(s)`,
    Math.min(config.reporterPointsCap, config.reporterPointsPerDoubling * Math.log2(1 + Math.max(0, signals.distinctReporters))),
  );
  const repeats = Math.max(0, signals.totalSubmissions - signals.distinctReporters);
  add(`${repeats} repeat submission(s)`, Math.min(config.repeatSubmissionCap, repeats * config.repeatSubmissionPoint));
  const growth = [...config.growth24hThresholds].sort((a, b) => b.minReports - a.minReports).find((g) => signals.reportsLast24h >= g.minReports);
  if (growth) add(`${signals.reportsLast24h} report(s) in last 24h`, growth.points);
  const u = config.pointsPerUnresolvedDays;
  add(`${Math.floor(signals.daysUnresolved)} day(s) unresolved`, Math.min(u.cap, Math.floor(signals.daysUnresolved / u.days) * u.points));
  if (signals.overdue) add("expected resolution date passed", config.overduePoints);
  if (signals.academicImpact) add("academic activity affected", config.academicImpactPoints);

  const score = factors.reduce((s, f) => s + f.points, 0);
  const t = config.thresholds;
  let priority: Priority = score >= t.critical ? "critical" : score >= t.high ? "high" : score >= t.elevated ? "elevated" : "normal";

  if (signals.safetyFlag) {
    factors.push({ factor: "safety/welfare concern flagged", points: 0 });
    const floor = signals.severity === "urgent" ? "critical" : config.safetyFloor;
    if (PRIORITY_RANK[floor] > PRIORITY_RANK[priority]) priority = floor;
  }
  return { priority, score: Math.round(score * 10) / 10, factors };
}
