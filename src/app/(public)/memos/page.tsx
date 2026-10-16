import type { Metadata } from "next";
import Link from "next/link";
import { COPY } from "@/config/app";
import { getCurrentStudent } from "@/lib/auth/current";
import { getMemoFeed, parseMemoFilter, type MemoFilter } from "@/lib/services/memos";
import { formatDateTime } from "@/lib/format";
import { IssueStatusBadge, FlagBadge } from "@/components/status";
import { Badge, EmptyState } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Memos" };
export const dynamic = "force-dynamic";

const FILTERS: { key: MemoFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "notice", label: "Notices" },
  { key: "issue", label: "Issue updates" },
];

export default async function MemosPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const filter = parseMemoFilter((await searchParams).type);
  const student = await getCurrentStudent();
  const feed = await getMemoFeed(student?.id ?? null, filter);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Memos</h1>
        <p className="mt-1 max-w-[62ch] text-[var(--muted)]">Official notices from the DLI Student Union, plus progress on problems many students have reported.</p>
      </div>
      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/memos" : `/memos?type=${f.key}`}
            aria-current={filter === f.key ? "page" : undefined}
            className="flex min-h-10 items-center rounded-full border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--foreground)] no-underline hover:bg-[var(--brand-50)] aria-[current=page]:border-[var(--brand-600)] aria-[current=page]:bg-[var(--brand-600)] aria-[current=page]:text-white"
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {feed.length === 0 ? (
        <EmptyState title="Nothing here yet.">Notices from the Student Union and updates on commonly reported problems will appear here.</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {feed.map((c) =>
            c.kind === "notice" ? (
              <li key={`n-${c.id}`}>
                <article className={cn("rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4", c.isNew && "border-l-4 border-l-[var(--brand-600)] pl-[13px]")}>
                  <div className="flex flex-wrap gap-1.5">
                    {c.pinned && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-100)] py-0.5 pl-1.5 pr-2.5 text-xs font-semibold text-[var(--link)]">
                        <Icon name="pin" size={13} />
                        Pinned
                      </span>
                    )}
                    <Badge tone="neutral">Memo</Badge>
                    {c.isNew && <FlagBadge tone="brand">New</FlagBadge>}
                  </div>
                  <h2 className="mb-1 mt-2 break-words text-base font-semibold">{c.title}</h2>
                  <p className="text-xs text-[var(--muted)]">DLI Student Union · {formatDateTime(c.publishedAt)}</p>
                  <p className="mt-2 whitespace-pre-line break-words text-sm">{c.body}</p>
                </article>
              </li>
            ) : (
              <li key={`i-${c.id}`}>
                <article className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="violet">Issue update</Badge>
                    <IssueStatusBadge status={c.status} />
                  </div>
                  <h2 className="mb-1 mt-2 break-words text-base font-semibold">{c.title}</h2>
                  <p className="text-xs text-[var(--muted)]">
                    {c.category} · Last updated {formatDateTime(c.updatedAt)}
                  </p>
                  <p className="mt-2 text-sm">{c.summary}</p>
                  <div className="mt-2.5 rounded-lg bg-[var(--brand-50)] px-3 py-2.5 text-sm">
                    <b>Latest:</b> {c.latest ?? "No public update yet."} {c.expectedAt ? `Expected resolution ${formatDateTime(c.expectedAt)}.` : COPY.noDeadline}
                  </div>
                </article>
              </li>
            ),
          )}
        </ul>
      )}
      {!student && (
        <p className="text-sm text-[var(--muted)]">
          Some notices are for students only. <Link href="/student/access">Sign in</Link> to see them all.
        </p>
      )}
    </div>
  );
}
