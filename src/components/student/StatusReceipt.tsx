/**
 * The burgundy status band + 4-step progress track on /student/complaints/[id].
 * `message` must come from the app's existing fixed-wording function (brief §10) — do not reword.
 * `autoUpdating` = true while AI matching is pending (keep the existing auto-refresh logic).
 */
const STEPS = ["Received", "Under review", "In progress", "Resolved"] as const;

// complaint status -> current step (1-based). 5 = all complete.
const STEP_FOR_STATUS: Record<string, number> = {
  "Received": 1,
  "Under review": 2,
  "In progress": 3,
  "Awaiting another office": 3,
  "Review requested": 4,
  "Resolved": 5,
  "Closed": 5,
};

export function StatusReceipt(props: {
  status: string;
  message: string;
  submittedLabel: string; // e.g. "Complaint submitted 14 Oct 2026, 9:12"
  autoUpdating?: boolean;
}) {
  const step = STEP_FOR_STATUS[props.status] ?? 1;

  return (
    <section aria-live="polite" className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="bg-[var(--brand-600)] px-[18px] pb-4 pt-[18px] text-white">
        <p className="text-xs text-white/80">{props.submittedLabel}</p>
        <p className="mt-1.5 max-w-[62ch] text-base leading-relaxed">{props.message}</p>
        {props.autoUpdating && (
          <span className="mt-2.5 inline-flex items-center gap-2 rounded-full bg-white/15 px-2.5 py-1 text-xs">
            <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-white" />
            This page updates automatically
          </span>
        )}
      </div>

      <ol aria-label="Progress" className="grid grid-cols-1 gap-3.5 p-[18px] sm:grid-cols-4 sm:gap-0">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step;
          const now = n === step;
          const last = n === STEPS.length;
          return (
            <li
              key={label}
              aria-current={now ? "step" : undefined}
              className={`relative min-h-[22px] pl-8 text-[13px] sm:pl-0 sm:pr-1.5 sm:pt-[26px] ${
                done || now ? "text-[var(--foreground)]" : "text-[var(--muted)]"
              } ${now ? "font-semibold" : ""}`}
            >
              {/* connector: vertical on phones, horizontal from sm */}
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[9px] top-[22px] h-[calc(100%-8px)] w-0.5 sm:left-5 sm:right-0 sm:top-[9px] sm:h-0.5 sm:w-auto ${
                    done ? "bg-[var(--brand-600)]" : "bg-[var(--border)]"
                  }`}
                />
              )}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-0 z-[1] grid h-5 w-5 place-items-center rounded-full border-2 text-[11px] font-bold ${
                  done
                    ? "border-[var(--brand-600)] bg-[var(--brand-600)] text-white"
                    : now
                      ? "border-[var(--brand-600)] bg-[var(--surface)] text-[var(--link)] shadow-[0_0_0_4px_var(--brand-100)]"
                      : "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--muted)]"
                }`}
              >
                {done ? "✓" : n}
              </span>
              <b className="block font-semibold">{label}</b>
              <span className="sr-only">{done ? " (done)" : now ? " (current)" : ""}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
