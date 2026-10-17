-- DLI Student Welfare and Academic Support Portal: core schema.
-- Plain PostgreSQL (13+). Runs unchanged on Supabase Postgres.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table issue_categories (
  id           smallserial primary key,
  slug         text not null unique,
  name         text not null unique,
  description  text not null default '',
  -- Issues in these categories directly affect academic activity (priority signal).
  academic     boolean not null default false,
  sort_order   smallint not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Tunable configuration (matching thresholds, priority weights). JSON values are
-- validated by the application with Zod before use.
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------------------
-- Identities
-- ---------------------------------------------------------------------------

create table students (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null,
  normalized_username  text not null unique,
  pin_hash             text,                      -- scrypt; null once an account is deleted
  account_status       text not null default 'active'
                       check (account_status in ('active', 'suspended', 'deleted')),
  failed_pin_attempts  integer not null default 0,
  locked_until         timestamptz,
  lockout_count        integer not null default 0,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table admin_users (
  id                        uuid primary key default gen_random_uuid(),
  -- Normalised email address used to sign in. Kept generic so an external identity
  -- provider (e.g. Supabase Auth user id) can be substituted later.
  authentication_reference  text not null unique,
  display_name              text not null,
  role                      text not null
                            check (role in ('union_admin', 'case_officer', 'oversight_officer')),
  password_hash             text not null,
  must_change_password      boolean not null default true,
  active                    boolean not null default true,
  failed_login_attempts     integer not null default 0,
  locked_until              timestamptz,
  last_login_at             timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table app_settings
  add constraint app_settings_updated_by_fk foreign key (updated_by) references admin_users (id);

-- One table for both kinds of session; only the SHA-256 of the cookie token is stored.
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  subject_type  text not null check (subject_type in ('student', 'admin')),
  student_id    uuid references students (id) on delete cascade,
  admin_id      uuid references admin_users (id) on delete cascade,
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  check (
    (subject_type = 'student' and student_id is not null and admin_id is null) or
    (subject_type = 'admin'   and admin_id   is not null and student_id is null)
  )
);
create index sessions_student_idx on sessions (student_id);
create index sessions_admin_idx on sessions (admin_id);
create index sessions_expires_idx on sessions (expires_at);

-- Fixed-window rate limit counters. Keys contain HMAC-hashed client identifiers, never raw IPs.
create table rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (bucket, window_start)
);
create index rate_limits_window_idx on rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Consolidated issues
-- ---------------------------------------------------------------------------

create table consolidated_issues (
  id                        uuid primary key default gen_random_uuid(),
  title                     text not null,
  summary                   text not null default '',
  category_id               smallint not null references issue_categories (id),
  status                    text not null default 'new'
                            check (status in ('new', 'under_review', 'in_progress',
                                              'awaiting_external_action', 'resolved', 'closed', 'merged')),
  -- Effective priority = override when present, otherwise computed.
  priority                  text not null default 'normal'
                            check (priority in ('normal', 'elevated', 'high', 'critical')),
  computed_priority         text not null default 'normal'
                            check (computed_priority in ('normal', 'elevated', 'high', 'critical')),
  priority_score            real not null default 0,
  priority_override         text check (priority_override in ('normal', 'elevated', 'high', 'critical')),
  priority_override_reason  text,
  ai_recommended_priority   text check (ai_recommended_priority in ('normal', 'elevated', 'high', 'critical')),
  total_submission_count    integer not null default 0,
  distinct_reporter_count   integer not null default 0,
  assigned_admin_id         uuid references admin_users (id) on delete set null,
  expected_resolution_at    timestamptz,
  proposed_resolution_at    timestamptz,
  public_visibility         boolean not null default false,
  public_title              text,
  public_summary            text,
  -- Structured matching attributes (non-sensitive context extracted from complaints).
  severity                  text not null default 'routine'
                            check (severity in ('routine', 'moderate', 'serious', 'urgent')),
  academic_impact           boolean not null default false,
  safety_flag               boolean not null default false,
  sensitive                 boolean not null default false,
  course_codes              text[] not null default '{}',
  academic_period           text,
  problem_type              text,
  embedding                 real[],
  embedding_model           text,     -- vectors are only compared when produced by the same model
  -- Escalation to school management.
  escalated                 boolean not null default false,
  escalated_at              timestamptz,
  escalation_reason         text,
  escalation_status         text check (escalation_status in ('pending', 'acknowledged', 'responded', 'closed')),
  merged_into_id            uuid references consolidated_issues (id),
  resolution_note           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  last_activity_at          timestamptz not null default now(),
  resolved_at               timestamptz,
  check (not public_visibility or (public_title is not null and public_summary is not null)),
  check (status <> 'merged' or merged_into_id is not null)
);
create index issues_status_idx on consolidated_issues (status);
create index issues_priority_idx on consolidated_issues (priority);
create index issues_category_idx on consolidated_issues (category_id);
create index issues_assigned_idx on consolidated_issues (assigned_admin_id);
create index issues_public_idx on consolidated_issues (public_visibility) where public_visibility;
create index issues_escalated_idx on consolidated_issues (escalated) where escalated;
create index issues_deadline_idx on consolidated_issues (expected_resolution_at)
  where expected_resolution_at is not null;

-- ---------------------------------------------------------------------------
-- Individual complaints
-- ---------------------------------------------------------------------------

create table complaints (
  id                     uuid primary key default gen_random_uuid(),
  student_id             uuid not null references students (id) on delete restrict,
  category_id            smallint not null references issue_categories (id),
  subject                text not null check (char_length(subject) between 5 and 150),
  description            text not null check (char_length(description) between 20 and 4000),
  -- Hash of normalised subject+description; used to reject repeated identical submissions.
  content_fingerprint    text not null,
  consolidated_issue_id  uuid references consolidated_issues (id),
  status                 text not null default 'received'
                         check (status in ('received', 'under_review', 'in_progress',
                                           'awaiting_external_action', 'resolved',
                                           'review_requested', 'closed')),
  match_status           text not null default 'pending'
                         check (match_status in ('pending', 'auto_matched', 'pending_review',
                                                 'new_issue', 'manual', 'failed')),
  review_request_reason  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_viewed_at         timestamptz
);
create index complaints_student_idx on complaints (student_id, created_at desc);
create index complaints_issue_idx on complaints (consolidated_issue_id);
create index complaints_status_idx on complaints (status);
create index complaints_match_status_idx on complaints (match_status);
create index complaints_fingerprint_idx on complaints (student_id, content_fingerprint, created_at desc);

-- Output of AI classification for one complaint. Kept apart from the original text.
create table complaint_analyses (
  complaint_id           uuid primary key references complaints (id) on delete cascade,
  classifier_provider    text not null,
  classifier_model       text not null,
  embedding_provider     text not null,
  embedding_model        text not null,
  inferred_category_id   smallint references issue_categories (id),
  summary_title          text not null,
  summary                text not null,
  course_codes           text[] not null default '{}',
  academic_period        text,
  problem_type           text,
  severity               text not null default 'routine'
                         check (severity in ('routine', 'moderate', 'serious', 'urgent')),
  academic_impact        boolean not null default false,
  safety_flag            boolean not null default false,
  embedding              real[] not null,
  created_at             timestamptz not null default now()
);

-- History of complaint-to-issue links. The live link is complaints.consolidated_issue_id;
-- this table records how and when each link was made and undone.
create table issue_submissions (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  complaint_id           uuid not null references complaints (id) on delete cascade,
  match_method           text not null
                         check (match_method in ('auto', 'review_confirmed', 'new_issue', 'manual',
                                                 'merge', 'split')),
  match_confidence       real,
  model_version          text,
  matched_by             uuid references admin_users (id),
  matched_at             timestamptz not null default now(),
  unlinked_at            timestamptz
);
create unique index issue_submissions_active_uq on issue_submissions (complaint_id) where unlinked_at is null;
create index issue_submissions_issue_idx on issue_submissions (consolidated_issue_id);

-- ---------------------------------------------------------------------------
-- Communications (kept in separate tables by audience)
-- ---------------------------------------------------------------------------

-- Published, student-facing updates on an issue.
--   reporters: visible to students whose complaints are linked to the issue
--   public:    additionally shown on the public ongoing-issues page (if the issue is public)
create table issue_updates (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  author_admin_id        uuid not null references admin_users (id),
  update_type            text not null
                         check (update_type in ('progress', 'status_change', 'deadline', 'resolution',
                                                'institutional_response', 'acknowledgement')),
  message                text not null check (char_length(message) between 1 and 4000),
  visibility             text not null check (visibility in ('reporters', 'public')),
  created_at             timestamptz not null default now()
);
create index issue_updates_issue_idx on issue_updates (consolidated_issue_id, created_at desc);

-- Staff-only notes. Never exposed through any student or public query.
--   internal:  Students' Association staff
--   oversight: restricted school-management notes (union admins + oversight officers)
create table administrative_notes (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  author_admin_id        uuid not null references admin_users (id),
  note                   text not null check (char_length(note) between 1 and 4000),
  visibility             text not null check (visibility in ('internal', 'oversight')),
  created_at             timestamptz not null default now()
);
create index admin_notes_issue_idx on administrative_notes (consolidated_issue_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Workflow and history
-- ---------------------------------------------------------------------------

create table issue_assignments (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  admin_user_id          uuid references admin_users (id),   -- null = unassigned
  assigned_at            timestamptz not null default now(),
  assigned_by            uuid references admin_users (id)
);
create index issue_assignments_issue_idx on issue_assignments (consolidated_issue_id, assigned_at desc);

-- Case officers propose deadlines and escalations; union administrators decide.
create table issue_proposals (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  proposal_type          text not null check (proposal_type in ('deadline', 'escalation')),
  proposed_deadline      timestamptz,
  reason                 text not null check (char_length(reason) between 3 and 1000),
  status                 text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  proposed_by            uuid not null references admin_users (id),
  decided_by             uuid references admin_users (id),
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  check (proposal_type <> 'deadline' or proposed_deadline is not null)
);
create index issue_proposals_pending_idx on issue_proposals (consolidated_issue_id) where status = 'pending';

-- Important issue-level changes (status, priority, deadline, merge, split, visibility...).
create table issue_events (
  id                     uuid primary key default gen_random_uuid(),
  consolidated_issue_id  uuid not null references consolidated_issues (id),
  actor_type             text not null check (actor_type in ('student', 'admin', 'system')),
  actor_id               uuid,
  event_type             text not null,
  previous_value         text,
  new_value              text,
  reason                 text,
  created_at             timestamptz not null default now()
);
create index issue_events_issue_idx on issue_events (consolidated_issue_id, created_at desc);

-- Student-facing history of a single complaint. Rows with visible_to_student = false are
-- internal bookkeeping (e.g. re-grouping by staff) and are filtered out by RLS.
create table complaint_events (
  id                  uuid primary key default gen_random_uuid(),
  complaint_id        uuid not null references complaints (id) on delete cascade,
  actor_type          text not null check (actor_type in ('student', 'admin', 'system')),
  actor_id            uuid,
  event_type          text not null,
  previous_value      text,
  new_value           text,
  message             text,
  visible_to_student  boolean not null default true,
  created_at          timestamptz not null default now()
);
create index complaint_events_complaint_idx on complaint_events (complaint_id, created_at);

create table ai_match_reviews (
  id                  uuid primary key default gen_random_uuid(),
  complaint_id        uuid not null references complaints (id) on delete cascade,
  candidate_issue_id  uuid not null references consolidated_issues (id),
  confidence_score    real not null,
  explanation         text not null,
  -- 'possible_duplicate' or 'possible_recurrence' (candidate issue already resolved).
  review_kind         text not null default 'possible_duplicate'
                      check (review_kind in ('possible_duplicate', 'possible_recurrence')),
  model_version       text not null,
  review_status       text not null default 'pending'
                      check (review_status in ('pending', 'confirmed', 'rejected', 'reassigned', 'superseded')),
  reviewed_by         uuid references admin_users (id),
  reviewed_at         timestamptz,
  decision_reason     text,
  created_at          timestamptz not null default now()
);
create index ai_match_reviews_pending_idx on ai_match_reviews (created_at) where review_status = 'pending';
create index ai_match_reviews_complaint_idx on ai_match_reviews (complaint_id);

-- Background matching work. One row per complaint (unique) prevents duplicate jobs.
create table match_jobs (
  id               uuid primary key default gen_random_uuid(),
  complaint_id     uuid not null unique references complaints (id) on delete cascade,
  status           text not null default 'pending'
                   check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  attempts         integer not null default 0,
  last_error       text,          -- error class/message only, never complaint content
  next_attempt_at  timestamptz not null default now(),
  locked_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index match_jobs_due_idx on match_jobs (next_attempt_at) where status in ('pending', 'processing');

create table audit_logs (
  id           bigserial primary key,
  actor_type   text not null check (actor_type in ('student', 'admin', 'system')),
  actor_id     uuid,
  action       text not null,
  entity_type  text,
  entity_id    text,
  metadata     jsonb not null default '{}'::jsonb,   -- never PINs, tokens or complaint text
  created_at   timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Defaults
-- ---------------------------------------------------------------------------

insert into issue_categories (slug, name, description, academic, sort_order) values
  ('academic',        'Academic Issues',                         'Courses, lecturers, registration and academic advising.', true, 10),
  ('exams-results',   'Examination and Results',                 'Examination schedules, conduct, results and grades.',      true, 20),
  ('timetable',       'Timetable and Lectures',                  'Lecture schedules, clashes and online classes.',           true, 30),
  ('materials',       'Course Materials and Learning Resources', 'Course materials, LMS access and learning resources.',      true, 40),
  ('welfare',         'Student Welfare',                         'Wellbeing, safety, health and personal welfare concerns.', false, 50),
  ('admin-services',  'Administrative Services',                 'Fees, documents, ID cards and administrative processes.',  false, 60),
  ('communication',   'Communication and Announcements',         'Announcements, notices and information flow.',             false, 70),
  ('facilities',      'Facilities and Learning Support',         'Study centres, internet access and learning support.',     false, 80),
  ('general-feedback','General Feedback',                        'General comments about the DLI experience.',               false, 90),
  ('suggestions',     'Suggestions',                             'Ideas to improve services.',                               false, 100),
  ('other',           'Other',                                   'Anything that does not fit another category.',             false, 110);
