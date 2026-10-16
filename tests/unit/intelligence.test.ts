import { describe, expect, it } from "vitest";
import { LocalClassifier, detectActivity, detectAspect } from "@/lib/ai/providers/local";
import { normalizeClassification } from "@/lib/ai";
import { LocalVerifier, type ProblemRepresentation } from "@/lib/ai/verifier";
import { applyVerification, calibrateSimilarity, decideMatch, DEFAULT_MATCHING_CONFIG, type MatchCandidate, type MatchSubject } from "@/lib/matching/engine";
import { studentStatusMessage } from "@/lib/services/student-messages";
import { COPY } from "@/config/app";
import { basis, vectorWithSimilarity } from "../support/fake-ai";

const categories = [
  { id: 2, slug: "exams-results", name: "Examination and Results", description: "" },
  { id: 5, slug: "welfare", name: "Student Welfare", description: "" },
  { id: 11, slug: "other", name: "Other", description: "" },
];
const classify = (text: string, category = "exams-results") =>
  new LocalClassifier().classify({ subject: text, description: text, selectedCategorySlug: category, categories });

describe("structured representation", () => {
  it("extracts the FIN 231 example without assuming missing information", async () => {
    const c = await classify("We still don't have the FIN 231 exam timetable for next week.");
    expect(c.courseCodes).toEqual(["FIN 231"]);
    expect(c.problemAspect).toBe("missing");
    expect(c.academicActivity).toBe("examination");
    expect(c.timeReference).toBe("next week");
    expect(c.underlyingProblem).toBe("FIN 231 examination timetable has not been published or provided");
    expect(c.academicPeriod).toBeNull(); // not stated -> unknown, never guessed
    expect(c.affectedGroup).toBeNull();
    expect(c.sensitivity).toBe("none");
  });

  it("distinguishes a missing timetable from an incorrect one", () => {
    expect(detectAspect("The FIN 231 timetable has not been released.")).toBe("missing");
    expect(detectAspect("The FIN 231 exam timetable contains an incorrect examination date.")).toBe("incorrect");
    expect(detectAspect("Our exam timetable is not out.")).toBe("missing");
    expect(detectAspect("We haven't received the schedule for our examinations.")).toBe("missing");
  });

  it("uses the first-mentioned activity as the topic", () => {
    expect(detectActivity("We have not received BUS 105 handouts. Exams are in four weeks.")).toBe("course_materials");
    expect(detectActivity("The exam timetable is not out")).toBe("examination");
  });

  it("identifies affected groups, urgency and sensitivity", async () => {
    const c = await classify("300 level students at the Yaba study centre: our exam is next week and the timetable is wrong. Urgent!");
    expect(c.affectedGroup).toBe("300 level, Yaba centre");
    expect(c.urgencyIndicators).toEqual(expect.arrayContaining(["exam imminent", "explicitly urgent"]));
    const s = await classify("A lecturer keeps harassing me after tutorials", "welfare");
    expect(s.sensitivity).toBe("highly_sensitive");
    expect(s.safetyFlag).toBe(true);
  });
});

describe("server-side validation of AI output", () => {
  const input = { subject: "Result missing", description: "My acc201 result is missing", selectedCategorySlug: "exams-results", categories };
  const raw = {
    categorySlug: "made-up-category",
    summaryTitle: "Result missing for student Chidi, call 08031234567",
    summary: "x".repeat(900),
    underlyingProblem: "unknown",
    problemType: "missing_result" as const,
    problemAspect: "missing" as const,
    academicActivity: "results" as const,
    courseCodes: ["acc 201", "not a code"],
    academicPeriod: "N/A",
    timeReference: null,
    affectedGroup: null,
    severity: "serious" as const,
    urgencyIndicators: [],
    academicImpact: true,
    safetyFlag: true,
    sensitivity: "none" as const,
  };

  it("treats model output as a recommendation: cleans, redacts, bounds and re-validates it", () => {
    const c = normalizeClassification(raw, input);
    expect(c.categorySlug).toBe("exams-results"); // unknown slug rejected
    expect(c.summaryTitle).not.toContain("08031234567");
    expect(c.summary.length).toBeLessThanOrEqual(400);
    expect(c.underlyingProblem).toBeNull(); // "unknown" -> null
    expect(c.academicPeriod).toBeNull();
    expect(c.courseCodes).toEqual(["ACC 201"]);
    expect(c.sensitivity).toBe("sensitive"); // safety flag implies sensitivity
  });
});

describe("matching decision engine v2", () => {
  const subject = (over: Partial<MatchSubject> = {}): MatchSubject => ({
    categoryId: 2, embedding: basis(0), courseCodes: ["FIN 231"], academicPeriod: null, problemType: "exam_schedule",
    problemAspect: "missing", academicActivity: "examination", affectedGroup: null, sensitivity: "none", ...over,
  });
  const cand = (id: string, cos: number, over: Partial<MatchCandidate> = {}): MatchCandidate => ({
    issueId: id, status: "in_progress", categoryId: 2, embedding: vectorWithSimilarity(cos, 2 + id.length), courseCodes: ["FIN 231"],
    academicPeriod: null, problemType: "exam_schedule", problemAspect: "missing", academicActivity: "examination", affectedGroup: null, ...over,
  });
  const cfg = DEFAULT_MATCHING_CONFIG;

  it("returns structured provenance: score, compatible and conflicting attributes, alternatives", () => {
    const d = decideMatch(subject(), [cand("a", 0.95), cand("bb", 0.2)], cfg);
    expect(d).toMatchObject({ kind: "auto", issueId: "a", similarity: 0.95 });
    expect(d.compatible).toEqual(expect.arrayContaining(["same kind of problem (missing)", "both mention FIN 231"]));
    expect(d.conflicts).toEqual([]);
    expect(d.alternatives[0].issueId).toBe("bb");
  });

  it("never auto-merges a missing timetable with an incorrect one, however similar the text", () => {
    const d = decideMatch(subject(), [cand("a", 0.99, { problemAspect: "incorrect" })], cfg);
    expect(d.kind).not.toBe("auto");
    expect(d.conflicts.join()).toMatch(/different kind of problem \(missing vs incorrect\)/);
  });

  it("does not merge reports from different study centres automatically", () => {
    const d = decideMatch(subject({ affectedGroup: "Ikeja centre" }), [cand("a", 0.99, { affectedGroup: "Yaba centre" })], cfg);
    expect(d.kind).toBe("review");
  });

  it("sends sensitive cases to restricted human review instead of auto-merging", () => {
    expect(decideMatch(subject({ sensitivity: "highly_sensitive" }), [cand("a", 0.99)], cfg)).toMatchObject({ kind: "review", reason: "sensitive" });
    expect(decideMatch(subject(), [cand("a", 0.99, { sensitive: true })], cfg)).toMatchObject({ kind: "review", reason: "sensitive" });
  });

  it("lets verification make a decision more cautious, never less", () => {
    const auto = decideMatch(subject(), [cand("a", 0.99)], cfg);
    expect(applyVerification(auto, { verdict: "different", reason: "x" }, false).kind).toBe("review");
    expect(applyVerification(auto, { verdict: "uncertain", reason: "x" }, true).kind).toBe("review");
    expect(applyVerification(auto, { verdict: "uncertain", reason: "x" }, false).kind).toBe("auto");
    const review = decideMatch(subject(), [cand("a", 0.6)], cfg); // 0.6 + 0.18 structural = review band
    expect(review.kind).toBe("review");
    expect(applyVerification(review, { verdict: "same", reason: "x" }, true).kind).toBe("review");
  });

  it("calibrates raw cosine per embedding model", () => {
    expect(calibrateSimilarity(0.7, "Xenova/all-MiniLM-L6-v2")).toBeGreaterThan(0.85);
    expect(calibrateSimilarity(0.33, "Xenova/all-MiniLM-L6-v2")).toBeLessThan(0.3);
    expect(calibrateSimilarity(0.7, "unknown-model")).toBe(0.7);
  });
});

describe("local verifier", () => {
  const rep = (over: Partial<ProblemRepresentation>): ProblemRepresentation => ({
    summary: "", underlyingProblem: null, problemType: "exam_schedule", problemAspect: "missing", academicActivity: "examination",
    courseCodes: [], academicPeriod: null, timeReference: null, affectedGroup: null, ...over,
  });
  it("rejects different aspects and courses and accepts agreeing attributes", async () => {
    const v = new LocalVerifier();
    expect((await v.verify(rep({}), rep({ problemAspect: "incorrect" }))).verdict).toBe("different");
    expect((await v.verify(rep({ courseCodes: ["ACC 201"] }), rep({ courseCodes: ["BUS 105"] }))).verdict).toBe("different");
    expect((await v.verify(rep({}), rep({}))).verdict).toBe("same");
  });
});

describe("status-based student feedback (verified values only)", () => {
  const deadline = new Date("2026-11-02T09:00:00Z");
  it("quotes the confirmed deadline when the matched issue is in progress", () => {
    const m = studentStatusMessage({ matchStatus: "auto_matched", complaintStatus: "in_progress", issue: { status: "in_progress", expected_resolution_at: deadline } });
    expect(m!.text).toContain("currently being addressed");
    expect(m!.text).toContain("2 Nov 2026");
  });
  it("never invents a date when none is confirmed", () => {
    const m = studentStatusMessage({ matchStatus: "auto_matched", complaintStatus: "in_progress", issue: { status: "in_progress", expected_resolution_at: null } });
    expect(m!.text).toContain(COPY.noDeadline);
  });
  it("explains a match to an issue still awaiting assessment, and resolved status", () => {
    expect(studentStatusMessage({ matchStatus: "auto_matched", complaintStatus: "received", issue: { status: "new", expected_resolution_at: null } })!.text).toMatch(/awaiting assessment/);
    expect(studentStatusMessage({ matchStatus: "auto_matched", complaintStatus: "resolved", issue: { status: "resolved", expected_resolution_at: null } })!.text).toBe(COPY.resolved);
  });
  it("says processing is under way while the AI is still working", () => {
    expect(studentStatusMessage({ matchStatus: "pending", complaintStatus: "received", issue: null })!.text).toMatch(/checking whether other students/);
  });
});
