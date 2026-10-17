-- Frequently asked questions: staff-written question/answer pairs in the instant-answer library.
-- Stored as student messages with audience 'faq' (subject = question, body = answer) so they are
-- matched, delivered and rated exactly like every other saved answer. A FAQ reaches a student
-- only when it answers their submission; memo_status 'published' / 'archived' switches it on/off.
alter table student_messages drop constraint if exists student_messages_audience_check;
alter table student_messages add constraint student_messages_audience_check
  check (audience in ('issue', 'direct', 'broadcast', 'department', 'open_complaints', 'faq'));
