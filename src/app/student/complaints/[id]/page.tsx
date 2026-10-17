import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COPY } from "@/config/app";
import { requireStudent } from "@/lib/auth/current";
import { getStudentComplaint } from "@/lib/services/student-complaints";
import { studentStatusMessage } from "@/lib/services/student-messages";
import { loadStudentThread } from "@/lib/services/student-thread";
import { COMPLAINT_STATUS_LABELS, formatDateTime, ISSUE_STATUS_LABELS } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { ComplaintStatusBadge } from "@/components/status";
import { Alert } from "@/components/ui";
import { RefreshWhile } from "@/components/auto-refresh";
import { ComplaintThread } from "@/components/student/ComplaintThread";
import { ProgressPanel } from "@/components/student/ProgressPanel";

export const metadata: Metadata = { title: "Conversation" };

export default async function ComplaintConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ duplicate?: string; replyErr?: string; reviewErr?: string; review?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const student = await requireStudent({ path: `/student/complaints/${id}` });
  if (!uuidSchema.safeParse(id).success) notFound();
  // Row-level security: another student's complaint is indistinguishable from a missing one.
  const detail = await getStudentComplaint(student.id, id);
  if (!detail) notFound();
  const { complaint, issue } = detail;
  const events = await loadStudentThread(student.id, complaint, issue);

  const checking = complaint.match_status === "pending";
  // Fixed wording only: the status-based message, else the acknowledgement.
  const message = studentStatusMessage({ matchStatus: complaint.match_status, complaintStatus: complaint.status, issue })?.text ?? COPY.acknowledgement;
  const badge = <ComplaintStatusBadge status={complaint.status} />;
  const panel = (bare: boolean) => (
    <ProgressPanel
      bare={bare}
      complaintId={complaint.id}
      status={complaint.status}
      statusBadge={badge}
      expected={issue?.expected_resolution_at ? formatDateTime(issue.expected_resolution_at) : null}
      noDateText={COPY.noDeadline}
      relatedIssueStatus={checking ? "Checking…" : issue ? (ISSUE_STATUS_LABELS[issue.status] ?? issue.status) : null}
      submitted={formatDateTime(complaint.created_at)}
      showReviewRequest={complaint.status === "resolved"}
      reviewText={COPY.resolved}
      reviewError={sp.reviewErr}
    />
  );

  return (
    <div className="space-y-3">
      <RefreshWhile active={checking} />
      {sp.duplicate && (
        <Alert tone="warning">
          <b className="mb-0.5 block">You&apos;ve already sent this</b>
          You have already submitted this same complaint recently, so it was not submitted again. Its conversation is shown here.
        </Alert>
      )}
      {sp.review === "sent" && <Alert tone="success">Your review request has been sent to the Students&apos; Association team.</Alert>}

      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[minmax(0,1fr)_330px]">
        <ComplaintThread
          complaintId={complaint.id}
          title={complaint.subject}
          category={complaint.category}
          statusBadge={badge}
          statusMessage={message}
          autoUpdating={checking}
          events={events}
          canReply={complaint.status !== "closed"}
          replyError={sp.replyErr}
          progress={
            <details className="border-b border-[var(--border)] min-[1000px]:hidden" open={!!sp.reviewErr}>
              <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold">
                Progress and details · {COMPLAINT_STATUS_LABELS[complaint.status] ?? "Received"}
              </summary>
              <div className="max-h-[50vh] overflow-y-auto">{panel(true)}</div>
            </details>
          }
        />
        <aside className="hidden min-[1000px]:block">{panel(false)}</aside>
      </div>
    </div>
  );
}
