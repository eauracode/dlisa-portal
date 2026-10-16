-- Official DLI department list (replaces the placeholder list from 0005).
-- Codes ACC, BUS, FIN and ECO are kept so existing records stay valid. Placeholder
-- departments that are not on the official list are deactivated, not deleted, because
-- complaints and students may reference them.

insert into departments (code, name, sort_order, active) values
  ('ACC', 'Accounting', 1, true),
  ('BUS', 'Business Administration', 2, true),
  ('FIN', 'Finance', 3, true),
  ('ECO', 'Economics', 4, true),
  ('PAD', 'Public Administration', 5, true),
  ('EBI', '(Ed.) Biology', 6, true),
  ('ECH', '(Ed.) Chemistry', 7, true),
  ('EPH', '(Ed.) Physics', 8, true),
  ('EMA', '(Ed.) Mathematics', 9, true),
  ('EEC', '(Ed.) Economics', 10, true),
  ('ECE', 'Early Childhood Education', 11, true),
  ('EDM', 'Educational Management', 12, true),
  ('GCO', 'Guidance and Counselling', 13, true),
  ('BED', 'Business Education', 14, true),
  ('EEN', '(Ed.) English', 15, true)
on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order, active = true;

update departments set active = false where code not in
  ('ACC','BUS','FIN','ECO','PAD','EBI','ECH','EPH','EMA','EEC','ECE','EDM','GCO','BED','EEN');
