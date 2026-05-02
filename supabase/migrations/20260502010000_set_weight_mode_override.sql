-- Per-workout-instance weight-mode override.
--
-- Each set may carry an optional weight_mode override that wins over the
-- library default in `exercises.weight_mode`. NULL means "inherit from
-- the exercise's library default" (current behavior — every existing row
-- is NULL after this migration).
--
-- The override is deliberately limited to the two interpretations a user
-- might toggle at runtime: 'total' vs 'per_side'. 'bodyweight' and 'none'
-- are intrinsic to the exercise and are not user-toggleable per workout,
-- so they're excluded from the check constraint.
--
-- The toggle in the UI stamps the same value on every set in a placement
-- via UPDATE sets SET weight_mode = $1 WHERE workout_id = $2 AND
-- exercise_order = $3, mirroring the fan-out pattern used by
-- updateExerciseFanOut and historyUpdateExerciseRpe.

alter table sets
  add column weight_mode text
    check (weight_mode in ('total', 'per_side'));
