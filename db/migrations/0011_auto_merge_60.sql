-- Automatic grouping at 60% similarity (review from 45%). Saved settings from the old defaults
-- (0.9 / 0.7) are moved to the new ones; any other custom values are kept.
update app_settings
   set value = value || '{"autoThreshold": 0.6, "reviewThreshold": 0.45}'::jsonb, updated_at = now()
 where key = 'matching'
   and (value->>'autoThreshold')::numeric >= 0.9 and (value->>'reviewThreshold')::numeric >= 0.7;
