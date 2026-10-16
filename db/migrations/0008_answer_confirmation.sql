-- A student who confirms an instant answer solved their question closes their own
-- submission. Recorded separately so later staff status changes on the issue do not reopen
-- it; a review request from the student clears it. Written by the application only.
alter table complaints add column if not exists resolved_by_student_at timestamptz;
