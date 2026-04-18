-- Allow ad-hoc (off-plan) workout sessions to carry an optional title.
--
-- Plan-based workouts don't need a title — they're identified by the plan
-- day they correspond to. Ad-hoc workouts have plan_id = NULL and
-- day_index = NULL, so a dedicated title is how the user labels the
-- session ("Saturday pump", "Hotel room push day"). Nullable; the UI
-- falls back to a short sequence label ("S1", "S2", …) in tabs and to
-- the performed_at date inside the session view when the title is blank.

alter table workouts add column title text;
