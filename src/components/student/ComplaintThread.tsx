import Link from "next/link";
import { Fragment } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui";
import { formatDay, formatTime } from "@/lib/format";
import type { ThreadEvent } from "@/lib/services/student-thread";
import { answerFeedbackAction, sendReplyAction } from "@/app/student/actions";
import { BotAvatar } from "./ChatBits";
import { ScrollToEnd } from "./ScrollToEnd";

const ANSWER_SOURCE: Record<string, string> = {
  broadcast: "From a memo to all students",
  issue: "Sent to students who reported the same thing",
  direct: "Given to a student who asked the same thing",
};

const REPLY_ERRORS: Record<string, string> = {
  rate_limited: "You have sent several messages in the last hour. Please wait a little before sending another.",
  closed: "This complaint is closed, so new messages can't be added.",
  empty: "Write a message first (up to 2,000 characters).",
  not_found: "This complaint could not be found.",
};

/**
 * The conversation with the Student Union. Server component; the reply box is a plain form
 * posting to a server action, so it works without JavaScript.
 */
export function ComplaintThread(props: {
  complaintId: string;
  title: string;
  category: string;
  statusBadge: React.ReactNode;
  statusMessage: string;
  autoUpdating: boolean;
  events: ThreadEvent[];
  canReply: boolean;
  replyError?: string;
  progress?: React.ReactNode;
}) {
  return (
    <section
      aria-label="Conversation"
      className="flex h-[min(820px,calc(100dvh-150px))] min-h-[480px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
    >
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-3 sm:px-4">
        <Link href="/student/complaints" aria-label="Back to my complaints and suggestions" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[var(--foreground)]">
          <Icon name="back" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold leading-snug sm:text-[15px]">{props.title}</h1>
          <small className="text-xs text-[var(--muted)]">{props.category} · with DLI Student Union</small>
        </div>
        <span className="hidden sm:block">{props.statusBadge}</span>
      </header>
      <div aria-live="polite" className="bg-[var(--brand-600)] px-4 py-3 text-sm leading-relaxed text-white">
        {props.statusMessage}
        {props.autoUpdating && (
          <span className="mt-2 flex w-fit items-center gap-2 rounded-full bg-white/15 px-2.5 py-0.5 text-xs">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden="true" />
            This page updates automatically
          </span>
        )}
      </div>
      {props.progress}

      <div id="thread-log" role="log" aria-label="Conversation with the Student Union" className="chat-body flex flex-1 flex-col gap-2 overflow-y-auto bg-[var(--sunken)] px-3 py-[18px] sm:px-4">
        {props.events.map((e, i) => {
          const day = formatDay(e.at);
          const sep = i === 0 || formatDay(props.events[i - 1].at) !== day ? <span className="daysep">{day}</span> : null;
          return (
            <Fragment key={i}>
              {sep}
              <Event e={e} complaintId={props.complaintId} />
            </Fragment>
          );
        })}
        <span id="latest" />
      </div>
      <ScrollToEnd targetId="thread-log" />

      {props.canReply ? (
        <form id="reply" action={sendReplyAction} className="border-t border-[var(--border)] bg-[var(--surface)] px-3 pb-[calc(10px+env(safe-area-inset-bottom,0px))] pt-2.5">
          <input type="hidden" name="complaintId" value={props.complaintId} />
          {props.replyError && (
            <p role="alert" className="mx-1.5 mb-2 text-[13px] font-medium text-[var(--danger-fg)]">
              {REPLY_ERRORS[props.replyError] ?? "Your message could not be sent. Please try again."}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label htmlFor="reply-body" className="sr-only">
              Message the Student Union
            </label>
            <textarea
              id="reply-body"
              name="body"
              required
              maxLength={2000}
              rows={1}
              placeholder="Message the Student Union…"
              className="max-h-40 min-h-11 flex-1 resize-none rounded-[22px] border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2.5 text-base [field-sizing:content]"
            />
            <button type="submit" aria-label="Send" className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-[var(--brand-600)] text-white">
              <Icon name="send" />
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-[var(--muted)]">Only you and the Student Union team can read this conversation.</p>
        </form>
      ) : (
        <p className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-sm text-[var(--muted)]">This complaint is closed, so new messages can&apos;t be added.</p>
      )}
    </section>
  );
}

function Them({ children, label, tone, meta, avatar }: { children: React.ReactNode; label?: string; tone?: string; meta: string; avatar?: React.ReactNode }) {
  return (
    <>
      <div className="flex items-end gap-2">
        {avatar ?? <BotAvatar small />}
        <div className={`bubble-them ${tone ?? ""}`}>
          {label && <span className="bubble-lab">{label}</span>}
          {children}
        </div>
      </div>
      <span className="msg-meta pl-10">{meta}</span>
    </>
  );
}

function Me({ children, meta }: { children: React.ReactNode; meta: string }) {
  return (
    <>
      <div className="flex justify-end">
        <div className="bubble-me">{children}</div>
      </div>
      <span className="msg-meta text-right">{meta}</span>
    </>
  );
}

function Event({ e, complaintId }: { e: ThreadEvent; complaintId: string }) {
  const t = formatTime(e.at);
  switch (e.type) {
    case "original":
      return <Me meta={`You · ${t} · What you sent`}>{e.body}</Me>;
    case "grouped":
      return (
        <span className="sysp">
          <Icon name="users" size={16} />
          Added to an issue other students reported
        </span>
      );
    case "status":
      return (
        <span className="sysp">
          Status changed to <b>{e.label}</b>
        </span>
      );
    case "date_set":
      return (
        <span className="sysp">
          <Icon name="cal" size={16} />
          {e.label === "withdrawn" ? (
            "Expected resolution date withdrawn"
          ) : (
            <>
              Expected resolution set: <b>{e.label}</b>
            </>
          )}
        </span>
      );
    case "review_requested":
      return e.body ? (
        <Me meta={`You · ${t} · Review requested`}>{e.body}</Me>
      ) : (
        <span className="sysp">You requested a review</span>
      );
    case "review_response":
      return (
        <Them label="Response to your review request" meta={`DLI Student Union · ${t}`}>
          {e.body}
        </Them>
      );
    case "update":
      return (
        <Them label="Update" tone="update" meta={`DLI Student Union · ${t}`}>
          {e.body}
        </Them>
      );
    case "official":
      return (
        <Them label="Official response · School management" tone="official" meta={`Recorded by the Student Union · ${t}`} avatar={<BotAvatar small label="MGT" tone="mgt" />}>
          {e.body}
        </Them>
      );
    case "message":
      return e.from === "student" ? (
        <Me meta={`You · ${t} · ${e.readByOther ? "Read" : "Sent"}`}>{e.body}</Me>
      ) : (
        <Them label={e.note} meta={`DLI Student Union · ${t}`}>
          {e.body}
        </Them>
      );
    case "answer":
      return (
        <Them label="Answered before" tone="answer" meta={`DLI Student Union · ${t} · ${ANSWER_SOURCE[e.audience] ?? "Earlier answer"}`}>
          <b className="block">{e.subject}</b>
          {e.body}
          <span className="mt-3 block border-t border-[var(--border)] pt-2.5 [white-space:normal]">
            {e.helpful === null ? (
              <form action={answerFeedbackAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="complaintId" value={complaintId} />
                <input type="hidden" name="messageId" value={e.messageId} />
                <span className="w-full text-sm font-medium">Did this answer your question?</span>
                <Button size="sm" name="helpful" value="yes">
                  Yes, thanks
                </Button>
                <Button size="sm" variant="secondary" name="helpful" value="no">
                  No, I still need help
                </Button>
                <span className="w-full text-xs text-[var(--muted)]">Choosing Yes marks this as resolved.</span>
              </form>
            ) : (
              <span role="status" className="text-sm text-[var(--muted)]">
                {e.helpful
                  ? "Glad it helped. This is now marked as resolved. If the problem comes back, you can ask for a review."
                  : "Thanks for telling us. The Student Union team will still look at it."}
              </span>
            )}
          </span>
        </Them>
      );
  }
}
