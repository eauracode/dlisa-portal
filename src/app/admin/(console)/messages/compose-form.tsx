"use client";

import { useState } from "react";
import { sendMessageAction } from "../../actions";
import { Button, Hint, Input, Label, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ReuseCheckbox } from "@/components/reuse-checkbox";

type TargetType = "issue" | "username" | "department" | "open_complaints";

interface IssueOption {
  id: string;
  title: string;
  status: string;
  reporters: number;
}

export function ComposeMessageForm({
  issues,
  allowed,
  activeStudents,
  departments,
  defaultIssueId,
}: {
  issues: IssueOption[];
  allowed: Record<TargetType, boolean>;
  activeStudents: number;
  departments: { code: string; name: string }[];
  defaultIssueId?: string;
}) {
  const options = (
    [
      ["issue", "Everyone on an issue", "Lands in each reporter's complaint chat"],
      ["username", "A specific username", "One student, by their username"],
      ["department", "A department", "Every active student in one department"],
      ["open_complaints", "Students with an open complaint", `Anyone with a complaint not yet resolved (of ${activeStudents} active)`],
    ] as const
  ).filter(([t]) => allowed[t]);
  const [type, setType] = useState<TargetType>(options[0]?.[0] ?? "issue");
  const [issueId, setIssueId] = useState(defaultIssueId ?? "");
  const selected = issues.find((i) => i.id === issueId);

  return (
    <form action={sendMessageAction} className="space-y-5">
      <input type="hidden" name="targetType" value={type} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Send to</legend>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
          {options.map(([t, label, hint]) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm",
                type === t ? "border-brand-600 bg-brand-50" : "border-border bg-surface hover:bg-brand-50/50",
              )}
            >
              <span className="block font-medium">{label}</span>
              <span className="block text-xs text-muted">{hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {type === "issue" && (
        <div>
          <Label htmlFor="issueId">Grouped issue</Label>
          <Select id="issueId" name="issueId" required value={issueId} onChange={(e) => setIssueId(e.target.value)}>
            <option value="" disabled>
              Choose an issue
            </option>
            {issues.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title} — {i.reporters} student{i.reporters === 1 ? "" : "s"}
                {["resolved", "closed"].includes(i.status) ? " (resolved)" : ""}
              </option>
            ))}
          </Select>
          <Hint>
            {selected
              ? `This will reach the ${selected.reporters} student${selected.reporters === 1 ? "" : "s"} who reported this issue, in their private Messages inbox.`
              : "Every student who reported the issue receives the message privately."}
          </Hint>
        </div>
      )}

      {type === "username" && (
        <div>
          <Label htmlFor="username">Username</Label>
          <Input id="username" name="username" required autoCapitalize="none" spellCheck={false} maxLength={64} placeholder="e.g. quiet_owl" />
          <Hint>Capital letters do not matter. Only this student will see the message.</Hint>
        </div>
      )}

      {type === "department" && (
        <div>
          <Label htmlFor="department">Department</Label>
          <Select id="department" name="department" required defaultValue="">
            <option value="" disabled>
              Choose a department
            </option>
            {departments.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </Select>
          <Hint>Every active student who chose this department receives it in their Messages.</Hint>
        </div>
      )}

      <div>
        <Label htmlFor="subject">Subject</Label>
        <Input id="subject" name="subject" required minLength={3} maxLength={150} placeholder="e.g. Update on the examination timetable" />
      </div>
      <div>
        <Label htmlFor="body">Message</Label>
        <Textarea id="body" name="body" required minLength={5} maxLength={4000} rows={7} placeholder="Write the message students will read." />
        <Hint>Students see this as coming from the DLI Students&apos; Association. Do not promise dates or outcomes that have not been confirmed.</Hint>
      </div>
      {/* Re-mounted per audience so the default follows it: direct replies are not reused unless chosen. */}
      <ReuseCheckbox key={type} defaultChecked={type !== "username"} personal={type === "username"} />
      <Button type="submit">Send message</Button>
    </form>
  );
}
