import { requestReviewFormAction } from "@/app/student/actions";

const STEPS = ["Received", "Under review", "In progress", "Resolved"] as const;
const STEP_FOR_STATUS: Record<string, number> = {
  received: 1,
  under_review: 2,
  in_progress: 3,
  awaiting_external_action: 3,
  review_requested: 4,
  resolved: 5,
  closed: 5,
};

const REVIEW_ERRORS: Record<string, string> = {
  short: "Please explain briefly why the concern remains unresolved (at least 10 characters).",
  rate_limited: "You have made several review requests today. Please try again tomorrow.",
  not_resolved: "You can request a review only after a complaint has been marked as resolved.",
  not_found: "This complaint could not be found.",
};

/** Progress steps, key facts and "Still unresolved?". Right-hand panel on desktop; collapsible on phones. */
export function ProgressPanel(props: {
  complaintId: string;
  status: string;
  statusBadge: React.ReactNode;
  expected: string | null;
  noDateText: string;
  relatedIssueStatus: string | null;
  submitted: string;
  showReviewRequest: boolean;
  reviewText: string;
  reviewError?: string;
  bare?: boolean;
}) {
  const step = STEP_FOR_STATUS[props.status] ?? 1;
  return (
    <div className={props.bare ? "" : "rounded-xl border border-[var(--border)] bg-[var(--surface)]"}>
      {!props.bare && <h2 className="border-b border-[var(--border)] px-4 py-3.5 text-base font-semibold">Progress</h2>}
      <ol aria-label="Progress" className="grid gap-3.5 p-4">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const now = n === step;
          return (
            <li
              key={label}
              aria-current={now ? "step" : undefined}
              className={`relative min-h-[22px] pl-8 text-[13px] ${done || now ? "text-[var(--foreground)]" : "text-[var(--muted)]"} ${now ? "font-semibold" : ""}`}
            >
              {n < STEPS.length && (
                <span aria-hidden="true" className={`absolute left-[9px] top-[22px] h-[calc(100%-8px)] w-0.5 ${done ? "bg-[var(--brand-600)]" : "bg-[var(--border)]"}`} />
              )}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-0 grid h-5 w-5 place-items-center rounded-full border-2 text-[11px] font-bold ${
                  done
                    ? "border-[var(--brand-600)] bg-[var(--brand-600)] text-white"
                    : now
                      ? "border-[var(--brand-600)] bg-[var(--surface)] text-[var(--link)] shadow-[0_0_0_4px_var(--brand-100)]"
                      : "border-[var(--border-strong)] bg-[var(--surface)]"
                }`}
              >
                {done ? "✓" : n}
              </span>
              <b className="font-semibold">{label}</b>
              <span className="sr-only">{done ? " (done)" : now ? " (current)" : ""}</span>
            </li>
          );
        })}
      </ol>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 border-t border-[var(--border)] p-4 text-sm">
        <dt className="text-[var(--muted)]">Status</dt>
        <dd className="m-0">{props.statusBadge}</dd>
        <dt className="text-[var(--muted)]">Expected</dt>
        <dd className={props.expected ? "m-0 font-semibold" : "m-0"}>{props.expected ?? props.noDateText}</dd>
        <dt className="text-[var(--muted)]">Related issue</dt>
        <dd className="m-0 font-medium">{props.relatedIssueStatus ?? "Not yet linked"}</dd>
        <dt className="text-[var(--muted)]">Submitted</dt>
        <dd className="m-0 font-medium">{props.submitted}</dd>
      </dl>
      {props.showReviewRequest && (
        <form id="review" action={requestReviewFormAction} className="grid gap-2 border-t border-[var(--border)] p-4">
          <input type="hidden" name="complaintId" value={props.complaintId} />
          <h3 className="text-base font-semibold">Still unresolved?</h3>
          <p className="text-sm text-[var(--muted)]">{props.reviewText}</p>
          <label htmlFor="rv" className="text-sm font-semibold">
            What&apos;s still wrong?
          </label>
          <textarea
            id="rv"
            name="reason"
            required
            minLength={10}
            maxLength={1000}
            aria-invalid={props.reviewError ? true : undefined}
            className="min-h-24 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-base"
          />
          {props.reviewError && (
            <p role="alert" className="text-[13px] font-medium text-[var(--danger-fg)]">
              {REVIEW_ERRORS[props.reviewError] ?? "Your review request could not be sent."}
            </p>
          )}
          <button className="min-h-11 cursor-pointer rounded-lg border border-[var(--brand-600)] bg-transparent font-semibold text-[var(--link)] hover:bg-[var(--brand-50)]">
            Request a review
          </button>
        </form>
      )}
    </div>
  );
}
