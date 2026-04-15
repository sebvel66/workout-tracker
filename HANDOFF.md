# Workout Tracker — Supabase Migration Handoff

Context for a fresh Claude Code instance picking up v1 (cross-device persistence) and preparing for v2 (AI-generated workouts from historical performance).

## Next session pickup

Priority order:

1. **Finish the data-layer rewrite test pass and commits.** BOTH sets of changes are currently uncommitted together in the working directory on `index.html`:
   - **Change A — crash fix:** `#emptyState` moved out of `#workoutContainer` (HTML structural move) + `body.unauthed #emptyState` CSS rule so it stays hidden behind the auth gate.
   - **Change B — alert-to-toast cleanup:** all seven `alert()` calls in `handleImport` / `exportData` converted to `showToast(...)`, with `console.error(err)` added before the two `catch`-block toasts so stack traces still reach DevTools.
   - `BUG-TEST-13.md` documents the crash root cause.

   Because both sets of changes live in the same file, they need to be staged separately — use `git add -p` (or stage the specific hunks manually) to split them into two commits in sequence, **not** one combined commit.

   Steps:
   - Hard-reload (Cmd+Shift+R).
   - Run test 13 (sign in → import week 1 → log a few sets → import week 2 → verify no crash and the UI re-renders with the new plan).
   - Hard-reload mid-workout to exercise the `hydrate()` path.
   - Verify the signed-out state: auth gate shows, `#emptyState` is hidden behind it.
   - **Commit 1 (after test 13 passes):** stage only the Change A hunks (HTML move + `.unauthed` CSS rule). Commit message like "Fix #emptyState crash on re-import — move element out of workoutContainer." Also stage `BUG-TEST-13.md` with this commit.
   - **Commit 2 (after a visual diff review of the staged alert-to-toast hunks):** stage the remaining Change B hunks. Commit message like "Replace remaining alert() calls with showToast() — non-blocking error UX, no more swallowed stack traces."
   - Then finish test checklist items 14–17 (export, toast/retry, sign out, legacy-localStorage residue).
   - Then push everything.
2. **Do NOT push previous commits** until the full test pass is complete.

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

- **Multi-tab duplicate workouts.** Two browser tabs open on the same day could each independently hit "first set done" before either has persisted a `workouts` row, producing two rows for the same day. Single-tab use is safe — the in-memory `currentWorkoutId` guard prevents it within a tab. Mitigation deferred to v1.1 via a generated `performed_on date` column on `workouts` plus a partial unique index on `(user_id, day_index, performed_on)`. Documented here so future-me doesn't debug it fresh if it ever surfaces.
- **First-insert retry dup.** If the very first `workouts` insert of a session fails mid-flight (network flake) and the user retries, the retry can't distinguish "never persisted" from "persisted but response lost," so a duplicate row is possible. Narrow failure window; worst case is one stray workouts row that's easy to detect and delete. Same class as the multi-tab limitation — both resolved by the v1.1 unique index.
- **Midnight boundary drift.** "Today" is computed on every write/hydrate via `new Date()`, so a session that straddles midnight could see the boundary slip and log the late sets as a new day. Unlikely in practice; fix for v1.1 is to snapshot `todayStart` on hydration and hold it steady in memory for the session.
- **One editable tab per calendar day.** Current rule: `todayState` is pinned to the first `day_index` the user taps "done" on, and every other tab flips to disabled until the calendar rolls over. This blocks logging two different day_index workouts on the same calendar date (e.g., doing Monday in the morning and Tuesday at night). v1.1 candidate: loosen the rule to one editable tab per `(date, day_index)` pair so each tab independently tracks its own today-workout. Roughly a 10-line change to `hydrate()` and `viewModeFor()`.

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
