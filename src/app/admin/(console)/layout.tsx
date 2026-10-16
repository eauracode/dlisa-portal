import Link from "next/link";
import { one, pool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/current";
import { can, ROLE_LABELS, type Permission } from "@/lib/auth/permissions";
import { adminLogoutAction } from "../actions";
import { LogoMarks } from "@/components/ui/LogoMarks";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { SideLink } from "@/components/side-link";
import { countUnreadForStaff } from "@/lib/services/conversations";
import { buttonVariants } from "@/components/ui";

const WORK: Array<{ href: string; label: string; permission?: Permission }> = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/live", label: "Live monitor" },
  { href: "/admin/issues", label: "Issues" },
  { href: "/admin/complaints", label: "Submissions" },
  { href: "/admin/match-review", label: "Match review", permission: "matches.review" },
  { href: "/admin/messages", label: "Messages & memos", permission: "messages.view" },
  { href: "/admin/reports", label: "Reports", permission: "reports.view" },
];

const ADMINISTRATION: Array<{ href: string; label: string; permission: Permission }> = [
  { href: "/admin/users", label: "Staff accounts", permission: "admins.manage" },
  { href: "/admin/settings", label: "Settings", permission: "settings.manage" },
  { href: "/admin/audit", label: "Audit log", permission: "audit.view" },
];

export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const work = WORK.filter((n) => !n.permission || can(admin.role, n.permission));
  const administration = ADMINISTRATION.filter((n) => can(admin.role, n.permission));
  // Unread student messages in complaint conversations the staff member can see.
  const unreadConversations = can(admin.role, "messages.view") ? await countUnreadForStaff(pool(), admin).catch(() => 0) : 0;
  const pendingMatches = can(admin.role, "matches.review")
    ? ((await one<{ n: number }>(pool(), `select count(*)::int as n from ai_match_reviews where review_status = 'pending'`))?.n ?? 0)
    : 0;

  return (
    <div className="grid min-h-[calc(100dvh-36px)] min-[760px]:grid-cols-[232px_1fr]">
      <nav aria-label="Staff console" className="flex flex-row flex-wrap gap-1 bg-brand-800 px-3 py-4 text-[#F3E3E8] min-[760px]:flex-col min-[760px]:flex-nowrap min-[760px]:gap-0.5">
        <Link href="/admin" className="flex w-full flex-wrap items-center gap-2.5 px-2 pb-2 text-white no-underline min-[760px]:px-1 min-[760px]:pb-4">
          <LogoMarks size={36} onDark />
          <span className="text-[15px] font-semibold">
            Union Console
            <small className="block text-xs font-normal text-[#D9BCC5]">Staff only</small>
          </span>
        </Link>
        {work.map((n) => (
          <SideLink key={n.href} href={n.href} count={n.href === "/admin/match-review" ? pendingMatches : n.href === "/admin/messages" ? unreadConversations : undefined}>
            {n.label}
          </SideLink>
        ))}
        {administration.length > 0 && (
          <>
            <span className="hidden px-2.5 pb-1 pt-3.5 text-xs text-[#C9A6B1] min-[760px]:block">Administration</span>
            {administration.map((n) => (
              <SideLink key={n.href} href={n.href}>
                {n.label}
              </SideLink>
            ))}
          </>
        )}
        <div className="mt-auto hidden border-t border-white/10 px-2.5 pt-3 text-xs text-[#D9BCC5] min-[760px]:block">
          Signed in as
          <br />
          <b className="text-white">{admin.display_name}</b>
          <br />
          {ROLE_LABELS[admin.role]}
        </div>
      </nav>
      <div className="min-w-0 bg-sunken">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-6 py-3">
          <span className="text-sm text-muted min-[760px]:hidden">
            {admin.display_name} · {ROLE_LABELS[admin.role]}
          </span>
          <span className="flex-1" />
          <ThemeToggle />
          <Link href="/admin/account" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Account
          </Link>
          <form action={adminLogoutAction}>
            <button type="submit" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign out
            </button>
          </form>
        </div>
        <main id="main" tabIndex={-1} className="max-w-[1280px] px-4 pb-12 pt-5 outline-none sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
