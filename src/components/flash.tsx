import { Alert } from "@/components/ui";

/** Shows the ?ok= / ?err= / ?denied= result of a redirecting admin action. */
export function Flash({ ok, err, denied }: { ok?: string; err?: string; denied?: string }) {
  if (denied) return <Alert tone="error" className="mb-4">You do not have permission to open that page.</Alert>;
  if (err) return <Alert tone="error" className="mb-4">{err.slice(0, 300)}</Alert>;
  if (ok) return <Alert tone="success" className="mb-4">{ok.slice(0, 300)}</Alert>;
  return null;
}

export type FlashParams = Promise<{ ok?: string; err?: string; denied?: string }>;
