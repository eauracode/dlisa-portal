import Link from "next/link";
import { brand } from "@/config/brand";
import { getCurrentStudent } from "@/lib/auth/current";
import { getUnreadMessageCount } from "@/lib/services/messages";
import { countUnreadMemos } from "@/lib/services/memos";
import { LogoMarks } from "@/components/ui/LogoMarks";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { StudentShell } from "@/components/student/StudentShell";

/** Signed-out header: burgundy bar, logos, Memos / Privacy, theme toggle and Sign in. */
export async function PublicHeader() {
  const student = await getCurrentStudent();
  return (
    <header className="lp-header bg-[var(--brand-800)] text-white">
      <div className="mx-auto flex max-w-[1180px] items-center gap-2 px-3 py-2 sm:gap-4 sm:px-6">
        <Link href="/" aria-label={`${brand.portalName} home`} className="flex min-w-0 items-center gap-2.5 text-white no-underline">
          <LogoMarks size={34} onDark />
          <span className="hidden text-[15px] font-semibold leading-tight min-[420px]:block">
            DLI Students&apos; Association
            <small className="block text-xs font-normal text-[#E2C6CF]">Student Support Portal</small>
          </span>
        </Link>
        <span className="flex-1" />
        <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
          <Link href="/memos" className="flex min-h-10 items-center rounded-md px-2.5 text-sm text-white no-underline hover:bg-white/10">
            Memos
          </Link>
          <Link href="/privacy" className="flex min-h-10 items-center rounded-md px-2.5 text-sm text-white no-underline hover:bg-white/10">
            Privacy
          </Link>
        </nav>
        <ThemeToggle className="border-white/35 bg-transparent text-white hover:border-white hover:bg-white/10" />
        <Link
          href={student ? "/student/dashboard" : "/student/access"}
          className="flex min-h-10 items-center whitespace-nowrap rounded-full border border-white/70 px-4 text-sm font-semibold text-white no-underline hover:bg-white hover:text-[var(--brand-800)]"
        >
          {student ? "My dashboard" : "Sign in"}
        </Link>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--sunken)] text-xs text-[var(--muted)]">
      <div className="mx-auto flex max-w-[1180px] flex-wrap justify-between gap-x-5 gap-y-2 px-4 py-5 sm:px-6">
        <span>{brand.footerCredit}</span>
        <span className="flex gap-4">
          <Link href="/memos">Memos</Link>
          <Link href="/privacy">Privacy notice</Link>
        </span>
      </div>
    </footer>
  );
}

export function PublicChrome({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <PublicHeader />
      <main id="main" tabIndex={-1} className={wide ? "outline-none" : "mx-auto min-h-[60vh] max-w-[1180px] px-4 pb-12 pt-6 outline-none sm:px-6"}>
        {children}
      </main>
      <PublicFooter />
    </>
  );
}

/** Signed in: the student shell. Signed out: the public header and footer. */
export async function AdaptiveChrome({ children }: { children: React.ReactNode }) {
  const student = await getCurrentStudent();
  if (!student) return <PublicChrome>{children}</PublicChrome>;
  const [unreadMessages, unreadMemos] = await Promise.all([
    getUnreadMessageCount(student.id).catch(() => 0),
    countUnreadMemos(student.id).catch(() => 0),
  ]);
  return (
    <StudentShell username={student.username} department={student.department_code} unreadMessages={unreadMessages} unreadMemos={unreadMemos}>
      {children}
    </StudentShell>
  );
}
