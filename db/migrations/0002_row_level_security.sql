-- Defence in depth for student-facing and public queries.
--
-- The application connects with a privileged role (the table owner) for staff and system
-- work. Every query made on behalf of a student runs inside a transaction that switches to
-- the restricted `portal_student` role and sets `app.student_id`; public pages switch to
-- `portal_public`. These roles can only see the rows and columns granted below, so a bug in
-- application code cannot leak another student's complaints or any staff-only note.
--
-- RLS is also enabled on every table with no policy for other roles, which makes the schema
-- deny-by-default if it is ever exposed through a REST layer (e.g. the Supabase Data API).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'portal_student') then
    create role portal_student nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'portal_public') then
    create role portal_public nologin;
  end if;
  -- The connecting role must be a member to use SET ROLE (no-op for superusers).
  execute format('grant portal_student to %I', current_user);
  execute format('grant portal_public to %I', current_user);
end $$;

grant usage on schema public to portal_student, portal_public;

create or replace function app_current_student_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.student_id', true), '')::uuid $$;

grant execute on function app_current_student_id() to portal_student;

-- Evaluated with owner rights so the public role never needs column access to the flags.
create or replace function app_issue_is_public(issue_id uuid) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from consolidated_issues i where i.id = issue_id
                         and i.public_visibility and i.status <> 'merged' and not i.sensitive) $$;

revoke execute on function app_issue_is_public(uuid) from public;
grant execute on function app_issue_is_public(uuid) to portal_public;

-- Enable RLS everywhere (owner role bypasses it; restricted roles do not).
alter table issue_categories      enable row level security;
alter table app_settings          enable row level security;
alter table students              enable row level security;
alter table admin_users           enable row level security;
alter table sessions              enable row level security;
alter table rate_limits           enable row level security;
alter table consolidated_issues   enable row level security;
alter table complaints            enable row level security;
alter table complaint_analyses    enable row level security;
alter table issue_submissions     enable row level security;
alter table issue_updates         enable row level security;
alter table administrative_notes  enable row level security;
alter table issue_assignments     enable row level security;
alter table issue_proposals       enable row level security;
alter table issue_events          enable row level security;
alter table complaint_events      enable row level security;
alter table ai_match_reviews      enable row level security;
alter table match_jobs            enable row level security;
alter table audit_logs            enable row level security;

-- ---------------------------------------------------------------------------
-- Categories: readable by everyone.
-- ---------------------------------------------------------------------------
grant select on issue_categories to portal_student, portal_public;
create policy categories_read on issue_categories for select to portal_student, portal_public using (true);

-- ---------------------------------------------------------------------------
-- portal_student
-- ---------------------------------------------------------------------------
grant select (id, username, created_at) on students to portal_student;
create policy students_self on students for select to portal_student
  using (id = app_current_student_id());

grant select on complaints to portal_student;
grant insert (student_id, category_id, subject, description, content_fingerprint) on complaints to portal_student;
grant update (status, review_request_reason, last_viewed_at, updated_at) on complaints to portal_student;
create policy complaints_own_select on complaints for select to portal_student
  using (student_id = app_current_student_id());
create policy complaints_own_insert on complaints for insert to portal_student
  with check (student_id = app_current_student_id());
create policy complaints_own_update on complaints for update to portal_student
  using (student_id = app_current_student_id())
  with check (student_id = app_current_student_id());

grant select, insert on complaint_events to portal_student;
create policy complaint_events_own_select on complaint_events for select to portal_student
  using (visible_to_student and exists (
    select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));
create policy complaint_events_own_insert on complaint_events for insert to portal_student
  with check (actor_type = 'student' and actor_id = app_current_student_id() and exists (
    select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));

-- Only status-level columns of issues the student has reported. No titles, counts,
-- staff assignments, matching attributes or notes.
grant select (id, status, expected_resolution_at, resolved_at, last_activity_at, merged_into_id)
  on consolidated_issues to portal_student;
create policy issues_reported_select on consolidated_issues for select to portal_student
  using (exists (
    select 1 from complaints c where c.consolidated_issue_id = consolidated_issues.id
      and c.student_id = app_current_student_id()));

grant select (id, consolidated_issue_id, update_type, message, visibility, created_at)
  on issue_updates to portal_student;
create policy issue_updates_reported_select on issue_updates for select to portal_student
  using (exists (
    select 1 from complaints c where c.consolidated_issue_id = issue_updates.consolidated_issue_id
      and c.student_id = app_current_student_id()));

-- ---------------------------------------------------------------------------
-- portal_public (ongoing issues page)
-- ---------------------------------------------------------------------------
grant select (id, category_id, status, public_title, public_summary, expected_resolution_at,
              resolved_at, last_activity_at)
  on consolidated_issues to portal_public;
create policy issues_public_select on consolidated_issues for select to portal_public
  using (app_issue_is_public(id));

grant select (id, consolidated_issue_id, update_type, message, visibility, created_at)
  on issue_updates to portal_public;
create policy issue_updates_public_select on issue_updates for select to portal_public
  using (visibility = 'public' and app_issue_is_public(consolidated_issue_id));
