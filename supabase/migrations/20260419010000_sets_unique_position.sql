-- Prevent duplicate set rows at the same (workout, exercise, exercise_order, set_order)
-- position for completed sets. A Fitbod history import was re-run in the SQL Editor
-- and silently inserted a second copy of every set (~1107 duplicate rows across ~22
-- "Fitbod Import" workouts); this index would have 23505'd the re-run. Partial on
-- done = true to leave room for any non-done placeholder/unsaved rows.
create unique index sets_unique_position_per_workout
  on sets (workout_id, exercise_id, exercise_order, set_order)
  where done = true;
