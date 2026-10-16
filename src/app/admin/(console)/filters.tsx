import { rows, pool } from "@/lib/db";
import { ISSUE_STATUS_LABELS, PRIORITY_LABELS } from "@/lib/format";
import { buttonVariants, Input, Label, Select } from "@/components/ui";
import { DEPARTMENTS } from "@/lib/departments";

export async function filterOptions() {
  const [categories, officers] = await Promise.all([
    rows<{ id: number; name: string }>(pool(), `select id, name from issue_categories order by sort_order`),
    rows<{ id: string; display_name: string }>(pool(), `select id, display_name from admin_users where active and role in ('union_admin','case_officer') order by display_name`),
  ]);
  return { categories, officers };
}

export function parseDate(v?: string): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00+01:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function endOfDay(v?: string): Date | null {
  const d = parseDate(v);
  return d ? new Date(d.getTime() + 86400_000) : null;
}

type Params = Record<string, string | undefined>;

/** Valid department code from the query string, or undefined. */
export function parseDepartment(v?: string): string | undefined {
  return DEPARTMENTS.some((d) => d.code === v) ? v : undefined;
}

function Field({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={wide ? "min-w-0 flex-[2_1_260px]" : "min-w-0 flex-[1_1_160px]"}>{children}</div>;
}

/** GET filter bar shared by the overview and issues pages (works without JavaScript). */
export function FilterBar({
  params,
  categories,
  officers,
  showOfficer = true,
  showSearch = false,
  showDates = true,
  extraStatuses = [],
}: {
  params: Params;
  categories: Array<{ id: number; name: string }>;
  officers: Array<{ id: string; display_name: string }>;
  showOfficer?: boolean;
  showSearch?: boolean;
  showDates?: boolean;
  extraStatuses?: Array<[string, string]>;
}) {
  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
      {showSearch && (
        <Field wide>
          <Label htmlFor="q">Search</Label>
          <Input id="q" name="q" defaultValue={params.q} placeholder="Title, summary or course code" />
        </Field>
      )}
      {showDates && (
        <>
          <Field>
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" name="from" defaultValue={params.from} />
          </Field>
          <Field>
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" name="to" defaultValue={params.to} />
          </Field>
        </>
      )}
      <Field>
        <Label htmlFor="category">Category</Label>
        <Select id="category" name="category" defaultValue={params.category ?? ""}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <Label htmlFor="department">Department</Label>
        <DepartmentFilterSelect value={params.department} />
      </Field>
      <Field>
        <Label htmlFor="priority">Priority</Label>
        <Select id="priority" name="priority" defaultValue={params.priority ?? ""}>
          <option value="">Any priority</option>
          {Object.entries(PRIORITY_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <Label htmlFor="status">Status</Label>
        <Select id="status" name="status" defaultValue={params.status ?? ""}>
          <option value="">Any status</option>
          {extraStatuses.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
          {Object.entries(ISSUE_STATUS_LABELS)
            .filter(([v]) => v !== "merged")
            .map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
        </Select>
      </Field>
      {showOfficer && (
        <Field>
          <Label htmlFor="assigned">Officer</Label>
          <Select id="assigned" name="assigned" defaultValue={params.assigned ?? ""}>
            <option value="">Any officer</option>
            <option value="unassigned">Unassigned</option>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.display_name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex gap-2">
        <button type="submit" className={buttonVariants({ variant: "ghost" })}>
          Apply
        </button>
        <a href="?" className={buttonVariants({ variant: "link", className: "min-h-11" })}>
          Reset
        </a>
      </div>
    </form>
  );
}

/** Department filter. Matches only departments with 5+ reporters on a non-sensitive issue. */
export function DepartmentFilterSelect({ value, id = "department" }: { value?: string; id?: string }) {
  return (
    <Select id={id} name="department" defaultValue={value ?? ""} title="Shows issues where at least 5 students from the department reported it">
      <option value="">All departments</option>
      {DEPARTMENTS.map((d) => (
        <option key={d.code} value={d.code}>
          {d.name}
        </option>
      ))}
    </Select>
  );
}
