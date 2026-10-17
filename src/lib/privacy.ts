import { departmentName } from "./departments";

/**
 * Minimum number of distinct students from one department on the same issue
 * before oversight officers can see that department next to a reporter code. Association staff
 * (administrators and case officers) see usernames and departments directly.
 * Below this, a department can identify the person.
 */
export const DEPARTMENT_DISCLOSURE_THRESHOLD = 5;

/**
 * What staff screens should show for a reporter's department.
 * Returns null when it must be withheld (render "Department withheld" or nothing).
 * Aggregate counts (e.g. "Finance 14") follow the same rule per department.
 */
export function departmentForStaff(opts: {
  departmentCode: string | null;
  sameDepartmentReportersOnIssue: number;
  issueIsSensitive: boolean;
}): string | null {
  if (!opts.departmentCode) return null;
  if (opts.issueIsSensitive) return null;
  if (opts.sameDepartmentReportersOnIssue < DEPARTMENT_DISCLOSURE_THRESHOLD) return null;
  return departmentName(opts.departmentCode);
}
