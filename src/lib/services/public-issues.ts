import { rows, withPublicContext } from "../db";

export interface PublicIssue {
  id: string;
  title: string;
  summary: string;
  category: string;
  status: string;
  expected_resolution_at: Date | null;
  last_activity_at: Date;
  latest_update: string | null;
}

/**
 * Approved, anonymised issue summaries only. Runs as the `portal_public` role, which can
 * read nothing but the public title/summary/status columns of issues marked public.
 */
export async function listPublicIssues(): Promise<PublicIssue[]> {
  return withPublicContext((tx) =>
    rows<PublicIssue>(
      tx,
      `select i.id, i.public_title as title, i.public_summary as summary, cat.name as category, i.status,
              i.expected_resolution_at, i.last_activity_at,
              (select u.message from issue_updates u where u.consolidated_issue_id = i.id and u.visibility = 'public'
                order by u.created_at desc limit 1) as latest_update
         from consolidated_issues i
         join issue_categories cat on cat.id = i.category_id
        order by (i.status in ('resolved', 'closed')), i.last_activity_at desc
        limit 100`,
    ),
  );
}
