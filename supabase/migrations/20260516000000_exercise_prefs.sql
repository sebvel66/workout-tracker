-- Per-user exercise preferences (v3.6.25).
--
-- Currently holds one field: `timed`. An exercise renders/prescribes as
-- weight + time (instead of weight + reps) when it is "timed". The app
-- auto-detects timed from the library's movement_pattern = 'isometric'
-- (plank, dead hang, wall sit, etc.); this table lets a user override
-- that per exercise — force-timed a non-isometric movement, or turn it
-- off for an isometric one.
--
-- Per-user (not a column on the shared `exercises` rows) so toggling a
-- seed exercise never leaks across users. Resolver in js/data.js:
--   isTimedExercise(meta) =
--     pref row exists -> pref.timed
--     else            -> meta.movement_pattern === 'isometric'
--
-- One row per (user, exercise); upserted by the per-card "timed" chip.

create table exercise_prefs (
  user_id     uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  timed       boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

alter table exercise_prefs enable row level security;

create policy "own_exercise_prefs_select"
  on exercise_prefs for select
  using (auth.uid() = user_id);

create policy "own_exercise_prefs_insert"
  on exercise_prefs for insert
  with check (auth.uid() = user_id);

create policy "own_exercise_prefs_update"
  on exercise_prefs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own_exercise_prefs_delete"
  on exercise_prefs for delete
  using (auth.uid() = user_id);
