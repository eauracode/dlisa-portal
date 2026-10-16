import Link from "next/link";
import { brand } from "@/config/brand";
import { departmentName } from "@/lib/departments";
import { logoutStudentAction } from "@/app/student/actions";
import { Icon, type IconName } from "@/components/ui/Icon";
import { LogoMarks } from "@/components/ui/LogoMarks";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ShellLink } from "./ShellLink";

type NavKey = "dashboard" | "complaints" | "messages" | "memos";

const NAV: { key: NavKey; href: string; label: string; short: string; icon: IconName; match?: string[]; exact?: boolean }[] = [
  { key: "dashboard", href: "/student/dashboard", label: "Home", short: "Home", icon: "home" },
  { key: "complaints", href: "/student/complaints", label: "Complaints & suggestions", short: "Mine", icon: "list" },
  { key: "messages", href: "/student/messages", label: "Notifications", short: "Notifications", icon: "bell" },
  { key: "memos", href: "/memos", label: "Memos", short: "Memos", icon: "memo" },
];

function Count({ n, onDark = false }: { n: number; onDark?: boolean }) {
  if (!n) return null;
  return (
    <span
      className={`inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold tabular-nums ${onDark ? "bg-white text-[var(--brand-800)]" : "bg-[var(--brand-600)] text-white"}`}
    >
      {n}
      <span className="sr-only"> unread</span>
    </span>
  );
}

/**
 * Signed-in student layout: burgundy sidebar (from 860px), top bar, bottom tab bar (phones).
 * Server component; unread counts come from the server.
 */
export function StudentShell(props: { username: string; department: string | null; unreadMessages: number; unreadMemos: number; children: React.ReactNode }) {
  const counts: Partial<Record<NavKey, number>> = { messages: props.unreadMessages, memos: props.unreadMemos };
  const dept = departmentName(props.department);
  return (
    <div className="grid min-h-dvh grid-cols-1 min-[860px]:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Student" className="hidden flex-col gap-0.5 bg-[var(--brand-800)] p-3 text-[#F3E3E8] min-[860px]:flex">
        <Link href="/student/dashboard" className="flex flex-wrap items-center gap-2 px-1 pb-4 text-white no-underline">
          <LogoMarks size={36} onDark />
          <span className="text-[15px] font-semibold leading-tight">
            DLI Students&apos; Association
            <small className="block text-xs font-normal text-[#E2C6CF]">Student Support Portal</small>
          </span>
        </Link>
        <ShellLink
          href="/student/complaints/new"
          exact
          className="mb-2.5 mt-1 flex min-h-11 items-center justify-center gap-2 rounded-md bg-white px-2 text-center text-sm font-bold text-[var(--brand-800)] hover:bg-[#FBEFF2]"
        >
          <Icon name="plus" />
          New complaint or suggestion
        </ShellLink>
        {NAV.map((n) => (
          <ShellLink
            key={n.key}
            href={n.href}
            exact={n.exact}
            exclude={["/student/complaints/new"]}
            className="group flex min-h-10 items-center justify-between rounded-md px-2.5 text-sm text-[#F3E3E8] hover:bg-white/10 aria-[current=page]:bg-white aria-[current=page]:font-semibold aria-[current=page]:text-[var(--brand-800)]"
          >
            <span className="flex items-center gap-2.5">
              <Icon name={n.icon} />
              {n.label}
            </span>
            <Count n={counts[n.key] ?? 0} onDark />
          </ShellLink>
        ))}
        <div className="mt-auto border-t border-white/10 pt-3">
          <ShellLink href="/privacy" className="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-[#F3E3E8] hover:bg-white/10 aria-[current=page]:bg-white aria-[current=page]:text-[var(--brand-800)]">
            <Icon name="shield" />
            Privacy
          </ShellLink>
          <form action={logoutStudentAction}>
            <button className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-[#F3E3E8] hover:bg-white/10">
              <Icon name="out" />
              Sign out
            </button>
          </form>
        </div>
      </nav>

      <div className="flex min-w-0 flex-col bg-[var(--sunken)]">
        <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 min-[860px]:gap-3 min-[860px]:px-6 min-[860px]:py-2.5">
          <Link href="/student/dashboard" className="min-[860px]:hidden" aria-label="Home">
            <LogoMarks size={34} />
          </Link>
          <form role="search" action="/student/complaints" className="relative hidden max-w-[420px] flex-1 min-[860px]:block">
            <label htmlFor="tsearch" className="sr-only">
              Search my complaints and suggestions
            </label>
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">
              <Icon name="search" size={16} />
            </span>
            <input
              id="tsearch"
              name="q"
              placeholder="Search my complaints and suggestions"
              className="min-h-11 w-full rounded-full border border-[var(--border)] bg-[var(--sunken)] pl-10 pr-4 text-base"
            />
          </form>
          <span className="flex-1" />
          <ThemeToggle />
          <Link
            href="/student/messages"
            aria-label={props.unreadMessages ? `Notifications, ${props.unreadMessages} unread` : "Notifications"}
            className="relative grid h-10 w-10 place-items-center rounded-lg border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--brand-50)]"
          >
            <Icon name="bell" />
            {props.unreadMessages > 0 && (
              <span aria-hidden="true" className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--brand-600)] px-0.5 text-[10px] font-bold text-white">
                {props.unreadMessages}
              </span>
            )}
          </Link>
          <span className="flex items-center gap-2.5 text-sm leading-tight">
            <span aria-hidden="true" className="grid h-[38px] w-[38px] place-items-center rounded-full bg-[var(--brand-600)] font-bold text-white">
              {props.username[0]?.toUpperCase()}
            </span>
            <span className="hidden min-[860px]:block">
              <b>{props.username}</b>
              {dept && <small className="block text-xs text-[var(--muted)]">{dept}</small>}
            </span>
          </span>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1180px] flex-1 px-3 pb-6 pt-4 outline-none min-[860px]:p-6">
          {props.children}
        </main>
        <footer className="mx-auto w-full max-w-[1180px] px-3 pb-4 text-xs text-[var(--muted)] min-[860px]:px-6">{brand.footerCredit}</footer>

        <nav
          aria-label="Student (tabs)"
          className="sticky bottom-0 z-10 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--surface)] px-1 pb-[calc(6px+env(safe-area-inset-bottom,0px))] pt-1.5 min-[860px]:hidden"
        >
          {[NAV[0], NAV[1], null, NAV[2], NAV[3]].map((n) =>
            n === null ? (
              <ShellLink
                key="new"
                href="/student/complaints/new"
                exact
                className="flex flex-col items-center gap-0.5 text-[11px] font-semibold text-[var(--link)]"
              >
                <span className="-mt-6 grid h-[52px] w-[52px] place-items-center rounded-full border-[3px] border-[var(--surface)] bg-[var(--brand-600)] text-white shadow-[0_4px_12px_rgba(112,0,35,.35)]">
                  <Icon name="plus" />
                </span>
                New
              </ShellLink>
            ) : (
              <ShellLink
                key={n.key}
                href={n.href}
                exclude={["/student/complaints/new"]}
                className="relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] text-[var(--muted)] aria-[current=page]:font-semibold aria-[current=page]:text-[var(--link)]"
              >
                <Icon name={n.icon} />
                {n.short}
                {(counts[n.key] ?? 0) > 0 && (
                  <span className="absolute left-[calc(50%+4px)] top-0.5">
                    <Count n={counts[n.key]!} />
                  </span>
                )}
              </ShellLink>
            ),
          )}
        </nav>
      </div>
    </div>
  );
}
