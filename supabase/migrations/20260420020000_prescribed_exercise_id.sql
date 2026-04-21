-- Structured substitution tracking.
--
-- Before: sets.exercise_id was always "what the plan prescribed" and
-- sets.substitution (text) held free-text user-typed notes about what
-- they actually did. Result: sets logged with a substitution were
-- invisible under the substituted exercise's history, plan-adherence
-- queries were impossible, and the AI planner couldn't reason about
-- swap patterns.
--
-- After: sets.exercise_id = what actually happened (substituted exercise
-- if the user subbed, else same as prescribed). New column
-- sets.prescribed_exercise_id = what the plan asked for (null for
-- ad-hoc / extra sets where no prescription existed). Substitution is
-- detected as prescribed_exercise_id != exercise_id.
--
-- Downstream effects:
-- - View Recent on "Machine Row" now shows Machine Row sets regardless
--   of whether they were prescribed or substituted in.
-- - Plan-adherence query: WHERE prescribed_exercise_id IS NOT NULL AND
--   prescribed_exercise_id != exercise_id.
-- - AI planner substitution patterns (v2.2.2): group by
--   (prescribed_exercise_id, exercise_id) WHERE they differ.
--
-- Legacy sets.substitution (text) column stays untouched — new writes
-- won't populate it; old Fitbod-import free-text values remain as-is.

-- 1. Add the column. Nullable — ad-hoc + extra sets have no prescription.
--    ON DELETE SET NULL so deleting an exercise doesn't cascade into sets.
alter table sets
  add column prescribed_exercise_id uuid references exercises(id) on delete set null;

-- 2. Backfill existing plan-day sets. Every set tied to a plan workout had
--    exercise_id = prescribed (substitution was stored separately as text).
--    So prescribed_exercise_id = exercise_id is correct for every such row.
--    Ad-hoc sets (plan_id is null) stay with prescribed_exercise_id = null.
update sets s
  set prescribed_exercise_id = s.exercise_id
  from workouts w
  where s.workout_id = w.id
    and w.plan_id is not null
    and s.prescribed_exercise_id is null;

-- 3. Index tuned for the AI planner's future substitution-pattern query
--    (v2.2.2): "for this user, which prescribed exercises were swapped
--    for which actuals, and how often." Narrow partial — only rows where
--    substitution actually happened.
create index sets_substitutions_by_user
  on sets (user_id, prescribed_exercise_id, exercise_id)
  where prescribed_exercise_id is not null
    and prescribed_exercise_id <> exercise_id;
