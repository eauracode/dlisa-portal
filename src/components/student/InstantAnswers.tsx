import { formatDateTime } from "@/lib/format";
import type { StudentInstantAnswer } from "@/lib/services/instant-answers";
import { answerFeedbackAction } from "@/app/student/actions";
import { Button } from "@/components/ui";

const SOURCE: Record<string, string> = {
  broadcast: "Memo to all students",
  issue: "Reply to students who reported the same thing",
  direct: "Reply to a student who asked the same thing",
};

/** Earlier Student Union answers to the same question, shown on the submission receipt. */
export function InstantAnswers({ complaintId, answers }: { complaintId: string; answers: StudentInstantAnswer[] }) {
  if (answers.length === 0) return null;
  return (
    <section aria-labelledby="instant-answers" className="rounded-[var(--radius-m)] border border-ok-fg/30 bg-ok-bg p-4 sm:p-5">
      <h2 id="instant-answers" className="text-base font-semibold text-ok-fg">
        The Student Union has answered this before
      </h2>
      <p className="mt-1 text-sm">Here {answers.length === 1 ? "is the answer" : "are the answers"} already given. You&apos;ll also find {answers.length === 1 ? "it" : "them"} in Messages.</p>
      <ul className="mt-3 space-y-3">
        {answers.map((a) => (
          <li key={a.message_id} className="rounded-[var(--radius-m)] border border-border bg-surface p-3.5 shadow-card">
            <p className="font-semibold">{a.subject}</p>
            <p className="mt-1 whitespace-pre-line text-sm">{a.body}</p>
            <p className="mt-2 text-xs text-muted">
              {SOURCE[a.audience] ?? "DLI Student Union"} &nbsp;•&nbsp; {formatDateTime(a.sent_at)}
            </p>
            <div className="mt-3 border-t border-border pt-3">
              {a.helpful === null ? (
                <form action={answerFeedbackAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="complaintId" value={complaintId} />
                  <input type="hidden" name="messageId" value={a.message_id} />
                  <span className="mr-1 text-sm font-medium">Did this answer your question?</span>
                  <Button size="sm" name="helpful" value="yes">
                    Yes, thanks
                  </Button>
                  <Button size="sm" variant="secondary" name="helpful" value="no">
                    No, I still need help
                  </Button>
                  <span className="w-full text-xs text-muted">Choosing Yes marks this submission as resolved.</span>
                </form>
              ) : (
                <p className="text-sm text-muted" role="status">
                  {a.helpful
                    ? "Glad it helped. This submission is now marked as resolved. If the problem comes back, you can ask for a review below."
                    : "Thanks for telling us. The Student Union team will still look at your submission."}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
