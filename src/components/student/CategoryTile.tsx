import { Icon, type IconName } from "@/components/ui/Icon";

/** Icon per category name (the names are stable; slugs are not available on every query). */
function iconFor(category: string): IconName {
  const c = category.toLowerCase();
  if (c.includes("exam")) return "check";
  if (c.includes("timetable")) return "cal";
  if (c.includes("material")) return "list";
  if (c.includes("welfare")) return "shield";
  if (c.includes("administrative")) return "form";
  if (c.includes("communication")) return "memo";
  if (c.includes("facilit")) return "home";
  if (c.includes("suggestion")) return "bulb";
  if (c.includes("feedback")) return "chat";
  return "inbox";
}

/** Tinted square with the category's icon; decorative (the category name is always shown as text). */
export function CategoryTile({ category, size = 40 }: { category: string; size?: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-lg bg-[var(--brand-50)] text-[var(--link)]">
      <Icon name={iconFor(category)} />
    </span>
  );
}
