-- Submissions that staff already replied to (in the chat, or by messaging the student or their
-- issue) but still show Received move to In progress, matching the new automatic rule.
with started as (
  select c.id, c.status from complaints c
   where c.status in ('received', 'under_review')
     and (exists (select 1 from complaint_messages m where m.complaint_id = c.id and m.sender_type = 'staff')
          or exists (select 1 from student_messages sm
                      where (sm.target_complaint_id = c.id)
                         or (sm.audience = 'issue' and sm.target_issue_id = c.consolidated_issue_id and sm.created_at > c.created_at)))
)
, moved as (
  update complaints c set status = 'in_progress', updated_at = now()
    from started s where c.id = s.id
  returning c.id, s.status as previous
)
insert into complaint_events (complaint_id, actor_type, event_type, previous_value, new_value, message)
select id, 'system', 'status_changed', previous, 'in_progress', 'The Students'' Association is working on this.' from moved;
