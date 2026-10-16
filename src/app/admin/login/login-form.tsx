"use client";

import { useActionState } from "react";
import { adminLoginAction, type AdminFormState } from "../actions";
import { Alert, Button, FieldError, Input, Label } from "@/components/ui";

export function AdminLoginForm() {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(adminLoginAction, {});
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state.values?.email} aria-invalid={!!state.fieldErrors?.email} aria-describedby="email-err" />
        <FieldError id="email-err" message={state.fieldErrors?.email} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!state.fieldErrors?.password} aria-describedby="password-err" />
        <FieldError id="password-err" message={state.fieldErrors?.password} />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
