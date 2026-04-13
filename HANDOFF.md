# Workout Tracker — Supabase Migration Handoff

Context for a fresh Claude Code instance picking up v1 (cross-device persistence) and preparing for v2 (AI-generated workouts from historical performance).

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

## Deferred features

- **Add ad-hoc exercises** (exercises performed but not in the imported plan). Planned for after the Supabase migration — see `DECISIONS.md` → "Ad-hoc exercises (extras)" for the data-model approach (separate `extras` client-side; `sets` rows with `exercise_order > plan_length` and null prescribed fields server-side).

## Non-goals for v1

- Multi-user features.
- Historical analytics UI.
- AI anything.
- Plan editing in-app.
- Conflict resolution beyond last-write-wins (single user, single device at a time in practice).
