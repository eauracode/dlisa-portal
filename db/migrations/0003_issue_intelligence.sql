-- AI Issue Intelligence Engine. Additive only: new nullable/defaulted columns and one new
-- table. No existing data is modified or removed.

-- Richer structured representation of each complaint. NULL means "not stated / unknown".
alter table complaint_analyses
  add column if not exists underlying_problem  text,
  add column if not exists problem_aspect      text,   -- missing | incorrect | delayed | inaccessible | ...
  add column if not exists academic_activity   text,   -- examination | lecture | timetable | results | ...
  add column if not exists time_reference      text,   -- e.g. "next week", "since Monday"
  add column if not exists affected_group      text,   -- programme / level / centre, when identifiable
  add column if not exists sensitivity         text not null default 'none'
                                               check (sensitivity in ('none', 'sensitive', 'highly_sensitive')),
  add column if not exists urgency_indicators  text[] not null default '{}';

-- Matching attributes kept on the issue so later complaints can be compared against them.
alter table consolidated_issues
  add column if not exists problem_aspect      text,
  add column if not exists academic_activity   text,
  add column if not exists affected_group      text,
  add column if not exists last_report_at      timestamptz;

update consolidated_issues i
   set last_report_at = (select max(c.created_at) from complaints c where c.consolidated_issue_id = i.id)
 where last_report_at is null;

-- Provenance of every automated matching decision: what was compared, the score, the
-- verifier's opinion and why. Contains identifiers and attributes only, never complaint text.
create table if not exists match_decisions (
  id                   uuid primary key default gen_random_uuid(),
  complaint_id         uuid not null references complaints (id) on delete cascade,
  candidate_issue_id   uuid references consolidated_issues (id),
  decision             text not null check (decision in ('auto', 'review', 'new')),
  similarity           real,
  confidence           real,
  verifier_verdict     text check (verifier_verdict in ('same', 'different', 'uncertain')),
  explanation          text not null,
  compatible           text[] not null default '{}',
  conflicts            text[] not null default '{}',
  alternatives         jsonb not null default '[]'::jsonb,
  model_version        text not null,
  algorithm_version    text not null,
  created_at           timestamptz not null default now()
);
create index if not exists match_decisions_complaint_idx on match_decisions (complaint_id, created_at desc);
create index if not exists match_decisions_created_idx on match_decisions (created_at desc);
alter table match_decisions enable row level security;

create index if not exists complaints_created_idx on complaints (created_at desc);
create index if not exists issues_last_report_idx on consolidated_issues (last_report_at desc);

-- Why a case was sent to human review (uncertain, ambiguous, incompatible, sensitive, recurrence, verifier).
alter table ai_match_reviews add column if not exists review_reason text;
