# DLI Student Welfare and Academic Support Portal

A full-stack platform for the Distance Learning Institute (DLI), University of Lagos. Students submit academic concerns, welfare complaints, suggestions and feedback using only a self-chosen **username** (no password, PIN or personal details). The DLI Student Union executive manages, groups and resolves them under school-management oversight.

- **Students:** submit complaints, follow progress privately, see published responses and confirmed resolution dates, and request a review if a "resolved" problem persists.
- **Staff:** consolidate duplicate reports into issues, prioritise, assign, set deadlines, publish updates, escalate to school management, and audit everything.
- **AI-assisted consolidation:** a pluggable provider classifies each complaint and compares it with existing issues. High-confidence matches are grouped automatically, uncertain ones go to a review queue, and the rest become new issues.

---

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js 16 (App Router, Server Components, Server Actions), React 19, TypeScript |
| UI | Tailwind CSS v4 and shadcn/ui-style components (`src/components/ui`), system fonts, mobile-first |
| Database | PostgreSQL 13+ via `pg`, plain SQL migrations (run unchanged on **Supabase**) |
| Validation | Zod, shared by client and server |
| Auth | Username-only for students (unique, case-insensitive) and email + password for staff (scrypt). Server-side sessions in httpOnly cookies |
| AI | Pluggable: `local` (offline), OpenAI-compatible API, Anthropic (`@anthropic-ai/sdk`) |
| Tests | Vitest: unit tests plus integration tests against a real PostgreSQL test database |

---

## Quick start (local development)

**Prerequisites:** Node.js 20.9+ and PostgreSQL 13+ binaries.

```bash
npm install

# 1. Database. Either point DATABASE_URL at any PostgreSQL you have, or start the bundled
#    self-contained dev cluster (./.pgdata, port 5433, no password needed):
npm run local-db:start          # set PG_BIN if PostgreSQL's bin folder is not the Windows default

# 2. Environment
cp .env.example .env.local      # then edit; for the local cluster use:
#   DATABASE_URL=postgres://dli@localhost:5433/dli_portal
#   APP_SECRET=<random 32+ chars>   CRON_SECRET=<random 16+ chars>   TRUSTED_PROXY_COUNT=0

# 3. Schema and demo data
npm run db:migrate
npm run db:seed                 # prints demo staff passwords and demo student usernames

# 4. Run
npm run dev                     # http://localhost:3000
npm run worker                  # separate terminal: matching retries and maintenance
```

Demo logins come from `npm run db:seed`. Students sign in at `/student/access` with just a username (for example `quiet_owl`). Staff sign in at `/admin/login` with the three printed accounts: Union Administrator, Case Officer and Oversight Officer. Seed passwords are random on every run, and the seed refuses to run in production or on a database that already contains students.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run db:migrate` | Apply pending SQL migrations in `db/migrations` (tracked in `schema_migrations`) |
| `npm run db:reset` | **Dev only.** Drop and recreate the schema, then migrate |
| `npm run db:seed` | Load realistic demo data (local only) |
| `npm run admin:create -- --email x@y --name "Name" --role union_admin` | Provision a staff account (password from `ADMIN_PASSWORD` or a prompt) |
| `npm run worker` / `npm run worker:once` | Matching retries, missing-job recovery, priority recalculation, pruning |
| `npm test` | Unit and integration tests (resets the `dli_portal_test` database) |
| `npm run ai:eval` | Measure grouping accuracy and false merges on the labelled dataset |
| `npm run ai:reindex` | Re-analyse existing complaints after changing AI providers or models |
| `npm run typecheck` / `npm run lint` / `npm run build` | Static checks and production build |

---

## Testing

```bash
npm run local-db:start   # or provide your own test database in .env.test
npm test
```

`.env.test` points at a separate, disposable `dli_portal_test` database. The global setup refuses to reset any database whose URL does not contain "test". There are 58 tests:

| Required scenario | Where |
| --- | --- |
| 1–2 Create a username (unique, "already picked" check); return later with it and see previous complaints | `tests/integration/student-access.test.ts` |
| 3–4 Cross-student isolation, including URL tampering and direct SQL under RLS | `student-access.test.ts` → "cross-student data isolation" |
| 5, 8, 20 Submit; low-confidence match creates a new issue; no tracking ID needed | `tests/integration/consolidation.test.ts` |
| 6 High-confidence duplicate grouped with the correct issue | `consolidation.test.ts` |
| 7 Uncertain match goes to the review queue; admin confirms or rejects | `consolidation.test.ts` |
| 9–10 Repeat submissions don't inflate distinct reporters; distinct students do | `consolidation.test.ts` |
| 11–12 Published updates reach all reporters; internal and oversight notes stay private | `tests/integration/admin-workflows.test.ts` |
| 13–14 Set and revise deadlines (reason required); overdue issues surface | `admin-workflows.test.ts` |
| 15 AI failure never loses a complaint; retry; no duplicate job processing | `consolidation.test.ts` |
| 16 Admin corrects a wrong match; history preserved; nothing deleted | `consolidation.test.ts` |
| 17 Review request on a resolved complaint, then reopen | `admin-workflows.test.ts` |
| 18 Oversight officer: escalated issues only, no union-admin powers | `admin-workflows.test.ts` |
| 19 Complaint spam and duplicate rate limiting | `consolidation.test.ts` |
| Matching rules (different course or period never auto-grouped, ambiguity, recurrence) | `tests/unit/matching-engine.test.ts` |
| Priority engine (severity over volume, safety floor) | `tests/unit/priority.test.ts` |
| Validation, redaction, extraction, local provider | `tests/unit/validation-and-ai.test.ts` |

The AI is replaced in tests by a deterministic fake (`tests/support/fake-ai.ts`), so similarity values are exact.

---

## Architecture

```
src/
  app/
    (public)/            landing, /issues (public summaries), /privacy
    student/             access, dashboard, complaints/new, complaints/[id], account + actions.ts
    admin/               login, account, (console)/ overview, issues, complaints, match-review,
                         reports, users, settings, audit + actions.ts
    api/jobs/process     cron-authenticated maintenance endpoint
  config/app.ts          branding (name, logo, timezone) and student-facing copy
  lib/
    db.ts                pool, transactions, withStudentContext / withPublicContext (RLS roles)
    auth/                sessions, student and admin auth, permissions (role → permission map)
    security/            scrypt hashing, tokens, DB-backed rate limiting
    ai/                  provider interface, local/openai/anthropic providers, redaction, extraction
    matching/            engine.ts (pure decision rules), jobs.ts (queue), maintenance.ts
    priority/engine.ts   pure, configurable priority scoring
    services/            student complaints, consolidation, public issues, settings, admin/*
db/migrations/           0001 core schema, 0002 row-level security
scripts/                 migrate, seed, create-admin, worker, local-db
tests/                   unit/, integration/, support/
```

### Key flows

**Submission:** validate → rate-limit (per student and per client) → reject identical repeats (7 days) → insert complaint and acknowledgement event **as the student role** → enqueue a matching job → try matching inline → redirect to the complaint page. If matching fails, the complaint is already stored and the job retries with back-off (1, 5, 15, 60, 180, 720 minutes). After 6 attempts it shows on the admin dashboard as "needs manual grouping". The maintenance pass also re-creates any missing job.

**Matching** (`lib/matching/engine.ts`):

- **Score:** cosine similarity of embeddings, adjusted by structured signals: category, problem type, and shared course codes.
- **Compatibility:** a candidate with a different course, a different academic period, or a different specific problem type is never grouped automatically.
- **Decision:**

  | Score | Outcome |
  | --- | --- |
  | ≥ 0.90, compatible, and clearly ahead of any runner-up | Automatic grouping |
  | 0.70 – 0.90, ambiguous, or incompatible | Review queue |
  | Strong match to a resolved issue | Review as a "possible recurrence" (reopen and attach, or create a new related issue) |
  | < 0.70 | New issue |

- **Concurrency:** decisions are serialised with a transaction-scoped advisory lock, jobs are claimed atomically, and counts are always recomputed from source rows.

All thresholds are editable in **Admin → Settings**. They are tuning values for the configured embedding model, not probabilities.

**Priority** (`lib/priority/engine.ts`): severity (0–45 points) + distinct reporters (log-scaled, capped at 30) + repeats from the same student (capped at 5) + 24-hour growth + days unresolved + overdue deadline + academic impact. Thresholds give Normal, Elevated, High or Critical. Safety and welfare flags force at least High, or Critical if urgent. Union administrators can override with a recorded reason, and AI only recommends.

### Roles

| Permission | Union Administrator | Case Officer | Oversight Officer |
| --- | :-: | :-: | :-: |
| Which issues | all | assigned only | escalated only |
| Staff accounts, settings, categories, audit log | ✓ | | |
| Assign, set deadlines, priority override, merge/split, public visibility, escalate | ✓ | | |
| Match review queue, regroup complaints | ✓ | | |
| Change status, reopen, publish updates, internal notes, handle review requests | ✓ | ✓ | |
| Propose deadlines and escalations | | ✓ | |
| Restricted oversight notes, institutional responses, escalation status | ✓ | | ✓ |
| Reports | ✓ | | ✓ (escalated scope) |

These are enforced in the services (`loadIssueForAdmin`, `assertCan`), not only in the UI. Staff see students as pseudonymous **reporter codes** (HMAC of the student ID), never usernames.

---

## AI Issue Intelligence Engine

Every complaint is read the moment it is submitted, and similar reports are grouped by **meaning**, not keywords.

```
Student submits ─► complaint saved (always) ─► job queued ─► response returned immediately
                                                   │
                          after() runs right after the response (worker/cron retries failures)
                                                   ▼
  classify (structured representation) ─► embed (semantic vector) ─► find similar open/recent issues
  ─► score + compatibility checks ─► verify proposed match ─► group │ review queue │ new issue
  ─► update counts, distinct reporters, priority ─► record provenance ─► dashboards refresh
```

| Interface | Implementations | File |
| --- | --- | --- |
| `ComplaintClassifier` | `local` (rules), `anthropic` (Claude, structured outputs), `openai` (any OpenAI-compatible API) | `src/lib/ai/providers/*` |
| `EmbeddingProvider` | **`transformers`** (local semantic model), `openai`, `local` (lexical fallback) | `src/lib/ai/providers/*` |
| `IssueSimilarityMatcher` | `local` (attribute rules), `anthropic`, `openai` LLM verifiers | `src/lib/ai/verifier.ts` |
| Consolidation | `linkComplaintToIssue`, `refreshIssueAggregates`, merge/split | `src/lib/services/consolidation.ts` |
| Priority | `computePriority`, `recalculatePriority` | `src/lib/priority/engine.ts` |
| Decision engine | `decideMatch`, `applyVerification` (pure, unit-tested) | `src/lib/matching/engine.ts` |
| Pipeline / queue | `processMatchJob`, retries, maintenance | `src/lib/matching/jobs.ts` |

**Structured representation** (stored in `complaint_analyses`): summary, category, underlying problem, problem type, **problem aspect** (missing / incorrect / delayed / inaccessible / conflict / …), academic activity, course codes, academic period, time reference, affected group, severity, urgency indicators and sensitivity. Anything not stated is stored as `NULL` (unknown) and never guessed. The original complaint text is kept unchanged for authorised staff.

**Matching rules:**

- **Compatibility:** a different course, period, study centre or group, problem aspect (e.g. timetable *missing* vs. timetable *incorrect*), or an unrelated activity blocks automatic grouping.
- **Ambiguity:** two plausible issues send the case to review.
- **Sensitivity:** sensitive welfare cases are **never** merged automatically. They go to the restricted review queue, are marked sensitive, and can never be made public.
- **Verification:** the verifier can only make a decision more cautious, never less.
- **Provenance:** every decision is recorded in `match_decisions` with the score, decision, explanation, compatible and conflicting attributes, alternatives, model versions and `MATCH_ALGORITHM_VERSION`. Complaint text is never stored there.

Thresholds are editable in **Admin → Settings** (defaults: 0.90 auto, 0.70 review). Raw cosine scores differ between embedding models, so `SIMILARITY_CALIBRATION` in `engine.ts` maps each model's range onto 0–1. Re-check it with `npm run ai:eval` after changing models.

**Real-time views:**

- **Admin → Live monitor:** new complaints, new issues, issues receiving matching reports, surges (3+ reports in 24 hours), uncertain matches, priority increases, processing failures and retries, and issues needing intervention.
- **Overview, Issues and Match review** poll `/api/admin/activity-version` (staff-only; it returns an opaque hash) and re-render in place when processing completes.
- **Students** see their complaint page update from "checking…" to a status-based message built only from verified database values: the current issue status and the confirmed deadline.

### Evaluation (measure before enabling in production)

`tests/eval/dli-complaints.json` holds 30 labelled DLI complaints in 13 groups, including hard negatives (missing vs. wrong result, different course, different study centre, sensitive cases).

```bash
npm run ai:eval -- --verbose   # uses the configured providers and thresholds
```

Measured result with `AI_EMBEDDING_PROVIDER=transformers` (all-MiniLM-L6-v2), the local classifier and the local verifier:

| Metric | Result |
| --- | --- |
| Handled correctly without human help | 24 of 30 (80%) |
| False merges | **0** (0 hard-negative merges) |
| Automatic-grouping precision | 100% |
| Sent to human review | 5 |
| Missed matches | 1 |

Grouped automatically include "Our exam timetable is not out" with "We haven't received the schedule for our examinations". The missed match was "can't log in to the e-learning portal", at similarity 0.69, just under the review threshold. An admin can merge it. The suite `tests/integration/evaluation.test.ts` re-runs this with the real model and fails on any false merge.

### Setup

```bash
# .env.local
AI_EMBEDDING_PROVIDER=transformers      # downloads ~23 MB model once into ./.models
AI_CLASSIFIER_PROVIDER=local            # or anthropic / openai (keys below)
# AI_VERIFIER_PROVIDER=anthropic        # optional LLM second opinion; defaults to the classifier provider
# ANTHROPIC_API_KEY=...   ANTHROPIC_MODEL=claude-opus-5
# OPENAI_API_KEY=...      OPENAI_BASE_URL=...  OPENAI_CHAT_MODEL=...  OPENAI_EMBEDDING_MODEL=...

npm run db:migrate        # applies 0003_issue_intelligence.sql (additive only)
npm run ai:reindex        # re-analyse existing complaints with the configured model (non-destructive)
npm run ai:eval           # check grouping quality and false merges
npm run dev & npm run worker
```

- **Offline or air-gapped servers:** copy the `./.models` folder from a machine that has downloaded the model.
- **Privacy with external providers:** only redacted text is sent for classification, and only the two structured summaries (no raw text) for verification. No usernames, session data or credentials are ever included.

**Not yet verified live:** the Anthropic and OpenAI classifier and verifier integrations are implemented with schema validation and error handling, but were not exercised against the live services because no API keys were available. Set a key, then run `npm run ai:eval` to measure them before relying on them. **pgvector** isn't used: similarity is computed in the application over open and recently resolved issues, which is fast for thousands of issues. For much larger volumes, enable pgvector on Supabase and move candidate search into an indexed query.


---

## Messages to students

Staff send messages from **Admin → Messages**, and students read them in their private **Messages** inbox. The inbox shows an unread badge in the header and a notice on the dashboard.

| Audience | How to send | Who can send |
| --- | --- | --- |
| Everyone who reported a grouped issue | Messages → "Reporters of a grouped issue", or **"Message all reporters"** on an issue page | Union Administrator; Case Officer (assigned issues only) |
| One student by username | Messages → "A specific username" (case-insensitive) | Union Administrator |
| The author of one complaint | **"Message this reporter"** on a submission page. The username is never shown to staff. | Union Administrator; Case Officer (assigned issues only) |
| All students (memo) | Messages → "All students", with a confirmation tick | Union Administrator |

- **Recipients are fixed at send time:** only active student accounts receive a message, and a student who reported an issue several times gets it once.
- **Students see "DLI Student Union" as the sender,** never the staff member's name or the other recipients. Database row-level security guarantees a student can only read messages addressed to them.
- **The history shows delivery and read counts.** Union Administrators see every message; Case Officers see the messages they sent.
- **The audit log records every send** (audience, recipient count), never the message text.
- **Database:** `db/migrations/0004_student_messages.sql`, which only adds tables.

---

## Security and privacy

- **Username-only student access (deliberate product decision):** students choose a username, which is unique after normalisation (case-insensitive, enforced by a unique index). The form checks availability while they type and says when a name "has already been picked". There is no password or PIN, so **anyone who knows a username can view that student's complaints**. Students are told to pick a name others won't guess. Sessions last 30 days on the student's device, so returning is usually automatic. Registration, sign-in and availability checks are rate-limited per client.
- **Signing up while complaining:** `/student/complaints/new` is open to signed-out students, who pick (or enter) their username in the same form. The complaint is validated before any account is created.
- **Staff sessions:** 256-bit random tokens, stored only as SHA-256. Cookies are httpOnly, `SameSite=Lax`, `Secure`, and use the `__Host-` prefix in production. Staff sessions last 8 hours (1-hour idle timeout). Staff passwords are scrypt-hashed, with lockout after 5 failures. Changing a password rotates the session, and deactivating an account signs it out.
- **Authorisation:** every page and action checks the session on the server. Student queries run as the restricted `portal_student` PostgreSQL role with row-level security bound to that student, plus column grants that exclude staff fields. A coding bug cannot expose another student's rows or any staff note; the tests verify this. The public page runs as `portal_public`. RLS is enabled on every table, deny by default.
- **Request safety:** CSRF is covered by Next's Server Action origin check plus `SameSite` cookies. All SQL is parameterised. React escapes all output (no `dangerouslySetInnerHTML`). Inputs are Zod-validated and stripped of control or bidi characters. A strict Content-Security-Policy and frame and referrer headers are set in `next.config.ts`.
- **Logs and errors:** audit logs and job errors never contain PINs, passwords, tokens or complaint text. Client IPs are only stored HMAC-hashed and pruned within about 2 days. Errors shown to users are generic.
- **Sensitive welfare issues:** safety-flagged issues are marked sensitive, can never be made public, and default to at least High priority.
- **Retention:** expired sessions and rate-limit windows are pruned automatically. Complaints are kept; categories are deactivated, never deleted.

### AI configuration and privacy

| Setting | Effect |
| --- | --- |
| `AI_CLASSIFIER_PROVIDER=local`, `AI_EMBEDDING_PROVIDER=local` (default) | No text leaves the server. Matching is **lexical** (hashed word n-grams with synonym folding): reports that share wording group reliably, but true paraphrases with different words score lower and become separate issues for manual merging. |
| `AI_EMBEDDING_PROVIDER=openai` with `OPENAI_*` | Semantic embeddings. `OPENAI_BASE_URL` can point at a **self-hosted** Ollama or vLLM server to keep data on university infrastructure. |
| `AI_CLASSIFIER_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` | Claude classifies with schema-validated structured output (`ANTHROPIC_MODEL`, default `claude-opus-5`). A refusal or invalid request falls back to the local classifier; transient errors retry. |

Before any external call, emails, phone numbers, long digit runs (such as matriculation numbers), links and "my name is …" phrases are redacted (`lib/ai/redact.ts`). This is best-effort, so tell students not to include identifiers. Check the provider's data-retention and training terms before enabling it, and record the choice in the privacy notice (`/privacy`).

**Switching embedding models:** vectors are only compared when produced by the same model (`embedding_model`). After switching, existing issues stop being automatic candidates until they receive new reports or are merged manually. Re-tune the thresholds after switching.

---

## Deployment

### Vercel + Neon (recommended)

1. **Database:** in the Vercel project, Storage → Create Database → **Neon**, region **London** (`aws-eu-west-2`) to sit next to the app's `lhr1` region (set in `vercel.json`). Use the **pooled** connection string (host contains `-pooler`) as `DATABASE_URL`, and set `DATABASE_SSL=true`.
2. **Schema:** from a trusted machine, run `npm run db:migrate` with `DATABASE_URL` pointing at Neon. The migrations create the `portal_student` and `portal_public` roles (row-level security) and grant them to the connecting role; Neon's owner role is allowed to do this.
3. **First administrator:** `npm run admin:create -- --email chair@example.org --name "Union Chair" --role union_admin`. There are no default credentials; the account must change its password at first login.
4. **Environment variables** (Vercel → Settings → Environment Variables): `DATABASE_URL`, `DATABASE_SSL=true`, `APP_SECRET` (32+ random characters), `CRON_SECRET` (16+), `AI_EMBEDDING_PROVIDER=transformers`, `AI_CLASSIFIER_PROVIDER=local`. Leave `MODEL_CACHE_DIR` and `TRUSTED_PROXY_COUNT` unset: on Vercel the model is cached in `/tmp/dli-models` (re-downloaded, ~23 MB, after a cold start) and Vercel's `X-Forwarded-For` holds only the visitor's address.
5. **Function size:** the embedding runtime ships binaries for every platform (~290 MB). `next.config.ts` keeps only the Linux x64 binary in each function (~68 MB traced), well under Vercel's 250 MB limit.
6. **Background work:** matching runs right after each submission (`after()`). `vercel.json` also schedules `GET /api/jobs/process` daily as a safety net (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the Hobby plan allows daily schedules only).

### Any other host

Run `npm run build && npm start` behind HTTPS with the same variables, set `TRUSTED_PROXY_COUNT` to the number of proxies in front of the app, and schedule `/api/jobs/process` every 5–10 minutes or run `npm run worker`. Never commit `.env.local`.

**Branding:** names and logos are in `src/config/brand.ts`; colours are the tokens in `src/styles/theme-tokens.css`; site icons are `src/app/favicon.ico`, `icon.png` and `apple-icon.png`.
---

## Implementation status

**Working and tested:** everything in the tables above. That covers username-only student access with the live "already picked" check, one-step complaint logging, dashboard, details and review requests; the site-wide stats banner (issues logged and active students); the public issues page; the admin overview with filters; issue management (assign, status, deadlines with reasons, priority override, published updates, internal and oversight notes, public visibility, escalation, proposals, merge, split, reopen, review-request handling); submission management and manual regrouping; the match review queue; reports; staff accounts; settings (categories, thresholds, priority rules, queue); the audit log; the local AI provider; retries and recovery; seed and migrations. The production build, type checking and lint pass. A headless-browser smoke test on the production build covered registration, submission with auto-grouping, cross-student URL tampering, admin match confirmation, publishing, and role restrictions at phone and desktop widths.

**Requires credentials (implemented, not exercised against live services here):**

- The OpenAI-compatible and Anthropic providers need API keys. Their failure paths are covered through the provider interface in tests.
- Supabase hosting was not used; the app was verified on PostgreSQL 17.

**Known limitations and next steps:**

- **Candidate search:** comparison runs in application code over open and recently resolved issues (fine for thousands of issues). On Supabase, enable `pgvector` and move this into an indexed query for larger volumes.
- **No account recovery:** this is by design, since no contact details are held. A forgotten username means picking a new one.
- **No notifications:** there are no email or SMS notifications by design. Students check their dashboard.
