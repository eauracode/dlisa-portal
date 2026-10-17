import type { Metadata } from "next";
import Link from "next/link";
import { pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { can } from "@/lib/auth/permissions";
import { countActiveStudents, issueAudienceOptions, listSentMessages } from "@/lib/services/messages";
import { getStaffConversation, listConversations } from "@/lib/services/conversations";
import { listMemosForStaff, liveIssueUpdateCount } from "@/lib/services/memos";
import { NotFoundError } from "@/lib/services/admin/context";
import { formatDateTime, formatTime, relativeTime } from "@/lib/format";
import { uuidSchema } from "@/lib/validation";
import { DEPARTMENTS } from "@/lib/departments";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Label, PageHeader, Textarea } from "@/components/ui";
import { ComplaintStatusBadge } from "@/components/status";
import { Flash } from "@/components/flash";
import { BotAvatar } from "@/components/student/ChatBits";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils";
import { ComposeMessageForm } from "./compose-form";
import { createMemoAction, memoAction, setMessageReuseAction, staffReplyAction } from "../../actions";

export const metadata: Metadata = { title: "Messages & memos" };

type Tab = "conversations" | "memos" | "bulk";

const AUDIENCE: Record<string, { label: string; tone: "info" | "purple" | "warning" | "neutral" }> = {
  issue: { label: "Issue reporters", tone: "info" },
  direct: { label: "Direct", tone: "purple" },
  broadcast: { label: "Memo to all", tone: "warning" },
  department: { label: "Department", tone: "neutral" },
  open_complaints: { label: "Open complaints", tone: "neutral" },
};

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; tab?: string; c?: string; issue?: string }> }) {
  const admin = await requireAdmin("messages.view");
  const sp = await searchParams;
  const tab: Tab = sp.tab === "memos" || sp.tab === "bulk" ? sp.tab : sp.issue ? "bulk" : "conversations";
  const tabs: { key: Tab; label: string }[] = [
    { key: "conversations", label: "Conversations" },
    { key: "memos", label: "Memos" },
    { key: "bulk", label: "Bulk messages" },
  ];

  return (
    <>
      <Flash ok={sp.ok} err={sp.err} />
      <PageHeader title="Messages & memos" description="Reply to students in their complaint's chat, publish memos to everyone, or message a group of students." />
      <nav aria-label="Messages sections" className="mb-5 flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/admin/messages?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className="-mb-px flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted no-underline hover:text-foreground aria-[current=page]:border-brand-600 aria-[current=page]:text-foreground"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "conversations" && <Conversations admin={admin} selected={uuidSchema.safeParse(sp.c).success ? sp.c! : null} />}
      {tab === "memos" && <Memos admin={admin} />}
      {tab === "bulk" && <Bulk admin={admin} defaultIssueId={uuidSchema.safeParse(sp.issue).success ? sp.issue : undefined} />}
    </>
  );
}

type Admin = Awaited<ReturnType<typeof requireAdmin>>;

async function Conversations({ admin, selected }: { admin: Admin; selected: string | null }) {
  const list = await listConversations(pool(), admin);
  let thread: Awaited<ReturnType<typeof getStaffConversation>> | null = null;
  if (selected) {
    try {
      thread = await getStaffConversation(admin, selected);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  if (list.length === 0 && !thread) {
    return <EmptyState title="No conversations yet.">When a student writes in their complaint&apos;s chat, the conversation appears here.</EmptyState>;
  }
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
      <ul className={cn("overflow-hidden rounded-[var(--radius-m)] border border-border bg-surface", thread && "hidden lg:block")}>
        {list.map((c) => (
          <li key={c.complaint_id} className="border-b border-border last:border-0">
            <Link
              href={`/admin/messages?tab=conversations&c=${c.complaint_id}`}
              aria-current={selected === c.complaint_id ? "page" : undefined}
              className="block px-3.5 py-3 text-foreground no-underline hover:bg-brand-50 aria-[current=page]:bg-brand-50"
            >
              <span className="flex items-baseline justify-between gap-2">
                <b className={cn("text-sm", c.unread ? "font-bold" : "font-semibold")}>{c.reporter}</b>
                <span className="shrink-0 text-xs text-muted">{relativeTime(c.last_at)}</span>
              </span>
              {c.department && <span className="mt-0.5 inline-block rounded bg-sunken px-1.5 text-[11px] text-muted">{c.department}</span>}
              {c.needs_personal_reply && (
                <span className="mt-1 block">
                  <Badge tone="warning">Answer not helpful: reply individually</Badge>
                </span>
              )}
              <span className="mt-0.5 block truncate text-xs text-muted">{c.issue_title ?? c.subject}</span>
              <span className="mt-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm text-muted">
                  {c.last_from === "staff" ? "You: " : ""}
                  {c.last_body}
                </span>
                {c.unread > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold text-on-brand">
                    {c.unread}
                    <span className="sr-only"> unread</span>
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {thread ? (
        <section aria-label={`Conversation with ${thread.reporter}`} className="flex min-h-[480px] flex-col overflow-hidden rounded-[var(--radius-m)] border border-border bg-surface">
          <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
            <Link href="/admin/messages?tab=conversations" className="grid h-10 w-10 place-items-center rounded-lg text-foreground lg:hidden" aria-label="All conversations">
              <Icon name="back" />
            </Link>
            <div className="min-w-0 flex-1">
              <b className="block text-[15px]">
                {thread.reporter}
                {thread.department && <span className="font-normal text-muted"> · {thread.department}</span>}
              </b>
              <small className="text-xs text-muted">
                {thread.issue ? (
                  <>
                    On issue: {thread.issue.title} · <Link href={`/admin/issues/${thread.issue.id}`}>Open issue</Link>
                  </>
                ) : (
                  <>
                    {thread.subject} · <Link href={`/admin/complaints/${thread.complaint_id}`}>Open submission</Link>
                  </>
                )}
              </small>
            </div>
            <ComplaintStatusBadge status={thread.status} />
          </header>
          {thread.needs_personal_reply && (
            <p className="border-b border-border bg-warn-bg px-4 py-2.5 text-sm text-warn-fg">
              <b>This student said an earlier answer was not helpful.</b> Please reply to them individually below.
            </p>
          )}
          <div role="log" aria-label="Messages" className="chat-body flex max-h-[60vh] flex-1 flex-col gap-2 overflow-y-auto bg-sunken px-4 py-4">
            {thread.messages.map((m) =>
              m.sender_type === "student" ? (
                <div key={m.id}>
                  <div className="flex items-end gap-2">
                    <BotAvatar small label="R" tone="reporter" />
                    <div className="bubble-them">
                      {m.is_review_request && <span className="bubble-lab">Review request</span>}
                      {m.body}
                    </div>
                  </div>
                  <span className="msg-meta pl-10">
                    {thread.reporter} · {formatDateTime(m.created_at)}
                  </span>
                </div>
              ) : (
                <div key={m.id}>
                  <div className="flex justify-end">
                    <div className="bubble-me">{m.body}</div>
                  </div>
                  <span className="msg-meta text-right">
                    {m.author ?? "Staff"} · {formatTime(m.created_at)} · {m.read ? "Read" : "Sent"}
                  </span>
                </div>
              ),
            )}
          </div>
          {thread.status === "closed" ? (
            <p className="border-t border-border px-4 py-3 text-sm text-muted">This complaint is closed.</p>
          ) : (
            <form action={staffReplyAction} className="grid gap-2 border-t border-border p-3">
              <input type="hidden" name="complaintId" value={thread.complaint_id} />
              <label htmlFor="staff-reply" className="sr-only">
                Reply to {thread.reporter}
              </label>
              <Textarea id="staff-reply" name="body" required maxLength={2000} rows={3} placeholder={`Reply to ${thread.reporter}…`} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">Only this student sees this reply, in their complaint&apos;s chat. To tell everyone on the issue, publish an update instead.</p>
                <Button>Send reply</Button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <p className="hidden rounded-[var(--radius-m)] border border-dashed border-border p-8 text-center text-sm text-muted lg:block">Choose a conversation to read and reply.</p>
      )}
    </div>
  );
}

async function Memos({ admin }: { admin: Admin }) {
  if (!can(admin.role, "memos.draft")) return <EmptyState title="You do not have access to memos." />;
  const [memos, live] = await Promise.all([listMemosForStaff(pool(), admin), liveIssueUpdateCount()]);
  const canPublish = can(admin.role, "memos.publish");
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>New memo</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createMemoAction} className="grid gap-3.5">
            <div>
              <Label htmlFor="memo-title">Title</Label>
              <Input id="memo-title" name="title" required minLength={3} maxLength={140} />
            </div>
            <div>
              <Label htmlFor="memo-body">Memo</Label>
              <Textarea id="memo-body" name="body" required minLength={5} maxLength={4000} rows={7} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="pinned" className="h-4 w-4 accent-brand-600" /> Pin to the top of Memos
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="public" className="h-4 w-4 accent-brand-600" /> Also visible to signed-out visitors
            </label>
            <p className="text-xs text-muted">Published memos appear in every student&apos;s Memos tab with a &ldquo;New&rdquo; tag until they open it.</p>
            <div className="flex flex-wrap gap-2">
              {canPublish && (
                <Button name="intent" value="publish">
                  Publish memo
                </Button>
              )}
              <Button name="intent" value="draft" variant="secondary">
                Save draft
              </Button>
            </div>
            {!canPublish && <p className="text-xs text-muted">As a Case Officer you can save drafts. An Association Administrator publishes them.</p>}
          </form>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="font-semibold">Memos</h2>
        {memos.length === 0 && <EmptyState title="No memos yet." />}
        <ul className="grid gap-3">
          {memos.map((m) => (
            <li key={m.id}>
              <Card>
                <CardContent className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={m.memo_status === "published" ? "success" : m.memo_status === "draft" ? "warning" : "neutral"}>
                      {m.memo_status === "published" ? "Published" : m.memo_status === "draft" ? "Draft" : "Archived"}
                    </Badge>
                    {m.pinned && <Badge tone="brand">Pinned</Badge>}
                    {m.public && <Badge tone="neutral">Public</Badge>}
                  </div>
                  <p className="font-medium">{m.subject}</p>
                  <p className="text-xs text-muted">
                    {m.author} · {formatDateTime(m.created_at)}
                    {m.memo_status === "published" && <> · Seen by {m.seen} student{m.seen === 1 ? "" : "s"}</>}
                  </p>
                  <p className="line-clamp-3 whitespace-pre-line text-sm">{m.body}</p>
                  {m.memo_status !== "archived" && (canPublish || m.memo_status === "draft") && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {canPublish && m.memo_status === "draft" && <MemoOp id={m.id} op="publish" label="Publish" primary />}
                      {canPublish && m.memo_status === "published" && <MemoOp id={m.id} op={m.pinned ? "unpin" : "pin"} label={m.pinned ? "Unpin" : "Pin"} />}
                      {canPublish && <MemoOp id={m.id} op="archive" label="Archive" />}
                      <details className="w-full">
                        <summary className="cursor-pointer text-sm text-link">Edit</summary>
                        <form action={memoAction} className="mt-2 grid gap-2">
                          <input type="hidden" name="memoId" value={m.id} />
                          <input type="hidden" name="op" value="edit" />
                          <Input name="title" defaultValue={m.subject} required minLength={3} maxLength={140} aria-label="Title" />
                          <Textarea name="body" defaultValue={m.body} required minLength={5} maxLength={4000} rows={5} aria-label="Memo" />
                          <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="public" defaultChecked={m.public} className="h-4 w-4 accent-brand-600" /> Visible to signed-out visitors
                          </label>
                          <Button size="sm" className="w-fit">
                            Save changes
                          </Button>
                        </form>
                      </details>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
          <li className="rounded-[var(--radius-m)] border border-dashed border-border p-3.5 text-sm text-muted">
            <b className="text-foreground">Issue updates:</b> posted automatically from unresolved public issues ({live} live). Removed when resolved.
          </li>
        </ul>
      </section>
    </div>
  );
}

function MemoOp({ id, op, label, primary = false }: { id: string; op: string; label: string; primary?: boolean }) {
  return (
    <form action={memoAction}>
      <input type="hidden" name="memoId" value={id} />
      <input type="hidden" name="op" value={op} />
      <Button size="sm" variant={primary ? "primary" : "secondary"}>
        {label}
      </Button>
    </form>
  );
}

async function Bulk({ admin, defaultIssueId }: { admin: Admin; defaultIssueId?: string }) {
  const [issues, sent, activeStudents] = await Promise.all([issueAudienceOptions(pool(), admin), listSentMessages(pool(), admin), countActiveStudents(pool())]);
  const allowed = {
    issue: can(admin.role, "messages.send_issue"),
    username: can(admin.role, "messages.send_direct"),
    department: can(admin.role, "messages.broadcast"),
    open_complaints: can(admin.role, "messages.broadcast"),
  };
  const bulk = sent.filter((m) => m.audience !== "broadcast");
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>New message</CardTitle>
        </CardHeader>
        <CardContent>
          <ComposeMessageForm issues={issues} allowed={allowed} activeStudents={activeStudents} departments={DEPARTMENTS.map((d) => ({ code: d.code, name: d.name }))} defaultIssueId={defaultIssueId} />
          <p className="mt-4 text-xs text-muted">
            Messages to an issue&apos;s reporters land in each student&apos;s complaint chat; other messages land in their Messages. Use{" "}
            <Link href="/admin/messages?tab=memos">Memos</Link> for notices meant for all students.
          </p>
          {admin.role === "case_officer" && (
            <p className="mt-2 text-xs text-muted">As a Case Officer you can message reporters of issues assigned to you. Other audiences are sent by an Association Administrator.</p>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-3 font-semibold">{admin.role === "union_admin" ? "Sent messages" : "Messages you sent"}</h2>
        {bulk.length === 0 ? (
          <EmptyState title="No messages sent yet." />
        ) : (
          <ul className="space-y-3">
            {bulk.map((m) => (
              <li key={m.id}>
                <Card>
                  <CardContent className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{m.subject}</p>
                      <Badge tone={AUDIENCE[m.audience]?.tone}>{AUDIENCE[m.audience]?.label ?? m.audience}</Badge>
                    </div>
                    <p className="text-xs text-muted">
                      To{" "}
                      {m.target_issue_id ? (
                        <Link href={`/admin/issues/${m.target_issue_id}`} className="text-link hover:underline">
                          {m.target_label}
                        </Link>
                      ) : (
                        m.target_label
                      )}{" "}
                      · {m.author} · {formatDateTime(m.created_at)}
                    </p>
                    <p className="line-clamp-3 whitespace-pre-line text-sm">{m.body}</p>
                    <p className="text-xs text-muted tabular-nums">
                      Delivered to {m.recipient_count} student{m.recipient_count === 1 ? "" : "s"} · read by {m.read_count}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs">
                      <span className="text-muted tabular-nums">
                        {m.reusable ? "Instant answer: on" : "Instant answer: off"}
                        {m.reused_count > 0 && (
                          <>
                            {" "}
                            · given to {m.reused_count} later submission{m.reused_count === 1 ? "" : "s"} · {m.helpful_count} found it helpful
                          </>
                        )}
                      </span>
                      {(admin.role === "union_admin" || m.author_admin_id === admin.id) && (
                        <form action={setMessageReuseAction}>
                          <input type="hidden" name="messageId" value={m.id} />
                          {!m.reusable && <input type="hidden" name="reusable" value="on" />}
                          <Button size="sm" variant="ghost">
                            {m.reusable ? "Stop reusing" : "Reuse as instant answer"}
                          </Button>
                        </form>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
