"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current server page on an interval while `active`, stopping after
 * `maxMs`. Used while a complaint is still being analysed.
 */
export function RefreshWhile({ active, intervalMs = 2500, maxMs = 60_000 }: { active: boolean; intervalMs?: number; maxMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > maxMs) clearInterval(t);
      else router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, maxMs, router]);
  return null;
}

/**
 * Polls a lightweight endpoint returning an activity "version" and refreshes the page only
 * when it changes, so dashboards update promptly when background processing completes
 * without reloading the whole page.
 */
export function LiveRefresh({ versionUrl, intervalMs = 5000 }: { versionUrl: string; intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(versionUrl, { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version: string };
        if (last.current !== null && version !== last.current && !stopped) router.refresh();
        last.current = version;
      } catch {
        /* transient network error: try again next tick */
      }
    }
    poll();
    const t = setInterval(poll, intervalMs);
    // Polling pauses in hidden tabs; catch up immediately when the tab is shown again.
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [versionUrl, intervalMs, router]);
  return null;
}
