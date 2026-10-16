-- Chat-first update: a two-way conversation on each complaint, memos as a notice board, and
-- bulk messages to a department or to students with an open complaint. Additive only.

-- 1) Complaint conversation --------------------------------------------------
-- One row per chat message between the complaint's owner and Union staff. Updates, status
-- changes, official responses and staff messages to an issue stay in their own tables; the
-- student thread merges them at read time (src/lib/services/student-thread.ts).
create table if not exists complaint_messages (
  id                  uuid primary key default gen_random_uuid(),
  complaint_id        uuid not null references complaints (id) on delete cascade,
  sender_type         text not null check (sender_type in ('student', 'staff')),
  author_admin_id     uuid references admin_users (id),
  body                text not null check (char_length(body) between 1 and 2000),
  is_review_request   boolean not null default false,
  created_at          timestamptz not null default now(),
  read_by_student_at  timestamptz,
  read_by_staff_at    timestamptz,
  check ((sender_type = 'staff') = (author_admin_id is not null))
);
create index if not exists complaint_messages_complaint_idx on complaint_messages (complaint_id, created_at);
create index if not exists complaint_messages_unread_staff_idx on complaint_messages (created_at)
  where sender_type = 'student' and read_by_staff_at is null;

alter table complaint_messages enable row level security;

-- Students: their own complaints only. They never see which staff member replied.
grant select (id, complaint_id, sender_type, body, is_review_request, created_at, read_by_student_at, read_by_staff_at)
  on complaint_messages to portal_student;
grant insert (complaint_id, sender_type, body, is_review_request) on complaint_messages to portal_student;
grant update (read_by_student_at) on complaint_messages to portal_student;
create policy complaint_messages_own_select on complaint_messages for select to portal_student
  using (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));
create policy complaint_messages_own_insert on complaint_messages for insert to portal_student
  with check (sender_type = 'student' and exists (
    select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));
create policy complaint_messages_own_update on complaint_messages for update to portal_student
  using (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()))
  with check (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));

-- 2) Memos ---------------------------------------------------------------------
-- A memo is a message to all students (audience 'broadcast'). It is now also a notice board:
-- every active student can read published memos, including ones sent before they joined.
-- Drafts and archived memos are visible to staff only.
alter table student_messages
  add column if not exists pinned        boolean not null default false,
  add column if not exists public        boolean not null default false,
  add column if not exists memo_status   text not null default 'published'
                                         check (memo_status in ('draft', 'published', 'archived')),
  add column if not exists updated_at    timestamptz not null default now();

-- Bulk messages to a slice of students (land in Messages, not in any one complaint).
alter table student_messages drop constraint if exists student_messages_audience_check;
alter table student_messages add constraint student_messages_audience_check
  check (audience in ('issue', 'direct', 'broadcast', 'department', 'open_complaints'));
alter table student_messages add column if not exists target_department text references departments (code);
alter table student_messages add constraint student_messages_department_target
  check (audience <> 'department' or target_department is not null);

-- Students: published memos, whether or not they were a recipient at send time.
grant select (pinned, memo_status) on student_messages to portal_student;
create policy student_messages_memos on student_messages for select to portal_student
  using (audience = 'broadcast' and memo_status = 'published');
-- Opening the Memos page records a read for memos sent before the student joined.
grant insert (message_id, student_id, read_at) on student_message_recipients to portal_student;
create policy message_recipients_memo_insert on student_message_recipients for insert to portal_student
  with check (student_id = app_current_student_id() and exists (
    select 1 from student_messages m where m.id = message_id and m.audience = 'broadcast' and m.memo_status = 'published'));

-- Signed-out visitors: published memos marked public.
grant select (id, subject, body, pinned, created_at) on student_messages to portal_public;
create policy student_messages_public_memos on student_messages for select to portal_public
  using (audience = 'broadcast' and memo_status = 'published' and public);
