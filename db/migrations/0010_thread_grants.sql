-- The student conversation shows a staff message sent "via this complaint" inside that
-- complaint's thread, so students need to read which complaint a message was about.
-- (Row-level security still limits them to messages addressed to them.)
grant select (target_complaint_id) on student_messages to portal_student;
