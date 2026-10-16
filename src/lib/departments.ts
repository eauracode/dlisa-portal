// DLI departments (official list). `code` is what gets stored; never store free text.
// Keep in sync with the `departments` table (db/migrations/0006_dli_departments.sql).
export const DEPARTMENTS = [
  { code: "ACC", name: "Accounting" },
  { code: "BUS", name: "Business Administration" },
  { code: "FIN", name: "Finance" },
  { code: "ECO", name: "Economics" },
  { code: "PAD", name: "Public Administration" },
  { code: "EBI", name: "(Ed.) Biology" },
  { code: "ECH", name: "(Ed.) Chemistry" },
  { code: "EPH", name: "(Ed.) Physics" },
  { code: "EMA", name: "(Ed.) Mathematics" },
  { code: "EEC", name: "(Ed.) Economics" },
  { code: "ECE", name: "Early Childhood Education" },
  { code: "EDM", name: "Educational Management" },
  { code: "GCO", name: "Guidance and Counselling" },
  { code: "BED", name: "Business Education" },
  { code: "EEN", name: "(Ed.) English" },
] as const;

export type DepartmentCode = (typeof DEPARTMENTS)[number]["code"];
export const DEPARTMENT_CODES = DEPARTMENTS.map((d) => d.code) as [DepartmentCode, ...DepartmentCode[]];

export function departmentName(code: string | null | undefined): string | null {
  return DEPARTMENTS.find((d) => d.code === code)?.name ?? null;
}
