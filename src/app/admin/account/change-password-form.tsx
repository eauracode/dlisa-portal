"use client";

import { useActionState } from "react";
import { changeAdminPasswordAction, type AdminFormState } from "../actions";
import { Alert, Button, FieldError, Input, Label } from "@/components/ui";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(changeAdminPasswordAction, {});
  const err = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {(
        [
          ["currentPassword", "Current password", "current-password"],
          ["newPassword", "New password (min 12 characters, letters and numbers)", "new-password"],
          ["confirmPassword", "Confirm new password", "new-password"],
        ] as const
      ).map(([name, label, ac]) => (
        <div key={name}>
          <Label htmlFor={name}>{label}</Label>
          <Input id={name} name={name} type="password" autoComplete={ac} required aria-invalid={!!err[name]} aria-describedby={`${name}-err`} />
          <FieldError id={`${name}-err`} message={err[name]} />
        </div>
      ))}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
