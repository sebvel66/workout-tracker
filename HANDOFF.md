# Workout Tracker — Supabase Migration Handoff

Context for a fresh Claude Code instance picking up v1 (cross-device persistence) and preparing for v2 (AI-generated workouts from historical performance).

## Next session pickup

Current live version: **`v2.0.13`** (visible in bottom-right footer). `origin/main` is the source of truth; working tree is clean.

**Session A (v1 + v1.1) fully shipped.** Everything from the original Session A plan is live: auto-populate on done-tap, session start/complete timer with Resume (`paused_ms`), exercise library + picker, ad-hoc off-plan sessions, multi-day-per-calendar, weight-mode display, delete affordances, historical session browser. All v1.1 known-limitations are closed.

**Session A tail polish (2026-04-17) landed after the original pickup was written:**
- Day-tab strip → native `<select>` dropdown with optgroups (plan days + ad-hoc) + standalone `+ New Session` button.
- Rest timer ±15s adjust buttons.
- Export reworked: date range + CSV or JSON, queries every workout in window (plan + ad-hoc).
- OTP-code auth flow (keeps sign-in inside the PWA on iOS home-screen installs); magic link still works as fallback. Requires `{{ .Token }}` in the Supabase Magic Link email template.
- `fmtP` now prefers `reps_range` over `reps_target` and never double-renders when both are populated.
- Per-exercise "view recent" modal on every card — last 5 prior sessions with sets/reps/weight/RPE.

**Post-Session A follow-ups (2026-04-19, v2.0.8 – v2.0.13):**
- `v2.0.8` — delete-session button for ad-hoc workouts.
- `v2.0.9` — `loadExerciseLibrary` now keys `exerciseLibraryByName` / `exerciseIdCache` by `normName(row.name)`, matching the contract the state declarations already documented. Seed rows are already lowercase so this is a no-op for them; guards against legacy mixed-case user-custom rows from pre-normalization-on-insert v1 code.
- `v2.0.10` — exercise name resolver. Plan exercise names are display labels ("Pull-ups (BW, full ROM)", "DB Incline Bench Press (30°)") and rarely match seed names exactly. `resolveLibraryRow(name)` generates an ordered list of candidate keys via deterministic transformations (paren-strip, hyphen↔space, depluralize) plus an `EXERCISE_ALIASES` constant, and returns the first candidate that's in `exerciseLibraryByName` — or null. Both the write path (`ensureExerciseId`) and the read path (`openExerciseHistory`) route through it, so plan-logged sets and ad-hoc/imported sets land on the same `exercise_id`. Library-side secondary hyphen index covers "plan has no hyphen / seed has hyphen" without changing the `normName` contract.
- `v2.0.11` — header consolidation. Three header action buttons (History, Import, Export) + the inline sign-out affordance collapsed behind a single `☰` button that opens a bottom-sheet menu reusing the existing history-modal pattern. Pure UI refactor; no schema or behavior changes. Design/plan specs in `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- `v2.0.12` — session-level notes. Collapsible "Session notes" row between the session bar and first exercise card in both `buildDay` and `buildAdHocDay`. Save-on-blur upserts `workouts.notes` (column already existed from the init migration). Focus on the textarea triggers the existing `ensureWorkout` lazy-create path so pre-workout context (soreness, sleep) can be logged before the first set-done. Historical views render the textarea read-only. Feeds the v2 AI planner alongside set data for subjective recovery signals.
- `v2.0.13` — gym profiles. New `locations` table (id, user_id, name, created_at) with case-insensitive uniqueness per user and RLS; `workouts.location_id` nullable FK with `ON DELETE SET NULL`. Hamburger menu gains a "Gym Profiles" row that opens a CRUD modal (add / inline-rename / delete-with-count-hint). Session view gains a location dropdown between the session bar and session-notes row, defaulting to the most-recently-used gym; zero-gym users see a `+ Add a gym` prompt. Lazy workout creation carries a pre-start pick via a `pendingLocationId` sentinel (undefined = not touched, null = explicit no-gym, UUID = explicit gym). Read surfaces everywhere: historical day-picker (disabled dropdown), History browser list badge, History detail metadata line, View Recent per-exercise modal session header. Single migration `20260419000000_locations.sql`.

**Forward-looking work** is in [`ROADMAP.md`](ROADMAP.md). The big remaining scope is **Session B: AI-generated workouts and progression analytics**. The v1 schema was built explicitly for this (per-set RPE, prescribed-vs-actual columns, `completed_at` semantics, `paused_ms`) — no schema migration required to start.

**Non-obvious design choices worth reviewing before Session B:** the `paused_ms` entry and the `(user_id, plan_id, day_index, performed_on)` unique-index entry in [`DECISIONS.md`](DECISIONS.md). Both affect how analytics queries should interpret session duration and dedup semantics.

**Working conventions established during Session A** (preserve these in the next session):
- Every visible change bumps `APP_VERSION` (`v2.0.x` per iteration). Keeps stale-cache diagnosis trivial.
- User tests before every commit unless explicitly told otherwise. Commits are small and focused — avoid bundling unrelated work.
- All migrations go in `supabase/migrations/` with the Supabase timestamp convention; never edit an applied migration — write a forward-only one.
- Error toasts with retry callbacks are sticky until tapped; informational toasts auto-dismiss at 20s.
- Destructive operations get explicit user confirmation; pushes require explicit user approval.

## Where we left off (2026-04-12 session)

- Initial schema migration applied live (`20260412000000_init.sql`), followed by the active-plan unique index (`20260413000000_add_active_plan_unique_index.sql`) — both verified in the Supabase dashboard.
- Supabase magic-link auth gate working end-to-end, tested locally (send link → receive → click → tracker appears → sign out works). Committed as `b901074` and pushed.
- Tracker data flow still runs entirely on `localStorage` — nothing in the app reads or writes the Supabase tables yet.
- **Next session:** data-layer rewrite, starting with an audit of every `localStorage` call site in `index.html` so we know the full surface area before swapping in Supabase reads/writes.

## Repo state

- Single file: `index.html` (labeled v3 in header at line 344 — stale string, current code).
- Last commit: `b9a85b7` on 2026-02-28, "Update index.html".
- Only branch: `main`.
- Mobile-first workout tracker. Plan imported as JSON, results entered inline, saved to `localStorage`.

## Current localStorage shape

Two keys written in `index.html`:

**`workoutPlan`** (read-only after import, set at lines 688):
```
{ title, week, days: [
    { name, short, sets_total, duration,
      exercises: [
        { name, note, rest,
          sets: [ { weight, unit, reps_target, reps_range } ] }
      ] } ] }
```

**`workoutLog`** (written on every keystroke via `saveLog()` at line 676):
```
{ "day_<di>": {
    date: ISO string,
    exercises: {
      "ex_<ei>": {
        sets: [ { weight, reps, done } ],
        rpe: 6-10 | null,     // per-exercise in current code
        note: string,
        sub: string } } } }
```

Fragility to fix in migration: identity is positional array index, and re-importing a plan wipes the log (line 687).

## v1 goal

Cross-device persistence via Supabase. No new features, no AI yet. But schema must be queryable at the set level so v2 (progression, PRs, volume over time, AI-generated plans) doesn't require another migration.

## Decisions locked in

1. **Plans stay as `jsonb`** — the plan structure rarely needs set-level queries.
2. **Workouts + sets are normalized.** One row per session, one row per set.
3. **Per-set RPE**, not per-exercise (standard input for fatigue/progression models).
4. **Exercises table with FK** from sets, not free-text names (prevents history fragmentation like "Bench" vs "Barbell Bench Press").
5. **Prescribed and actual columns on `sets`** so "did I hit the target" is queryable without rejoining the plan blob.
6. **Write strategy: save-on-set-completion.** Typing weight/reps/RPE updates local state only. Tapping the "done" checkbox upserts that one set's row. Each network request = one complete set. Handles flaky gym wifi; matches sets as the atomic unit.
7. **RLS on every table**: `auth.uid() = user_id`.

## Proposed schema

```sql
create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  week text,
  data jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create index on plans (user_id, created_at desc);

create table exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references plans(id) on delete set null,
  day_index int,
  performed_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  notes text
);
create index on workouts (user_id, performed_at desc);

create table sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workout_id uuid not null references workouts(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  exercise_order int not null,
  set_order int not null,
  weight numeric,
  reps int,
  rpe int,
  prescribed_weight numeric,
  prescribed_reps int,
  substitution text,
  note text,
  done boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  constraint sets_completed_at_required_when_done
    check (done = false or completed_at is not null)
);
create index on sets (user_id, exercise_id, completed_at desc);
create index on sets (workout_id, exercise_order, set_order);
create index on sets (workout_id, completed_at);

alter table plans     enable row level security;
alter table exercises enable row level security;
alter table workouts  enable row level security;
alter table sets      enable row level security;

create policy "own_plans"     on plans     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_exercises" on exercises for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_workouts"  on workouts  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_sets"      on sets      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Indexes target three expected query shapes: "all sets for exercise X over time," "all sets in workout Y in canonical sequence," and "all sets in workout Y in time order" (for rest-interval/duration analysis).

**Timestamps on sets and workouts.** `sets.started_at` is set when weight or reps is first entered; `completed_at` is set (and enforced via CHECK) when `done` flips true; the app defaults it to `now()` at that moment. `workouts.started_at` is set on the first touch of any set in the session; `workouts.ended_at` is set when the user explicitly ends the workout, otherwise defaults to the last set's `completed_at`. Order fields (`exercise_order`, `set_order`) remain the canonical sequence — timestamps are the source of truth for *when*, order fields for *sequence*.

## Open behavior questions (need answers before coding)

1. **Un-checking a done set.** Toggle at `index.html:621` flips both ways. Options:
   - Delete the row (cleaner: "all done sets = real history").
   - Update `done=false` (preserves weight/reps if re-checked).
2. **Edits after completion.** If a done set's weight is corrected, does that trigger another upsert, or is `done` frozen? Auto-upserting on edit-after-done is probably right, but it softens the "done is the only write trigger" rule — name the behavior explicitly.

## Suggested implementation order

1. Supabase project setup + auth (email magic link is simplest for a one-user app).
2. Run schema migration above.
3. Add Supabase client to `index.html`, wire auth gate.
4. Plan import → insert into `plans`, set `is_active=true`, mirror to client state.
5. On set-done tap: upsert into `sets` (create `workouts` row lazily on first set of a session; create `exercises` row lazily on first encounter of a name).
6. On load: hydrate local state from active plan + most-recent incomplete workout.
7. Keep localStorage as offline cache/fallback; Supabase is source of truth when online.

## Gotchas / lessons learned

- **Local dev browser caching.** Restarting the Python server doesn't invalidate the browser cache, so the frontend can be running stale JavaScript against a fresh server. Always hard-reload (Cmd+Shift+R) after restarting the local server — normal reload (Cmd+R) can serve cached files and silently mask a fix.
- **Commit milestones as they pass their test gates.** When a multi-step change has clear internal milestones, commit each milestone as it's verified rather than holding the whole stack uncommitted. Today's git history mistake came from leaving the data-layer rewrite uncommitted while layering further changes on top — a `git checkout` reverted further than expected and required a rebuild of the commit sequence. Future multi-day work: commit the foundation as soon as it passes its own test gate.

## Known v1 limitations

**Open:**
- **Orphan user-custom exercise rows from pre-`v2.0.10` write path.** Before the resolver landed, every `ensureExerciseId(planName)` call created a user-custom row under the raw-normalized plan name (e.g. `"pull-ups (bw, full rom)"`, `"db romanian deadlift"`) and logged sets against it. `loadExerciseLibrary` pulls everything RLS exposes — seed + user-custom — so these orphan rows are still in `exerciseLibraryByName` and can intercept `resolveLibraryRow` before it reaches the canonical seed candidate, because raw-normalized candidates are tried first. Visible symptom: `openExerciseHistory` for an affected plan exercise shows only recent plan-logged sets (on the orphan row) while Fitbod/historical imports on the seed row stay hidden. Fix requires data cleanup: `UPDATE sets SET exercise_id = <canonical id> WHERE exercise_id = <orphan id>` then `DELETE FROM exercises WHERE id = <orphan id>`. A Supabase SQL audit to find orphans for the active user:
  ```sql
  SELECT id, name, user_id, is_custom
  FROM exercises
  WHERE user_id = '<uid>' AND is_custom = true
  ORDER BY name;
  ```
  Compare each entry against the seed library and the alias map; rows matching a plan exercise name should be merged into their canonical counterpart. Decline Crunch / VO2 Max Intervals / Zone 2 Walk / Cable Woodchop (if no seed "woodchop") genuinely have no canonical target — leave them.

**Resolved in Session A:**
- Multi-tab / first-insert retry dup → partial unique index on `(user_id, plan_id, day_index, performed_on)` + client 23505 re-query. See `DECISIONS.md`.
- Midnight boundary drift → `sessionTodayStart` snapshotted at hydrate, used by everything via `sessionBounds()` / `sessionTodayDateString()`.
- One editable tab per calendar day → `todayPlanStates` is now a map keyed by dayIndex, so every plan day tab independently tracks its own today-workout.
- Plan-name vs seed-library name divergence creating split history → resolved in `v2.0.10` by `resolveLibraryRow` + `EXERCISE_ALIASES`. Orphan rows from pre-`v2.0.10` persists remain a data cleanup task (see "Open" above), but new plan-logged sets land on the canonical row.

## Pre-deploy tasks

- *(No open pre-deploy tasks — see "Done" for the SMTP resolution.)*

## Done

- **Custom SMTP provider (2026-04-15).** Resend configured in Supabase → Authentication → Emails using the shared `onboarding@resend.dev` sender. Unblocks magic-link testing. Free tier limits are 3,000 emails/month and 100/day — well beyond expected usage, but worth knowing if this ever scales up. Upgrading to a custom domain sender is optional polish for post-v1.

## Deferred features

- **Add ad-hoc exercises** (exercises performed but not in the imported plan). Planned for after the Supabase migration — see `DECISIONS.md` → "Ad-hoc exercises (extras)" for the data-model approach (separate `extras` client-side; `sets` rows with `exercise_order > plan_length` and null prescribed fields server-side).
- **"Done = did as prescribed" shortcut.** Currently tapping the done checkbox while weight/reps inputs are empty marks the set done with `weight=null, reps=null` in the DB. Proposal: on check with empty inputs, auto-populate from the prescribed placeholder values (the greyed-out target numbers already shown as `placeholder`). Saves a tap per set when the user hit the plan exactly. Edge case: partial fills (weight entered, reps empty) — probably only auto-fill the empty field, not overwrite.
- **Browse historical weeks.** Current UI only surfaces the most recent workout per `day_index`. Need a week-picker or date-based navigation so past weeks are reviewable. Schema already supports it (`workouts.performed_at` is indexed); purely a UI addition.
- **Adjustable rest timer in the UI.** Timer currently uses `exercise.rest` from the plan or a 90s fallback with no in-app way to change mid-workout. Add +/- controls or a tap-to-edit on the timer card.
- **Longer toast persistence.** Current auto-dismiss is 9 seconds; feels too short in practice for reading and reacting to error context. Bump to ~20s, or make sticky-until-dismissed for error toasts (keep auto-dismiss for successes if/when we add those).

## Non-goals for v1

- Multi-user features.
- Historical analytics UI.
- AI anything.
- Plan editing in-app.
- Conflict resolution beyond last-write-wins (single user, single device at a time in practice).
