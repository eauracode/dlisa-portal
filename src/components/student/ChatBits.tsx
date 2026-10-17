/** Round initials avatar for chat bubbles: the Association (DLI), management (MGT) or a reporter (R). */
export function BotAvatar({ small, label = "DLI", tone = "brand" }: { small?: boolean; label?: string; tone?: "brand" | "mgt" | "reporter" }) {
  const bg = tone === "mgt" ? "bg-[var(--violet-fg)]" : tone === "reporter" ? "bg-[var(--neutral-fg)]" : "bg-[var(--brand-600)]";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-bold text-[var(--surface)] ${bg} ${small ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs"}`}
    >
      {label}
    </span>
  );
}
