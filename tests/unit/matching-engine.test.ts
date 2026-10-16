import { describe, expect, it } from "vitest";
import { cosineSimilarity, decideMatch, DEFAULT_MATCHING_CONFIG, type MatchCandidate, type MatchSubject } from "@/lib/matching/engine";
import { basis, vectorWithSimilarity } from "../support/fake-ai";

const subject = (over: Partial<MatchSubject> = {}): MatchSubject => ({
  categoryId: 2,
  embedding: basis(0),
  courseCodes: [],
  academicPeriod: null,
  problemType: "missing_result",
  ...over,
});

const candidate = (id: string, cos: number, over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  issueId: id,
  status: "in_progress",
  categoryId: 2,
  embedding: vectorWithSimilarity(cos, 2 + id.length),
  courseCodes: [],
  academicPeriod: null,
  problemType: "missing_result",
  ...over,
});

describe("cosineSimilarity", () => {
  it("handles identical, orthogonal and mismatched vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("decideMatch", () => {
  const cfg = DEFAULT_MATCHING_CONFIG;

  it("auto-groups a high-confidence compatible match", () => {
    const d = decideMatch(subject(), [candidate("a", 0.95), candidate("bb", 0.3)], cfg);
    expect(d.kind).toBe("auto");
    if (d.kind === "auto") {
      expect(d.issueId).toBe("a");
      expect(d.explanation).toMatch(/same category/);
    }
  });

  it("sends an uncertain match to review", () => {
    const d = decideMatch(subject(), [candidate("a", 0.75)], cfg);
    expect(d.kind).toBe("review");
  });

  it("creates a new issue for a low-confidence match", () => {
    const d = decideMatch(subject(), [candidate("a", 0.4)], cfg);
    expect(d).toMatchObject({ kind: "new", bestConfidence: expect.any(Number) });
  });

  it("creates a new issue when there are no candidates", () => {
    expect(decideMatch(subject(), [], cfg)).toMatchObject({ kind: "new", bestConfidence: null });
  });

  it("never auto-groups complaints about different courses, even when text is near-identical", () => {
    const d = decideMatch(subject({ courseCodes: ["ACC 201"] }), [candidate("a", 0.99, { courseCodes: ["BUS 105"] })], cfg);
    expect(d.kind).toBe("review");
    if (d.kind === "review") expect(d.explanation).toMatch(/different courses/);
  });

  it("never auto-groups complaints about different academic periods", () => {
    const d = decideMatch(
      subject({ academicPeriod: "first semester 2025/2026" }),
      [candidate("a", 0.99, { academicPeriod: "second semester 2024/2025" })],
      cfg,
    );
    expect(d.kind).toBe("review");
  });

  it("never auto-groups distinct underlying problems", () => {
    const d = decideMatch(subject({ problemType: "result_error" }), [candidate("a", 0.99, { problemType: "missing_result" })], cfg);
    expect(d.kind).not.toBe("auto");
  });

  it("boosts confidence for a shared course code", () => {
    const d = decideMatch(subject({ courseCodes: ["ACC 201"] }), [candidate("a", 0.85, { courseCodes: ["ACC 201"] })], cfg);
    expect(d.kind).toBe("auto"); // 0.85 + category + problem type + course
  });

  it("sends ambiguous near-equal candidates to review", () => {
    const d = decideMatch(subject(), [candidate("a", 0.95), candidate("bb", 0.945)], cfg);
    expect(d.kind).toBe("review");
  });

  it("flags a strong match with a resolved issue as a possible recurrence", () => {
    const d = decideMatch(subject(), [candidate("a", 0.97, { status: "resolved" })], cfg);
    expect(d.kind).toBe("review");
    if (d.kind === "review") {
      expect(d.reviewKind).toBe("possible_recurrence");
      expect(d.explanation).toMatch(/previously resolved/);
    }
  });

  it("respects configurable thresholds", () => {
    const strict = { ...cfg, autoThreshold: 0.99, reviewThreshold: 0.95 };
    // 0.8 similarity + 0.07 structural evidence = 0.87: review by default, new under strict settings.
    expect(decideMatch(subject(), [candidate("a", 0.8)], cfg).kind).toBe("review");
    expect(decideMatch(subject(), [candidate("a", 0.8)], strict).kind).toBe("new");
  });
});
