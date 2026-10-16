import { createHash } from "node:crypto";
import { extractAcademicPeriod, extractCourseCodes, truncate } from "../extract";
import { redactIdentifiers } from "../redact";
import type { AcademicActivity, Classification, ClassificationInput, Classifier, Embedder, ProblemAspect, ProblemType, Severity } from "../types";

/**
 * Offline provider. No complaint text leaves the server.
 *
 * Classification uses a keyword lexicon; embeddings are hashed bag-of-n-gram vectors with
 * synonym folding. This captures lexical overlap well but NOT deeper meaning (paraphrases
 * with different vocabulary score lower), so it is intended for development, testing and
 * privacy-sensitive deployments. Configure an embedding model for semantic matching.
 */

const PROBLEM_LEXICON: Array<[ProblemType, RegExp]> = [
  ["harassment", /\b(harass\w*|sexual\w*|assault\w*|bully\w*|intimidat\w*|threaten\w*|abus\w*)\b/i],
  ["welfare_safety", /\b(unsafe|danger\w*|attack\w*|robbed|robbery|stolen|theft|security|violence|fight\w*)\b/i],
  ["welfare_health", /\b(sick|ill|illness|health|hospital|medical|clinic|disab\w*|pregnan\w*|depress\w*|mental|suicid\w*|counsel\w*)\b/i],
  ["missing_result", /\b(result|results|grade|grades|score|scores)\b.*\b(missing|not (been )?(released|uploaded|published|showing|available)|absent|withheld|ncr|incomplete)\b|\b(missing|withheld|unreleased)\b.*\b(result|results|grade|score)s?\b/i],
  ["result_error", /\b(wrong|incorrect|error|mistake|discrepan\w*|lower than|recheck|remark\w*)\b.*\b(result|grade|score|cgpa|gpa)s?\b|\b(result|grade|score|cgpa|gpa)s?\b.*\b(wrong|incorrect|error|mistake)\b/i],
  ["exam_schedule", /\b(exam|exams|examination|examinations|test|cbt)\b.*\b(timetable|schedule|clash\w*|date|postpone\w*|reschedul\w*|moved)\b|\b(timetable|schedule|clash\w*)\b.*\b(exam|examination|cbt)s?\b/i],
  ["exam_conduct", /\b(exam|examination|cbt|invigilat\w*|malpractice|question paper|exam hall)\b/i],
  ["lecture_schedule", /\b(lecture|lectures|class|classes|tutorial\w*|facilitat\w*)\b.*\b(timetable|schedule|clash\w*|time|cancel\w*|postpone\w*)\b/i],
  ["lecturer_availability", /\b(lecturer|lecturers|facilitator\w*|tutor\w*)\b.*\b(absent|not (showing|coming|available)|missed|unavailable|no show)\b/i],
  ["course_material_access", /\b(course material\w*|materials|textbook\w*|handout\w*|module\w*|study pack\w*|e-?book\w*)\b/i],
  ["lms_portal_access", /\b(portal|lms|login|log in|password|website|platform|e-?learning|moodle|dashboard)\b/i],
  ["registration", /\b(registration|register|course form|add\/drop|enrol\w*)\b/i],
  ["fees_payment", /\b(fee|fees|payment|paid|remita|tuition|refund|charges?|receipt)\b/i],
  ["documents_records", /\b(id card|identity card|transcript|certificate|statement of result|admission letter|document\w*|records?)\b/i],
  ["communication", /\b(announcement\w*|notice\w*|information|inform\w*|communicat\w*|email\w*|sms|whatsapp|update\w*)\b/i],
  ["internet_connectivity", /\b(internet|network|wi-?fi|data|bandwidth|connection|connectivity)\b/i],
  ["facility", /\b(centre|center|study cent\w*|hall|classroom|toilet|electricity|power|light|generator|chairs?|facility|facilities|library)\b/i],
  ["suggestion", /\b(suggest\w*|recommend\w*|propos\w*|it would be (good|nice|better)|please consider|idea)\b/i],
];

const CATEGORY_FOR_PROBLEM: Record<ProblemType, string> = {
  missing_result: "exams-results",
  result_error: "exams-results",
  exam_schedule: "exams-results",
  exam_conduct: "exams-results",
  lecture_schedule: "timetable",
  lecturer_availability: "academic",
  course_material_access: "materials",
  lms_portal_access: "materials",
  registration: "academic",
  fees_payment: "admin-services",
  documents_records: "admin-services",
  communication: "communication",
  facility: "facilities",
  internet_connectivity: "facilities",
  welfare_safety: "welfare",
  welfare_health: "welfare",
  harassment: "welfare",
  suggestion: "suggestions",
  general_feedback: "general-feedback",
  other: "other",
};

const URGENT_RE = /\b(suicid\w*|kill\w*|assault\w*|rape|raped|attack\w*|emergency|life.threatening|bleeding|weapon|kidnap\w*)\b/i;
const SERIOUS_RE =
  /\b(harass\w*|threat\w*|unsafe|exam (is )?(tomorrow|today|next week)|cannot graduate|can't graduate|graduat\w*|deadline|expel\w*|withdraw\w*|carry.?over|fail\w*|abus\w*|stolen|robbed|sick|hospital)\b/i;
const MODERATE_RE = /\b(urgent\w*|asap|immediately|affect\w*|unable|cannot|can't|weeks?|months?|still|again|many students|all students|everyone)\b/i;

function detectSeverity(text: string, problem: ProblemType): Severity {
  if (URGENT_RE.test(text)) return "urgent";
  if (problem === "harassment" || problem === "welfare_safety") return "serious";
  if (SERIOUS_RE.test(text)) return "serious";
  if (MODERATE_RE.test(text)) return "moderate";
  return "routine";
}

// Ordered: the first matching aspect wins.
const ASPECT_LEXICON: Array<[ProblemAspect, RegExp]> = [
  ["misconduct", /\b(harass\w*|extort\w*|bully\w*|threat\w*|assault\w*|bribe\w*|demand(ed|ing)? (money|cash|payment)|rude|insult\w*|abus\w*|intimidat\w*)\b/i],
  ["incorrect", /\b(wrong|incorrect\w*|errors?|mistakes?|inaccura\w*|discrepan\w*|mismatch\w*|not correct|lower than (expected|i (got|scored)))\b/i],
  ["conflict", /\b(clash\w*|overlap\w*|same time|double[- ]booked|conflicts? with)\b/i],
  ["inaccessible", /\b(can'?t|cannot|unable to|could not|couldn'?t) (access|log ?in|login|open|load|download|view|submit)|\bnot (loading|opening|working on)|\b(won'?t|doesn'?t|does not|will not) (load|open)|\b(site|portal|lms|website|platform) (is |has been )?down\b|\blocked out\b|\bkeeps? (failing|crashing)\b/i],
  ["missing", /\b(not|n'?t) (yet )?(been )?(out|released|published|uploaded|available|received|provided|given|distributed|posted|shared|sent)\b|\b(have|has)(n'?t| not) (got|gotten|received|seen)\b|\b(missing|unavailable|withheld|absent)\b|\b(has|have)(n'?t| not) (come|shown up|turned up|attended)\b|\bstill (don'?t|do not|doesn'?t) have\b|\byet to (be )?(release|publish|receive|upload|see)\w*|\bno (exam |examination )?(timetable|schedule|result|results|materials?|handouts?|notice)\b|\bis not out\b/i],
  ["delayed", /\b(delay\w*|late|postpone\w*|still waiting|taking (too )?long|for (weeks|months)|weeks now|not yet|slow)\b/i],
  ["cost", /\b(overcharg\w*|extra (fee|charge)s?|refund\w*|charged twice|double (payment|charge)|too expensive)\b/i],
  ["poor_quality", /\b(broken|not working|faulty|poor|bad condition|dirty|no (power|electricity|water|light)|too hot|leak\w*|damaged)\b/i],
  ["request", /\b(suggest\w*|recommend\w*|please (consider|add|introduce|provide)|it would be (good|nice|better|helpful)|request(ing)?)\b/i],
];

// Ordered by specificity.
const ACTIVITY_LEXICON: Array<[AcademicActivity, RegExp]> = [
  ["results", /\b(results?|grades?|scores?|cgpa|gpa|transcript)\b/i],
  ["examination", /\b(exams?|examinations?|cbt|test|invigilat\w*|exam hall)\b/i],
  ["tutorial", /\b(tutorials?|facilitation)\b/i],
  ["lecture", /\b(lectures?|class(es)?|lecturers?|facilitators?)\b/i],
  ["registration", /\b(registration|register|course form|add\/drop|enrol\w*)\b/i],
  ["course_materials", /\b(course materials?|materials|handouts?|textbooks?|modules?|study packs?|lms|e-?learning)\b/i],
  ["assignment", /\b(assignments?|tma|coursework)\b/i],
  ["project", /\b(project|supervisor|thesis|dissertation)\b/i],
  ["graduation", /\b(graduat\w*|convocation|clearance|nysc)\b/i],
  ["fees", /\b(fees?|tuition|remita|payment|paid)\b/i],
  ["timetable", /\b(timetable|schedule)\b/i],
  ["facilities", /\b(centre|center|hall|toilets?|electricity|power|generator|internet|wi-?fi)\b/i],
  ["welfare", /\b(welfare|safety|health|harass\w*|security)\b/i],
];

const TIME_RE =
  /\b((next|this|last) (week|month|semester|session|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|since (monday|tuesday|wednesday|thursday|friday|saturday|sunday|last \w+|\w+ (days|weeks|months) ago)|for (\d+|two|three|four|several|many) (days|weeks|months)|tomorrow|today|yesterday|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

function extractAffectedGroup(text: string): string | null {
  const parts: string[] = [];
  const level = text.match(/\b([1-5]00)\s?(level|lvl)\b/i);
  if (level) parts.push(`${level[1]} level`);
  const year = text.match(/\b(final[- ]year|year (one|two|three|four|[1-5]))\b/i);
  if (year) parts.push(year[1].toLowerCase());
  const centre = text.match(/\b([A-Z][a-z]+) (study )?cent(re|er)\b/);
  if (centre) parts.push(`${centre[1]} centre`);
  const programme = text.match(/\b(accounting|business administration|economics|finance|banking|marketing|insurance|computer science|education|political science|mass communication|public administration|actuarial science) (students|programme|program|department)\b/i);
  if (programme) parts.push(programme[1].toLowerCase());
  return parts.length ? parts.join(", ").slice(0, 80) : null;
}

const HIGHLY_SENSITIVE_RE = /\b(sexual\w*|rape|raped|assault\w*|suicid\w*|self[- ]harm|kill (my|him|her)self|abus\w*|harass\w*|threat\w*|stalk\w*|weapon)\b/i;
const SENSITIVE_RE = /\b(sick|illness|health|hospital|medical|mental|depress\w*|anxiety|disab\w*|pregnan\w*|bereave\w*|died|death|hardship|homeless|hungry|extort\w*|bribe\w*)\b/i;

const URGENCY_PATTERNS: Array<[string, RegExp]> = [
  ["exam imminent", /\bexams?\b.{0,40}\b(tomorrow|today|next week|this week|in (a|one|two|\d) (days?|weeks?))\b|\b(tomorrow|next week)'?s? exams?\b/i],
  ["deadline", /\bdeadline\b/i],
  ["graduation at risk", /\b(can'?t|cannot|might not|won'?t be able to) graduate\b|\bgraduation\b/i],
  ["safety risk", /\b(unsafe|danger\w*|threat\w*|attack\w*|emergency)\b/i],
  ["ongoing for weeks", /\b(for (weeks|months)|weeks now|(two|three|four|several) weeks)\b/i],
  ["many students affected", /\b(many|all|most) (of us|students)\b|\beveryone\b/i],
  ["explicitly urgent", /\b(urgent\w*|asap|immediately)\b/i],
];

const ASPECT_PHRASES: Record<ProblemAspect, string> = {
  missing: "has not been published or provided",
  incorrect: "contains incorrect information",
  delayed: "is delayed",
  inaccessible: "cannot be accessed",
  conflict: "has a clash or overlap",
  poor_quality: "is broken or inadequate",
  misconduct: "involves reported misconduct",
  cost: "involves a disputed charge",
  request: "request or suggestion",
  other: "reported problem",
};

export function detectAspect(text: string): ProblemAspect | null {
  return ASPECT_LEXICON.find(([, re]) => re.test(text))?.[0] ?? null;
}

export function detectActivity(text: string): AcademicActivity | null {
  // The activity mentioned first is usually the topic; later mentions are context
  // ("BUS 105 handouts not received. Exams are in four weeks").
  const found = ACTIVITY_LEXICON.map(([a, re]) => ({ a, at: text.search(re) }))
    .filter((f) => f.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((f) => f.a);
  if (!found.length) return null;
  // "exam timetable" is about the examination, not a lecture timetable.
  if (found[0] === "timetable" && found.includes("examination")) return "examination";
  return found[0];
}

export class LocalClassifier implements Classifier {
  readonly provider = "local";
  readonly model = "lexicon-v2";

  async classify(input: ClassificationInput): Promise<Classification> {
    const text = `${input.subject}\n${input.description}`;
    const problemType = PROBLEM_LEXICON.find(([, re]) => re.test(text))?.[0] ?? (input.selectedCategorySlug === "general-feedback" ? "general_feedback" : "other");
    const inferredSlug = CATEGORY_FOR_PROBLEM[problemType];
    // Respect the student's choice unless it is a catch-all and we found something specific.
    const vague = ["other", "general-feedback"].includes(input.selectedCategorySlug);
    const categorySlug = vague && inferredSlug !== "other" ? inferredSlug : input.selectedCategorySlug;
    const severity = detectSeverity(text, problemType);
    const highlySensitive = HIGHLY_SENSITIVE_RE.test(text) || problemType === "harassment";
    const safetyFlag = highlySensitive || problemType === "welfare_safety" || URGENT_RE.test(text);
    const academicCategories = new Set(input.categories.filter((c) => ["academic", "exams-results", "timetable", "materials"].includes(c.slug)).map((c) => c.slug));
    const courseCodes = extractCourseCodes(text);
    const aspect = detectAspect(text);
    const activity = detectActivity(text);
    const thing = [courseCodes[0], activity === "examination" && /timetable|schedule/i.test(text) ? "examination timetable" : activity?.replace("_", " ")]
      .filter(Boolean)
      .join(" ");
    return {
      categorySlug,
      summaryTitle: truncate(redactIdentifiers(input.subject), 100),
      summary: truncate(redactIdentifiers(input.description.replace(/\s+/g, " ")), 400),
      underlyingProblem: aspect && thing ? `${thing.charAt(0).toUpperCase()}${thing.slice(1)} ${ASPECT_PHRASES[aspect]}` : null,
      problemType,
      problemAspect: aspect,
      academicActivity: activity,
      courseCodes,
      academicPeriod: extractAcademicPeriod(text),
      timeReference: text.match(TIME_RE)?.[0].toLowerCase() ?? null,
      affectedGroup: extractAffectedGroup(text),
      severity,
      urgencyIndicators: URGENCY_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label),
      academicImpact: academicCategories.has(categorySlug),
      safetyFlag,
      sensitivity: highlySensitive ? "highly_sensitive" : SENSITIVE_RE.test(text) || safetyFlag ? "sensitive" : "none",
    };
  }
}

// ---------------------------------------------------------------------------
// Hashed n-gram embeddings
// ---------------------------------------------------------------------------

export const LOCAL_EMBEDDING_DIMENSIONS = 512;

const STOPWORDS = new Set(
  "a an the and or but if of to in on at by for with from as is are was were be been being have has had do does did i me my we our you your he she they them their it its this that these those there here not no so very can could would should will shall may might must just also too than then please kindly sir ma dear about into over under again still yet up down out who what when where which why how all any some such only own same other more most much many".split(" "),
);

// Fold common synonyms and Nigerian-English variants to shared tokens.
const SYNONYMS: Record<string, string> = {
  results: "result", grade: "result", grades: "result", score: "result", scores: "result", marks: "result",
  exam: "exam", exams: "exam", examination: "exam", examinations: "exam", cbt: "exam", test: "exam",
  lecturer: "lecturer", lecturers: "lecturer", facilitator: "lecturer", facilitators: "lecturer", tutor: "lecturer",
  lecture: "lecture", lectures: "lecture", class: "lecture", classes: "lecture", tutorial: "lecture",
  lms: "portal", website: "portal", platform: "portal", elearning: "portal", moodle: "portal",
  login: "access", log: "access", password: "access", access: "access", accessing: "access",
  material: "material", materials: "material", handout: "material", handouts: "material", textbook: "material", module: "material", modules: "material",
  missing: "missing", unavailable: "missing", absent: "missing", withheld: "missing", unreleased: "missing",
  released: "release", uploaded: "release", published: "release", upload: "release", publish: "release",
  fee: "fee", fees: "fee", payment: "fee", paid: "fee", remita: "fee", tuition: "fee",
  timetable: "schedule", schedule: "schedule", scheduled: "schedule", rescheduled: "schedule", postponed: "schedule", clash: "schedule", clashes: "schedule",
  internet: "network", wifi: "network", network: "network", connection: "network", data: "network",
  centre: "centre", center: "centre", hall: "centre",
};

function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(ings|ing|edly|ed|ies|es|s|ly)$/, (m) => (m === "ies" ? "y" : ""));
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? stem(w));
}

function bucket(feature: string): { index: number; sign: number } {
  const h = createHash("md5").update(feature).digest();
  return { index: h.readUInt32LE(0) % LOCAL_EMBEDDING_DIMENSIONS, sign: h[4] & 1 ? 1 : -1 };
}

export function localEmbedding(text: string): number[] {
  const vec = new Array<number>(LOCAL_EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const add = (feature: string, weight: number) => {
    const { index, sign } = bucket(feature);
    vec[index] += sign * weight;
  };
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  // Sub-linear term frequency so repeated words do not dominate.
  for (const [t, c] of counts) add(`w:${t}`, 1 + Math.log(c));
  for (let i = 0; i + 1 < tokens.length; i++) add(`b:${tokens[i]}_${tokens[i + 1]}`, 0.6);
  for (const t of counts.keys()) {
    if (t.length < 5) continue;
    for (let i = 0; i + 3 <= t.length; i++) add(`c:${t.slice(i, i + 3)}`, 0.15);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export class LocalEmbedder implements Embedder {
  readonly provider = "local";
  readonly model = `hashed-ngrams-${LOCAL_EMBEDDING_DIMENSIONS}-v1`;

  async embed(text: string): Promise<number[]> {
    return localEmbedding(text);
  }
}
