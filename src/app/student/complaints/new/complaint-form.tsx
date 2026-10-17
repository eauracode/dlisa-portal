"use client";

import { useActionState, useState } from "react";
import { submitComplaintAction, type FormState } from "../../actions";
import { Alert, Button, FieldError, Label, Select, Textarea } from "@/components/ui";
import { UsernameField } from "@/components/username-field";
import { DepartmentSelect } from "@/components/student/DepartmentSelect";
import { DESCRIPTION_MAX, DESCRIPTION_MIN } from "@/lib/limits";

interface Category {
  id: number;
  name: string;
  description: string;
}

export function ComplaintForm({
  categories,
  signedInAs,
  missingDepartment,
}: {
  categories: Category[];
  signedInAs: string | null;
  /** Signed-in student who registered before departments existed. */
  missingDepartment: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(submitComplaintAction, {});
  const [description, setDescription] = useState(state.values?.description ?? "");
  const err = state.fieldErrors ?? {};
  const n = description.trim().length;

  return (
    <form action={action} className="mt-6 space-y-4" noValidate>
      {state.error && (
        <Alert tone="warning">
          <b className="mb-0.5 block">Please wait a moment</b>
          {state.error}
        </Alert>
      )}
      {state.info && <Alert tone="info">{state.info}</Alert>}

      {signedInAs ? (
        <div className="rounded-[var(--radius-m)] border border-border bg-sunken p-4 text-sm">
          Logging as <b>{signedInAs}</b>
          {(missingDepartment || state.needsDepartment) && <DepartmentSelect error={err.department} defaultValue={state.values?.department} />}
        </div>
      ) : (
        <UsernameField
          defaultMode={state.values?.mode === "returning" ? "returning" : "new"}
          defaultValue={state.values?.username}
          serverError={err.username}
          needsDepartment={state.needsDepartment}
          departmentError={err.department}
          departmentValue={state.values?.department}
        />
      )}

      <div>
        <Label htmlFor="categoryId">Category</Label>
        <Select id="categoryId" name="categoryId" required defaultValue={state.values?.categoryId ?? ""} aria-invalid={!!err.categoryId} aria-describedby="cat-err">
          <option value="">Choose a category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id} title={c.description}>
              {c.name}
            </option>
          ))}
        </Select>
        <FieldError id="cat-err" message={err.categoryId} />
      </div>
      <div>
        <Label htmlFor="description">Your complaint or suggestion</Label>
        <Textarea
          id="description"
          name="description"
          required
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Say what happened (which course or office, and when), or what you would like changed and why."
          className="min-h-40"
          aria-invalid={!!err.description}
          aria-describedby="desc-count desc-err"
        />
        <div id="desc-count" className="mt-1.5 flex justify-between gap-2 text-[13px] text-muted">
          <span>{n === 0 ? `At least ${DESCRIPTION_MIN} characters` : n < DESCRIPTION_MIN ? `${DESCRIPTION_MIN - n} more characters needed` : "Looks good"}</span>
          <span className="tabular-nums">
            {description.length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
          </span>
        </div>
        <FieldError id="desc-err" message={err.description} />
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Submitting…" : "Submit"}
      </Button>
      <p className="text-xs text-muted">Only you and the Students&apos; Association team can read this. Staff see a reporter code, never your username.</p>
    </form>
  );
}
