/**
 * Deterministic extraction of structured, non-sensitive context. Used by every provider so
 * that course codes and academic periods are captured consistently even when a remote
 * model omits them.
 */

const COURSE_CODE_RE = /\b([A-Za-z]{3})\s?-?(\d{3})\b/g;
// Three-letter words that precede numbers in ordinary prose and are not course prefixes.
const NOT_COURSE_PREFIX = new Set(["THE", "AND", "FOR", "ARE", "WAS", "HAS", "NOT", "BUT", "ALL", "OUT", "OUR", "YOU", "ROOM", "PAY", "NGN", "USD", "TOP"]);

export function extractCourseCodes(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(COURSE_CODE_RE)) {
    const prefix = m[1].toUpperCase();
    if (NOT_COURSE_PREFIX.has(prefix)) continue;
    // Require the prefix to be written in capitals in the source, or adjacent to the number
    // ("acc201"), to avoid matching phrases like "got 200".
    if (m[1] !== prefix && !/^[A-Za-z]{3}\d{3}$/.test(m[0])) continue;
    found.add(`${prefix} ${m[2]}`);
    if (found.size >= 10) break;
  }
  return [...found].sort();
}

export function extractAcademicPeriod(text: string): string | null {
  const t = text.toLowerCase();
  const session = t.match(/\b(20\d{2})\s?[/-]\s?(20\d{2})\b/);
  let semester: string | null = null;
  if (/\b(first|1st|harmattan)\s+semester\b/.test(t)) semester = "first semester";
  else if (/\b(second|2nd|rain)\s+semester\b/.test(t)) semester = "second semester";
  const sessionText = session ? `${session[1]}/${session[2]}` : null;
  if (semester && sessionText) return `${semester} ${sessionText}`;
  return semester ?? sessionText;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
