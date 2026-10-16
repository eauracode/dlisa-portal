"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ActionTab {
  id: string;
  label: string;
  content: React.ReactNode;
}

/**
 * Grouped issue actions (Respond / Schedule / Triage / Restructure).
 * Without JavaScript every group renders one after another under its heading, so all forms
 * still work; once hydrated it becomes an ARIA tab list (arrow keys, Home/End).
 * Only tabs the signed-in role can use are passed in.
 */
export function ActionTabs({ tabs, note }: { tabs: ActionTab[]; note?: string }) {
  const [enhanced, setEnhanced] = useState(false);
  const [active, setActive] = useState(tabs[0]?.id);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Switch to tabs only after hydration (the no-JS rendering shows everything).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setEnhanced(true), []);

  if (tabs.length === 0) return null;

  function onKey(e: React.KeyboardEvent, i: number) {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(tabs[next].id);
    refs.current[next]?.focus();
  }

  return (
    <aside aria-label="Actions" className="rounded-[var(--radius-m)] border border-border bg-surface shadow-card min-[1000px]:sticky min-[1000px]:top-4">
      {enhanced && (
        <div role="tablist" aria-label="Issue actions" className="grid border-b border-border" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={active === t.id ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "-mb-px cursor-pointer border-b-2 px-1 py-3 text-center text-[13px] font-semibold",
                active === t.id ? "border-brand-600 text-link" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`panel-${t.id}`}
          role={enhanced ? "tabpanel" : undefined}
          aria-labelledby={enhanced ? `tab-${t.id}` : undefined}
          hidden={enhanced && active !== t.id}
          className="space-y-2 p-4"
        >
          {!enhanced && <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{t.label}</h2>}
          {t.content}
        </div>
      ))}
      {note && <p className="mx-4 mb-4 rounded-[var(--radius-m)] border border-dashed border-border-strong px-3.5 py-3 text-[13px] text-muted">{note}</p>}
    </aside>
  );
}
