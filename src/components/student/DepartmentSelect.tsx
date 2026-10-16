import { DEPARTMENTS } from "@/lib/departments";

/**
 * Required on the "New here" path of the username block (submit form + access page).
 * Plain <select> inside the existing <form>, so it works without JavaScript.
 * Render only when mode === "new" (or when a returning user has no department yet).
 */
export function DepartmentSelect({ error, defaultValue }: { error?: string; defaultValue?: string }) {
  return (
    <div className="mt-3.5">
      <label htmlFor="department" className="mb-1.5 block text-sm font-semibold">
        Your department
      </label>
      <select
        id="department"
        name="department"
        required
        defaultValue={defaultValue ?? ""}
        aria-describedby={error ? "department-hint department-error" : "department-hint"}
        aria-invalid={error ? true : undefined}
        className="min-h-11 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--foreground)] focus:border-[var(--brand-600)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--brand-500)] aria-[invalid=true]:border-[var(--danger-fg)]"
      >
        <option value="">Choose your department</option>
        {DEPARTMENTS.map((d) => (
          <option key={d.code} value={d.code}>
            {d.name}
          </option>
        ))}
      </select>
      <p id="department-hint" className="mt-1.5 text-[13px] text-[var(--muted)]">
        Saved with your username so the Union can route complaints to the right people. You only pick it once.
      </p>
      {error && (
        <p id="department-error" className="mt-1.5 text-[13px] font-medium text-[var(--danger-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}
