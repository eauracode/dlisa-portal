"use client";

import { useActionState } from "react";
import Link from "next/link";
import { accessAction, type FormState } from "../actions";
import { Alert, Button } from "@/components/ui";
import { UsernameField } from "@/components/username-field";

/** Returning students: username only (plus the one-time department step if they have none). */
export function AccessForms({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(accessAction, {});
  return (
    <form action={action} className="mt-5 space-y-4" noValidate>
      <input type="hidden" name="next" value={next ?? ""} />
      {state.error && <Alert tone="warning">{state.error}</Alert>}
      {state.info && <Alert tone="info">{state.info}</Alert>}
      <UsernameField
        defaultMode="returning"
        showSwitch={false}
        defaultValue={state.values?.username}
        serverError={state.fieldErrors?.username}
        needsDepartment={state.needsDepartment}
        departmentError={state.fieldErrors?.department}
        departmentValue={state.values?.department}
      />
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Checking…" : "Continue"}
      </Button>
      <p className="text-center text-sm text-[var(--muted)]">
        New here? <Link href="/student/complaints/new">Start your first complaint or suggestion</Link>
      </p>
    </form>
  );
}
