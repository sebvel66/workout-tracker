-- Expand the exercises table into a proper library.
--
-- - Add taxonomy columns (equipment, muscle_group, movement_pattern).
-- - Add weight_mode for per-side / bodyweight / no-weight movements.
-- - Add is_custom flag to distinguish user-created rows from seed library rows.
-- - Allow user_id = NULL so seed library rows exist globally rather than
--   per-user.
-- - Replace the single (user_id, name) unique constraint with two partial
--   unique indexes: seed names globally unique, custom names unique per
--   user (so two users can each have a "My Bench Variation" without colliding).
-- - Split the RLS policy so users can SELECT seed rows but can't INSERT /
--   UPDATE / DELETE them.
--
-- Existing rows (created by users via the v1 app) will default to
-- is_custom = true and weight_mode = 'total'; taxonomy columns will be NULL
-- until backfilled or re-categorized by the user.

-- 1. Allow user_id = NULL for seed rows.
alter table exercises alter column user_id drop not null;

-- 2. Drop the old unique constraint. It doesn't treat NULL user_ids the way
--    we need, and we want split rules for seed vs. custom rows anyway.
alter table exercises drop constraint exercises_user_id_name_key;

-- 3. Add taxonomy + mode + provenance columns.
alter table exercises
  add column equipment text
    check (equipment in (
      'barbell', 'dumbbell', 'cable', 'machine', 'smith machine',
      'bodyweight', 'band', 'other'
    )),
  add column muscle_group text
    check (muscle_group in (
      'chest', 'back', 'shoulders', 'biceps', 'triceps',
      'quads', 'hamstrings', 'glutes', 'calves', 'core',
      'traps', 'forearms', 'lower back', 'full body',
      'cardio', 'mobility'
    )),
  add column movement_pattern text
    check (movement_pattern in (
      'horizontal press', 'vertical press',
      'horizontal pull', 'vertical pull',
      'squat', 'hip hinge', 'hip extension',
      'isolation', 'isometric', 'olympic', 'compound',
      'carry', 'plyometric', 'cardio', 'mobility'
    )),
  add column weight_mode text not null default 'total'
    check (weight_mode in ('total', 'per_side', 'bodyweight', 'none')),
  add column is_custom boolean not null default true;

-- 4. New partial unique indexes.
--    - Seed rows (user_id IS NULL): name must be globally unique.
--    - Custom rows (user_id NOT NULL): name must be unique per user; two
--      different users CAN have the same custom name.
create unique index exercises_name_global_unique
  on exercises (name) where user_id is null;

create unique index exercises_name_per_user_unique
  on exercises (user_id, name) where user_id is not null;

-- 5. Replace the single "own_exercises for all" policy with per-action
--    policies so seed rows can be read by everyone but modified by no one.
drop policy "own_exercises" on exercises;

-- SELECT: own rows + global seed rows.
create policy "exercises_select" on exercises for select
  using (user_id = auth.uid() or user_id is null);

-- INSERT: only into own rows. Prevents a user from creating seed rows
-- (user_id = NULL) via the anon client.
create policy "exercises_insert" on exercises for insert
  with check (user_id = auth.uid());

-- UPDATE: only own rows. Users can't edit seed rows.
create policy "exercises_update" on exercises for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: only own rows. Users can't delete seed rows.
create policy "exercises_delete" on exercises for delete
  using (user_id = auth.uid());
