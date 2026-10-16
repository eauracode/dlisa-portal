import { describe, expect, it } from "vitest";
import { computePriority, PRIORITY_RANK, type PrioritySignals } from "@/lib/priority/engine";

const base: PrioritySignals = {
  severity: "routine",
  distinctReporters: 1,
  totalSubmissions: 1,
  reportsLast24h: 1,
  daysUnresolved: 0,
  overdue: false,
  academicImpact: false,
  safetyFlag: false,
};

describe("computePriority", () => {
  it("rates a single routine report as normal", () => {
    expect(computePriority(base).priority).toBe("normal");
  });

  it("ranks one serious exam issue above a frequently reported routine suggestion", () => {
    const exam = computePriority({ ...base, severity: "serious", academicImpact: true });
    const suggestion = computePriority({ ...base, distinctReporters: 40, totalSubmissions: 45, reportsLast24h: 2 });
    expect(PRIORITY_RANK[exam.priority]).toBeGreaterThan(PRIORITY_RANK[suggestion.priority]);
  });

  it("increases with distinct reporters", () => {
    const one = computePriority({ ...base, severity: "moderate" });
    const many = computePriority({ ...base, severity: "moderate", distinctReporters: 15, totalSubmissions: 15 });
    expect(many.score).toBeGreaterThan(one.score);
    expect(PRIORITY_RANK[many.priority]).toBeGreaterThan(PRIORITY_RANK[one.priority]);
  });

  it("does not let repeat submissions from one student act like many students", () => {
    const repeats = computePriority({ ...base, distinctReporters: 1, totalSubmissions: 30 });
    const students = computePriority({ ...base, distinctReporters: 30, totalSubmissions: 30 });
    expect(repeats.score).toBeLessThan(students.score);
    expect(repeats.priority).toBe("normal");
  });

  it("adds points for rapid growth, age and missed deadlines", () => {
    const fresh = computePriority({ ...base, severity: "moderate" });
    const stale = computePriority({ ...base, severity: "moderate", daysUnresolved: 30, overdue: true, reportsLast24h: 12 });
    expect(stale.score).toBeGreaterThan(fresh.score);
    expect(stale.factors.map((f) => f.factor).join(" ")).toMatch(/expected resolution date passed/);
  });

  it("applies a safety floor and makes urgent safety concerns critical", () => {
    expect(computePriority({ ...base, safetyFlag: true }).priority).toBe("high");
    expect(computePriority({ ...base, safetyFlag: true, severity: "urgent" }).priority).toBe("critical");
  });
});
