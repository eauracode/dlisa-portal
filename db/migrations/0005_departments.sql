-- Department, attached to the username and snapshotted onto each complaint.
-- Ported from the redesign handoff (20261016_add_department.sql) onto the real schema
-- (students, complaints). Additive only. The runner wraps this file in a transaction.

create table if not exists departments (
  code        text primary key,           -- e.g. 'FIN'
  name        text not null unique,       -- e.g. 'Finance'
  active      boolean not null default true,
  sort_order  int not null default 0
);
alter table departments enable row level security;

-- PLACEHOLDER list: replace with DLI's official departments before launch
-- (keep in sync with src/lib/departments.ts).
insert into departments (code, name, sort_order) values
  ('ACC', 'Accounting', 1),
  ('BUS', 'Business Administration', 2),
  ('ECO', 'Economics', 3),
  ('FIN', 'Finance', 4),
  ('LIS', 'Library and Information Science', 5),
  ('ADE', 'Adult Education', 6),
  ('SED', 'Science Education', 7)
on conflict (code) do nothing;

-- Nullable: students who signed up before this change have none yet
-- (they are asked once, the next time they enter their username).
alter table students
  add column if not exists department_code text references departments (code),
  add column if not exists department_set_at timestamptz;

-- Snapshot at submission time so later corrections don't rewrite history.
alter table complaints
  add column if not exists department_code text references departments (code);

update complaints c
   set department_code = s.department_code
  from students s
 where c.student_id = s.id and c.department_code is null and s.department_code is not null;

create index if not exists complaints_department_code_idx on complaints (department_code);

-- The snapshot is taken by the database on every insert, whichever code path (or role) inserts.
create or replace function complaints_snapshot_department() returns trigger
  language plpgsql security definer set search_path = public
  as $$
begin
  if new.department_code is null then
    select department_code into new.department_code from students where id = new.student_id;
  end if;
  return new;
end $$;

drop trigger if exists complaints_snapshot_department on complaints;
create trigger complaints_snapshot_department
  before insert on complaints
  for each row execute function complaints_snapshot_department();
