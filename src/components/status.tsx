import { Badge, type BadgeTone } from "@/components/ui";
import { COMPLAINT_STATUS_LABELS, ISSUE_STATUS_LABELS, MATCH_STATUS_LABELS, PRIORITY_LABELS } from "@/lib/format";

// Label -> tone maps from the redesign handoff. Every badge shows its word.
export const complaintStatusTone: Record<string, BadgeTone> = {
  received: "neutral",
  under_review: "info",
  in_progress: "warn",
  awaiting_external_action: "violet",
  resolved: "ok",
  review_requested: "warn",
  closed: "neutral",
};

export const issueStatusTone: Record<string, BadgeTone> = {
  new: "neutral",
  under_review: "info",
  in_progress: "warn",
  awaiting_external_action: "violet",
  resolved: "ok",
  closed: "neutral",
  merged: "neutral",
};

export const priorityTone: Record<string, BadgeTone> = { normal: "neutral", elevated: "info", high: "warn", critical: "danger" };

export function ComplaintStatusBadge({ status }: { status: string }) {
  return <Badge tone={complaintStatusTone[status] ?? "neutral"}>{COMPLAINT_STATUS_LABELS[status] ?? status}</Badge>;
}

export function IssueStatusBadge({ status }: { status: string }) {
  return <Badge tone={issueStatusTone[status] ?? "neutral"}>{ISSUE_STATUS_LABELS[status] ?? status}</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={priorityTone[priority] ?? "neutral"}>{PRIORITY_LABELS[priority] ?? priority}</Badge>;
}

export function MatchStatusBadge({ status }: { status: string }) {
  const tone: BadgeTone = status === "failed" ? "danger" : status === "pending_review" || status === "pending" ? "warn" : status === "new_issue" ? "brand" : status === "auto_matched" ? "info" : "neutral";
  return <Badge tone={tone}>{MATCH_STATUS_LABELS[status] ?? status}</Badge>;
}

/** Flags (Sensitive, Overdue, New update…) use the diamond marker. */
export function FlagBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <Badge tone={tone} flag>
      {children}
    </Badge>
  );
}
