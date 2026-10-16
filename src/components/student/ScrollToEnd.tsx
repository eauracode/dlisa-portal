"use client";

import { useEffect } from "react";

/** Scrolls a conversation log to its newest message once it has rendered. */
export function ScrollToEnd({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (el) el.scrollTop = el.scrollHeight;
  }, [targetId]);
  return null;
}
