import type { Metadata } from "next";
import Link from "next/link";
import { requireStudent } from "@/lib/auth/current";
import { getStudentMessagesOverview } from "@/lib/services/messages";
import { formatDateTime, relativeTime } from "@/lib/format";
import { Badge, EmptyState, type BadgeTone } from "@/components/ui";
import { FlagBadge } from "@/components/status";
import { BotAvatar } from "@/components/student/ChatBits";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Notifications" };

const GENERAL_KIND: Record<string, { label: string; tone: BadgeTone }> = {
  direct: { label: "To you", tone: "violet" },
  department: { label: "Your department", tone: "info" },
  open_complaints: { label: "Students with an open complaint", tone: "neutral" },
};

export default async function StudentMessagesPage() {
  const student = await requireStudent({ path: "/student/messages" });
  const { complaints, general } = await getStudentMessagesOverview(student.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="mt-1 text-[var(--muted)]">
          Your conversations with the Students&apos; Association. General notices are in <Link href="/memos">Memos</Link>.
        </p>
      </div>

      {complaints.length === 0 && general.length === 0 ? (
        <EmptyState title="No messages yet.">When the Students&apos; Association replies to one of your complaints or suggestions, the conversation will appear here.</EmptyState>
      ) : (
        <>
          {complaints.length > 0 && (
            <ul className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {complaints.map((c) => (
                <li key={c.complaint_id} className="border-b border-[var(--border)] last:border-0">
                  <Link href={`/student/complaints/${c.complaint_id}`} className="flex items-center gap-3 px-3 py-3.5 text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)] sm:px-4">
                    <BotAvatar />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <b className={cn("truncate text-[15px]", c.unread ? "font-bold" : "font-semibold")}>{c.subject}</b>
                        <span className="shrink-0 text-xs text-[var(--muted)]">{relativeTime(c.last_at)}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-[var(--muted)]">{c.last_body}</span>
                        {c.unread > 0 && (
                          <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--brand-600)] px-1 text-[11px] font-semibold text-white">
                            {c.unread}
                            <span className="sr-only"> unread</span>
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {general.length > 0 && (
            <section aria-labelledby="other-messages" className="space-y-2.5">
              <h2 id="other-messages" className="text-base font-semibold">
                Other messages
              </h2>
              <ul className="grid gap-2.5">
                {general.map((m) => {
                  const kind = GENERAL_KIND[m.audience] ?? { label: "Message", tone: "neutral" as const };
                  return (
                    <li key={m.id}>
                      <article className={cn("rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5", !m.read_at && "border-l-4 border-l-[var(--brand-600)] pl-[13px]")}>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge tone={kind.tone}>{kind.label}</Badge>
                          {!m.read_at && <FlagBadge tone="brand">New</FlagBadge>}
                        </div>
                        <h3 className="mb-1 mt-1.5 break-words text-base font-semibold">{m.subject}</h3>
                        <p className="text-xs text-[var(--muted)]">DLI Students&apos; Association · {formatDateTime(m.created_at)}</p>
                        <p className="mt-2 whitespace-pre-line break-words text-sm">{m.body}</p>
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
