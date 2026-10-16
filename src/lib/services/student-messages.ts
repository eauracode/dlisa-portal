import { COPY } from "@/config/app";
import { formatDateTime } from "../format";

export interface StudentStatusInput {
  matchStatus: string;
  complaintStatus: string;
  issue: { status: string; expected_resolution_at: Date | null } | null;
}

export interface StudentStatusMessage {
  tone: "info" | "success" | "warning" | "neutral";
  text: string;
}

const ADDRESSING = new Set(["in_progress", "awaiting_external_action"]);
const AWAITING_ASSESSMENT = new Set(["new", "under_review"]);

/**
 * The acknowledgement a student sees about their complaint. Built only from verified
 * database values — the issue's current administrative status and its confirmed expected
 * resolution date. It never invents a deadline, never claims action was taken, and never
 * says something is resolved unless staff marked it so.
 */
export function studentStatusMessage({ matchStatus, complaintStatus, issue }: StudentStatusInput): StudentStatusMessage | null {
  if (complaintStatus === "review_requested") {
    return { tone: "warning", text: "You have requested a review of this complaint. The Student Union team will look at it again and respond here." };
  }
  if (complaintStatus === "resolved" || complaintStatus === "closed") return { tone: "success", text: COPY.resolved };
  if (matchStatus === "pending") {
    return { tone: "info", text: "Your submission has been received. We are checking whether other students have reported the same issue — this page updates automatically." };
  }
  if (matchStatus === "pending_review") return { tone: "info", text: COPY.awaitingReview };
  if (matchStatus === "failed" || !issue) {
    return { tone: "info", text: "Your submission has been received and will be reviewed by the Student Union team." };
  }

  if (issue.status === "resolved" || issue.status === "closed") return { tone: "success", text: COPY.resolved };

  const matchedExisting = matchStatus === "auto_matched" || matchStatus === "manual";
  if (!matchedExisting) {
    // This complaint started its own issue.
    if (ADDRESSING.has(issue.status)) {
      return {
        tone: "info",
        text: issue.expected_resolution_at
          ? `Your concern is being addressed. The current expected resolution date is ${formatDateTime(issue.expected_resolution_at)}.`
          : `Your concern is being addressed. ${COPY.noDeadline}`,
      };
    }
    return null;
  }

  if (ADDRESSING.has(issue.status)) {
    return {
      tone: "info",
      text: issue.expected_resolution_at
        ? `Your concern matches an existing issue that is currently being addressed. Your submission has been added to that issue. The current expected resolution date is ${formatDateTime(issue.expected_resolution_at)}. You can follow updates from your complaints dashboard.`
        : `Your concern matches an existing issue that is currently being addressed. Your submission has been added to that issue. ${COPY.noDeadline}`,
    };
  }
  if (AWAITING_ASSESSMENT.has(issue.status)) {
    return {
      tone: "info",
      text: "Your concern matches an issue other students have already reported. Your submission has been added to it, and the issue is awaiting assessment by the Student Union team. You can follow updates from this page.",
    };
  }
  return { tone: "info", text: COPY.matchedExisting };
}
