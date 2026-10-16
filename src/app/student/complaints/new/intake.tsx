"use client";

import { useState, useSyncExternalStore } from "react";
import { ChatIntake } from "@/components/student/ChatIntake";
import { ComplaintForm } from "./complaint-form";

const noop = () => () => {};

/**
 * Without JavaScript (and on first paint) this is the classic form. Once the page is
 * interactive it becomes the chat, and the student can switch either way.
 */
export function Intake(props: { categories: { id: number; name: string; description: string }[]; signedInAs: string | null; missingDepartment: boolean }) {
  // False on the server and during hydration, true afterwards.
  const interactive = useSyncExternalStore(noop, () => true, () => false);
  const [prefer, setPrefer] = useState<"chat" | "form">("chat");

  if (interactive && prefer === "chat") {
    return <ChatIntake signedInAs={props.signedInAs} needsDepartment={props.missingDepartment} categories={props.categories} onSwitchToForm={() => setPrefer("form")} />;
  }
  return (
    <div className="mx-auto max-w-[640px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Submit a complaint or suggestion</h1>
          <p className="mt-1.5 max-w-[60ch] text-[var(--muted)]">
            Something that needs fixing, or an idea to make things better: one short form either way. You&apos;ll follow it from your dashboard.
          </p>
        </div>
        {interactive && (
          <button
            type="button"
            onClick={() => setPrefer("chat")}
            className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-[var(--border-strong)] bg-transparent px-3 text-sm font-semibold text-[var(--foreground)]"
          >
            Use chat
          </button>
        )}
      </div>
      <ComplaintForm categories={props.categories} signedInAs={props.signedInAs} missingDepartment={props.missingDepartment} />
    </div>
  );
}
