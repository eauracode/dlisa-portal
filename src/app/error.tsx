"use client";

import { Button } from "@/components/ui";

// Generic message only: never reveal database or infrastructure details to users.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        We could not complete that request. Nothing you submitted earlier has been lost. Please try again in a moment.
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
