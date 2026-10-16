-- Instant answers: staff messages become a reusable answer library, so a student who asks
-- something the Student Union has already answered gets that answer straight away.
-- Additive only.

-- Whether a message may be shown to other students who ask the same thing. Memos and replies
-- to a grouped issue are general by nature; a direct reply may contain personal details, so
-- it is reused only when staff opt in.
alter table student_messages
  add column if not exists reusable         boolean not null default false,
  add column if not exists embedding        real[],
  add column if not exists embedding_model  text,
  add column if not exists course_codes     text[] not null default '{}';

update student_messages set reusable = true where audience in ('issue', 'broadcast');

-- Which earlier answer was delivered for which submission, and whether it helped.
create table if not exists instant_answers (
  complaint_id  uuid not null references complaints (id) on delete cascade,
  message_id    uuid not null references student_messages (id) on delete cascade,
  -- similar: matched by meaning; same_issue: the submission joined an issue that had replies
  source        text not null check (source in ('similar', 'same_issue')),
  similarity    real,
  helpful       boolean,
  feedback_at   timestamptz,
  created_at    timestamptz not null default now(),
  primary key (complaint_id, message_id)
);
create index if not exists instant_answers_message_idx on instant_answers (message_id);

alter table instant_answers enable row level security;

-- Students: answers delivered for their own submissions; they may only record feedback.
grant select (complaint_id, message_id, source, helpful, created_at) on instant_answers to portal_student;
grant update (helpful, feedback_at) on instant_answers to portal_student;
create policy instant_answers_own_select on instant_answers for select to portal_student
  using (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));
create policy instant_answers_own_update on instant_answers for update to portal_student
  using (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()))
  with check (exists (select 1 from complaints c where c.id = complaint_id and c.student_id = app_current_student_id()));
