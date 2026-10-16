"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** A shell navigation link that marks the current page with aria-current (styled via aria-[current=page]). */
export function ShellLink({
  href,
  match,
  exact = false,
  exclude,
  className,
  children,
  ...rest
}: {
  href: string;
  /** Other path prefixes that count as this section. */
  match?: string[];
  exact?: boolean;
  /** Paths under this section that belong to another link. */
  exclude?: string[];
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}) {
  const pathname = usePathname();
  const prefixes = [href, ...(match ?? [])];
  const current =
    !exclude?.includes(pathname) && (exact ? pathname === href : prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`)));
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={cn("no-underline", className)} {...rest}>
      {children}
    </Link>
  );
}
