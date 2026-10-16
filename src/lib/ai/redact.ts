/**
 * Data minimisation applied to complaint text before it is sent to an external AI provider
 * and before AI-derived summaries are stored as issue titles. Removes common direct
 * identifiers. This is best-effort pattern matching, not a guarantee of anonymity.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Nigerian phone numbers: +234..., 234..., 0[789][01]...
  [/(\+?234[\s-]?|0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}\b/g, "[phone]"],
  // UNILAG-style matriculation numbers (9+ digits) and other long digit runs.
  [/\b\d{8,}\b/g, "[number]"],
  [/\bhttps?:\/\/\S+/gi, "[link]"],
  // "my name is X Y" / "I am X Y" style self-identification.
  [/\b([Mm]y name is|I am called|[Nn]ame:)\s+[A-Z][a-z]+(\s+[A-Z][a-z]+){0,2}/g, "$1 [name]"],
];

export function redactIdentifiers(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
