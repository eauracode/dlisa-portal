-- Staff-to-student messaging: replies to everyone who reported a grouped issue, direct
-- messages to one student, and memos to all students. Additive only.

create table if not exists student_messages (
  id                   uuid primary key default gen_random_uuid(),
  -- issue: all reporters of a consolidated issue; direct: one student; broadcast: all students
  audience             text not null check (audience in ('issue', 'direct', 'broadcast')),
  subject              text not null check (char_length(subject) between 3 and 150),
  body                 text not null check (char_length(body) between 5 and 4000),
  author_admin_id      uuid not null references admin_users (id),
  target_issue_id      uuid references consolidated_issues (id),
  target_student_id    uuid references students (id),
  -- Set when a direct message was addressed via a complaint ("message this reporter"), so
  -- staff who only see pseudonymous reporter codes never need the username.
  target_complaint_id  uuid references complaints (id),
  recipient_count      integer not null default 0,
  created_at           timestamptz not null default now(),
  check (audience <> 'issue' or target_issue_id is not null),
  check (audience <> 'direct' or target_student_id is not null)
);
create index if not exists student_messages_created_idx on student_messages (created_at desc);
create index if not exists student_messages_author_idx on student_messages (author_admin_id, created_at desc);

-- Recipients are fixed when the message is sent (a snapshot of the audience at that time).
create table if not exists student_message_recipients (
  message_id  uuid not null references student_messages (id) on delete cascade,
  student_id  uuid not null references students (id) on delete cascade,
  read_at     timestamptz,
  primary key (message_id, student_id)
);
create index if not exists student_message_recipients_student_idx on student_message_recipients (student_id, read_at);

alter table student_messages enable row level security;
alter table student_message_recipients enable row level security;

-- Students: only messages addressed to them; never the author or other recipients.
grant select (id, audience, subject, body, target_issue_id, created_at) on student_messages to portal_student;
create policy student_messages_own on student_messages for select to portal_student
  using (exists (select 1 from student_message_recipients r
                  where r.message_id = student_messages.id and r.student_id = app_current_student_id()));

grant select (message_id, student_id, read_at) on student_message_recipients to portal_student;
grant update (read_at) on student_message_recipients to portal_student;
create policy message_recipients_own_select on student_message_recipients for select to portal_student
  using (student_id = app_current_student_id());
create policy message_recipients_own_update on student_message_recipients for update to portal_student
  using (student_id = app_current_student_id())
  with check (student_id = app_current_student_id());
