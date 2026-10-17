"use client";

import { useMemo, useState } from "react";
import { Badge, type BadgeTone, Input } from "@/components/ui";
import type { SavedResponse } from "@/lib/services/faqs";

const KIND: Record<SavedResponse["kind"], { label: string; tone: BadgeTone }> = {
  faq: { label: "FAQ", tone: "brand" },
  memo: { label: "Memo", tone: "warn" },
  issue: { label: "Issue reply", tone: "info" },
  reply: { label: "Saved reply", tone: "violet" },
};

/** Close enough to the student's question to suggest it above the reply box. */
const SUGGEST_AT = 0.6;

/**
 * Lets staff answer with a saved response (FAQ, memo or earlier reply) instead of typing.
 * Choosing one fills the reply box (`textareaId`), where it can still be edited before sending.
 */
export function SavedResponsePicker({ textareaId, responses }: { textareaId: string; responses: SavedResponse[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [used, setUsed] = useState<string | null>(null);
  const best = responses[0]?.match != null && responses[0].match >= SUGGEST_AT ? responses[0] : null;

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? responses.filter((r) => `${r.title} ${r.body}`.toLowerCase().includes(t)) : responses;
  }, [q, responses]);

  function use(r: SavedResponse) {
    const box = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    if (!box) return;
    box.value = r.body;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
    setUsed(r.id);
    setOpen(false);
  }

  if (responses.length === 0) {
    return <p className="text-xs text-muted">No saved responses yet. Add common answers under FAQs, or tick &ldquo;Save as FAQ&rdquo; when you reply.</p>;
  }

  return (
    <div className="grid gap-2">
      {best && used !== best.id && (
        <div className="rounded-[var(--radius-s)] border border-brand-600 bg-brand-50 p-2.5 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <b className="text-xs">Suggested answer · {Math.round(best.match! * 100)}% match</b>
            <Badge tone={KIND[best.kind].tone}>{KIND[best.kind].label}</Badge>
          </div>
          <p className="font-medium">{best.title}</p>
          <p className="line-clamp-2 text-muted">{best.body}</p>
          <button type="button" onClick={() => use(best)} className="mt-1.5 text-sm font-semibold text-link underline">
            Use this answer
          </button>
        </div>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="justify-self-start text-sm font-semibold text-link underline">
        {open ? "Hide saved responses" : `Choose from saved responses (${responses.length})`}
      </button>
      {open && (
        <div className="grid gap-2 rounded-[var(--radius-s)] border border-border p-2.5">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved responses" aria-label="Search saved responses" />
          <ul className="grid max-h-72 gap-1.5 overflow-y-auto">
            {shown.length === 0 && <li className="p-2 text-sm text-muted">Nothing matches that search.</li>}
            {shown.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => use(r)} className="w-full rounded-[var(--radius-s)] border border-border p-2 text-left hover:border-brand-600 hover:bg-sunken">
                  <span className="mb-0.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge>
                    {r.match != null && <span className="text-xs text-muted">{Math.round(r.match * 100)}% match</span>}
                  </span>
                  <span className="block text-sm font-medium">{r.title}</span>
                  <span className="line-clamp-2 block text-xs text-muted">{r.body}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Save as FAQ": stores the reply as a frequently asked question so the next student gets it instantly. */
export function SaveAsFaq({ defaultQuestion }: { defaultQuestion: string }) {
  const [on, setOn] = useState(false);
  return (
    <div className="grid gap-1.5">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="saveFaq" checked={on} onChange={(e) => setOn(e.target.checked)} className="h-5 w-5 accent-brand-600" />
        Save as FAQ, so students who ask this get the answer instantly
      </label>
      {on && (
        <Input name="faqQuestion" defaultValue={defaultQuestion.slice(0, 150)} required minLength={5} maxLength={150} aria-label="FAQ question" placeholder="The question, as students ask it" />
      )}
    </div>
  );
}
