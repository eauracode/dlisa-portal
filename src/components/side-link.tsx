"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Staff sidebar link: the current page is a white pill on the burgundy sidebar. */
export function SideLink({ href, children, count }: { href: string; children: React.ReactNode; count?: number }) {
  const pathname = usePathname();
  const current = href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className="flex min-h-10 items-center justify-between gap-2 rounded-[var(--radius-s)] px-2.5 text-sm text-[#F3E3E8] no-underline hover:bg-white/10 aria-[current=page]:bg-white aria-[current=page]:font-semibold aria-[current=page]:text-[#3F0014]"
    >
      {children}
      {!!count && (
        <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-white px-[5px] text-[11px] font-semibold text-[#3F0014] tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );
}
