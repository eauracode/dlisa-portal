import { rows, type Db } from "../../db";
import { departmentName } from "../../departments";
import { DEPARTMENT_DISCLOSURE_THRESHOLD, departmentForStaff } from "../../privacy";

/*
 * Department information on staff screens. Every display goes through departmentForStaff()
 * (src/lib/privacy.ts): withheld for sensitive issues, and when fewer than
 * DEPARTMENT_DISCLOSURE_THRESHOLD students from that department reported the same issue.
 * Department FILTERS apply the same rule, so a filter can never reveal what a display hides.
 */

export interface DepartmentCount {
  code: string;
  students: number;
}

/** Distinct reporting students per department on one issue. */
export async function issueDepartmentCounts(db: Db, issueId: string): Promise<DepartmentCount[]> {
  return rows<DepartmentCount>(
    db,
    `select department_code as code, count(distinct student_id)::int as students
       from complaints where consolidated_issue_id = $1 and department_code is not null
      group by department_code order by students desc, department_code`,
    [issueId],
  );
}

/** Department label for one reporter on an issue, or null when it must be withheld. */
export function reporterDepartment(code: string | null, counts: DepartmentCount[], issueIsSensitive: boolean): string | null {
  return departmentForStaff({
    departmentCode: code,
    sameDepartmentReportersOnIssue: counts.find((c) => c.code === code)?.students ?? 0,
    issueIsSensitive,
  });
}

/** The issue summary's "By department" row: disclosed groups plus a count of the rest. */
export function departmentBreakdown(counts: DepartmentCount[], issueIsSensitive: boolean) {
  const shown = counts
    .map((c) => ({ name: departmentForStaff({ departmentCode: c.code, sameDepartmentReportersOnIssue: c.students, issueIsSensitive }), students: c.students }))
    .filter((c): c is { name: string; students: number } => c.name !== null);
  const total = counts.reduce((s, c) => s + c.students, 0);
  const withheld = total - shown.reduce((s, c) => s + c.students, 0);
  // Departments below the disclosure threshold, reported as a count only.
  const withheldGroups = counts.length - shown.length;
  return { shown, withheld, withheldGroups };
}

/**
 * SQL predicate: the issue (alias `i`) has at least the disclosure threshold of distinct
 * students from department `$n`, and is not sensitive. Used by the Department filters.
 */
export function issueDepartmentFilterSql(alias: string, paramIndex: number): string {
  return `(not ${alias}.sensitive and (select count(distinct dc.student_id) from complaints dc
            where dc.consolidated_issue_id = ${alias}.id and dc.department_code = $${paramIndex}) >= ${DEPARTMENT_DISCLOSURE_THRESHOLD})`;
}

export { departmentName, DEPARTMENT_DISCLOSURE_THRESHOLD };
