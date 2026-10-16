"use client";

import { useEffect, useRef, useState } from "react";
import { checkUsernameAction, type UsernameCheck } from "@/app/student/actions";
import { FieldError, Hint, Input, Label } from "@/components/ui";
import { DepartmentSelect } from "@/components/student/DepartmentSelect";
import { cn } from "@/lib/utils";

/**
 * The username block: a "New here" / "I have a username" switch, the username input (with a
 * live "already picked" check for new names) and, for new students — or returning students
 * who have never chosen one — the department select. Renders in its initial mode without
 * JavaScript, so the form still submits.
 */
export function UsernameField({
  defaultMode = "new",
  defaultValue = "",
  serverError,
  needsDepartment = false,
  departmentError,
  departmentValue,
  showSwitch = true,
}: {
  defaultMode?: "new" | "returning";
  defaultValue?: string;
  serverError?: string;
  needsDepartment?: boolean;
  departmentError?: string;
  departmentValue?: string;
  /** False on the access page, which is for returning students only. */
  showSwitch?: boolean;
}) {
  const [mode, setMode] = useState<"new" | "returning">(defaultMode);
  const [value, setValue] = useState(defaultValue);
  const [check, setCheck] = useState<UsernameCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Debounced availability check, triggered by typing (only for new usernames).
  function scheduleCheck(nextValue: string, nextMode: "new" | "returning") {
    clearTimeout(timer.current);
    const ticket = ++latest.current;
    setCheck(null);
    if (nextMode !== "new" || nextValue.trim().length < 3) {
      setChecking(false);
      return;
    }
    setChecking(true);
    timer.current = setTimeout(async () => {
      try {
        const result = await checkUsernameAction(nextValue);
        if (ticket === latest.current) setCheck(result);
      } finally {
        if (ticket === latest.current) setChecking(false);
      }
    }, 400);
  }

  // The server error only applies while the field still holds the value that was submitted.
  const error = check?.status === "taken" || check?.status === "invalid" ? check.message : value === defaultValue ? serverError : undefined;
  const available = mode === "new" && check?.status === "available";
  const showDepartment = mode === "new" || needsDepartment;

  return (
    <fieldset className="rounded-[var(--radius-m)] border border-border bg-sunken p-4">
      <input type="hidden" name="mode" value={mode} />
      <legend className="sr-only">Your username</legend>
      <div role="group" aria-label="Username" hidden={!showSwitch} className="mb-3.5 grid grid-cols-2 rounded-[var(--radius-m)] border border-border-strong bg-surface p-[3px]">
        {(
          [
            ["new", "New here"],
            ["returning", "I have a username"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              scheduleCheck(value, m);
            }}
            className={cn(
              "min-h-10 cursor-pointer rounded-[var(--radius-s)] text-center text-sm font-semibold",
              mode === m ? "bg-brand-600 text-on-brand" : "text-muted hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div>
        <Label htmlFor="username">{mode === "new" ? "Choose a username" : "Your username"}</Label>
        <Input
          id="username"
          name="username"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            scheduleCheck(e.target.value, mode);
          }}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          required
          aria-invalid={!!error}
          aria-describedby="username-hint username-status"
        />
        {mode === "new" && (
          <Hint id="username-hint">3–24 letters, numbers, dots, hyphens or underscores. If you want to stay anonymous, avoid your real name or matric number.</Hint>
        )}
        <div id="username-status" role="status" aria-live="polite">
          {mode === "new" && checking && <p className="mt-1.5 text-[13px] text-muted">Checking…</p>}
          {available && !checking && <p className="mt-1.5 text-[13px] font-medium text-ok-fg">✓ {check!.message}</p>}
          {!checking && <FieldError message={error} />}
        </div>
      </div>
      {showDepartment && <DepartmentSelect error={departmentError} defaultValue={departmentValue} />}
    </fieldset>
  );
}
