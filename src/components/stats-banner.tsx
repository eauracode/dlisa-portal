import { one, pool } from "@/lib/db";

/**
 * Site-wide banner with live totals. Only aggregate counts are shown — never any
 * individual complaint or username.
 *  - Issues logged: every complaint students have submitted
 *  - Active students: student accounts that are active (not suspended or deleted)
 */
export async function StatsBanner() {
  let stats: { complaints: number; students: number } | null = null;
  try {
    stats = await one<{ complaints: number; students: number }>(
      pool(),
      `select (select count(*)::int from complaints) as complaints,
              (select count(*)::int from students where account_status = 'active') as students`,
    );
  } catch {
    // The banner must never break a page (e.g. while the database is unavailable).
    return null;
  }
  if (!stats) return null;
  const fmt = new Intl.NumberFormat("en-NG");
  return (
    <div role="status" aria-label="Portal statistics" className="bg-brand-800 text-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-6 gap-y-1 px-4 py-2 text-[13px]">
        <span>
          <span className="font-semibold tabular-nums">{fmt.format(stats.complaints)}</span> issue{stats.complaints === 1 ? "" : "s"} logged
        </span>
        <span aria-hidden className="hidden opacity-80 sm:inline">
          •
        </span>
        <span>
          <span className="font-semibold tabular-nums">{fmt.format(stats.students)}</span> active student{stats.students === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
