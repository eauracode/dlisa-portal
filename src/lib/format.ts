import { APP_CONFIG } from "@/config/app";

const dateTimeFmt = new Intl.DateTimeFormat(APP_CONFIG.locale, {
  timeZone: APP_CONFIG.timeZone,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat(APP_CONFIG.locale, { timeZone: APP_CONFIG.timeZone, day: "numeric", month: "short", year: "numeric" });

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateTimeFmt.format(new Date(d));
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return dateFmt.format(new Date(d));
}

/** Value for <input type="datetime-local"> in Lagos time. */
export function toDateTimeLocal(d: Date | string | null | undefined): string {
  if (!d) return "";
  const shifted = new Date(new Date(d).getTime() + 60 * 60 * 1000); // UTC+01:00, no DST
  return shifted.toISOString().slice(0, 16);
}

export function relativeTime(d: Date | string): string {
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDate(d);
}

export const COMPLAINT_STATUS_LABELS: Record<string, string> = {
  received: "Received",
  under_review: "Under review",
  in_progress: "In progress",
  awaiting_external_action: "Awaiting another office",
  resolved: "Resolved",
  review_requested: "Review requested",
  closed: "Closed",
};

export const ISSUE_STATUS_LABELS: Record<string, string> = {
  new: "New",
  under_review: "Under review",
  in_progress: "In progress",
  awaiting_external_action: "Awaiting external action",
  resolved: "Resolved",
  closed: "Closed",
  merged: "Merged",
};

export const PRIORITY_LABELS: Record<string, string> = {
  normal: "Normal",
  elevated: "Elevated",
  high: "High",
  critical: "Critical",
};

export const MATCH_STATUS_LABELS: Record<string, string> = {
  pending: "Matching pending",
  auto_matched: "Auto-grouped",
  pending_review: "Awaiting match review",
  new_issue: "New issue",
  manual: "Grouped by staff",
  failed: "Needs manual grouping",
};

const dayFmt = new Intl.DateTimeFormat(APP_CONFIG.locale, { timeZone: APP_CONFIG.timeZone, day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(APP_CONFIG.locale, { timeZone: APP_CONFIG.timeZone, hour: "numeric", minute: "2-digit" });

/** Chat day separator: "Today", "Yesterday" or "2 Nov 2026" (Lagos time). */
export function formatDay(d: Date | string): string {
  const label = dayFmt.format(new Date(d));
  const today = dayFmt.format(new Date());
  if (label === today) return "Today";
  if (label === dayFmt.format(new Date(Date.now() - 86_400_000))) return "Yesterday";
  return label;
}

/** Chat message time: "9:05" (Lagos time). */
export function formatTime(d: Date | string): string {
  return timeFmt.format(new Date(d));
}

/** "morning" | "afternoon" | "evening" in Lagos time, for the dashboard greeting. */
export function partOfDay(now = new Date()): "morning" | "afternoon" | "evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: APP_CONFIG.timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}
