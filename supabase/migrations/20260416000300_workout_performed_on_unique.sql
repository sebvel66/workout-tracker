-- DB-level guard against duplicate plan workouts for the same
-- (user, day_index, calendar date). Closes two known v1.1 limitations:
--   1. Multi-tab duplicate workouts (two tabs each insert before seeing
--      the other's response).
--   2. First-insert retry duplicate (network flake loses the insert
--      response; client retries and inserts again).
--
-- Ad-hoc workouts (plan_id IS NULL) are intentionally excluded from the
-- constraint — the + New Session button is allowed to create multiple
-- ad-hoc sessions per day. Old-plan workouts (plan_id IS NOT NULL but
-- different from the active plan) are still covered; the previous-plan
-- row and the new-plan row for the same day have different plan_ids,
-- so the unique index (which keys on day_index + date, not plan_id)
-- would block two active-plan workouts for the same day even across
-- plan boundaries. That's the intent.
--
-- performed_on is populated by the client with the user's local calendar
-- date (YYYY-MM-DD in the user's timezone). Client inserts always send it;
-- the DEFAULT current_date is a server-side fallback for any row inserted
-- outside the app flow.

alter table workouts add column performed_on date;

-- Backfill existing rows. UTC-derived date is an acceptable approximation
-- for rows created before this migration — they're historical and the
-- exact per-user-local date no longer matters for uniqueness.
update workouts
  set performed_on = (performed_at at time zone 'UTC')::date
  where performed_on is null;

alter table workouts
  alter column performed_on set not null,
  alter column performed_on set default (current_date);

create unique index workouts_plan_day_once_per_date
  on workouts (user_id, day_index, performed_on)
  where plan_id is not null;
