-- Correct the partial unique index on workouts so plan-switch-mid-day
-- is allowed.
--
-- The previous index keyed on (user_id, day_index, performed_on) without
-- plan_id, which blocked a user from starting a new-plan workout on the
-- same calendar day that already had an old-plan workout. That collides
-- with the Feature 3 mid-day-import behavior: old-plan workouts are
-- intentionally kept in the DB (marked historical) while the newly
-- active plan takes over, and the new plan's workout for the same
-- day_index + date legitimately has a different plan_id.
--
-- Including plan_id in the uniqueness key still catches the two cases
-- the index was added for:
--   1. Multi-tab duplicate workouts (two tabs racing the first insert
--      for the same plan, day_index, date).
--   2. First-insert retry dup (same plan, day_index, date — client
--      retry after a lost response).
-- Both race within a single plan_id, so the narrower key is exactly
-- right.
--
-- Ad-hoc workouts (plan_id IS NULL) continue to be excluded by the
-- partial predicate, so "+ New Session" can still create many per day.

drop index if exists workouts_plan_day_once_per_date;

create unique index workouts_plan_day_once_per_date
  on workouts (user_id, plan_id, day_index, performed_on)
  where plan_id is not null;
