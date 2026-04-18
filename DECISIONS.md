# Decisions

Running log of architecture/behavior decisions for the workout tracker. Newest first.

## 2026-04-17 — Session pause/resume via `paused_ms` offset column

When a user pauses a session (Complete Session tap, often accidental) and later resumes, the displayed timer must pick up at the same elapsed value it showed at pause — not the wall-clock since `started_at`, which would include the pause gap. Two approaches considered:

- **Shift `started_at` forward by the pause duration.** Simple, no schema change, but mutates a field DECISIONS.md already committed to as "the literal moment of first set-touch." Breaks the semantic across any subsequent analysis that relied on start timestamps.
- **Separate `paused_ms bigint` offset column.** Adds a column, accumulates pause gaps, every display subtracts it. Preserves `started_at` as literal.

Chose the offset column ([supabase/migrations/20260416000400_add_workout_paused_ms.sql](supabase/migrations/20260416000400_add_workout_paused_ms.sql)).

**How to apply:**
- On Resume: add `(now - ended_at)` to `paused_ms`, clear `ended_at`, persist both. `started_at` stays untouched.
- Every timer / duration display uses `sessionElapsedMs(state)` which computes `(ended_at || now) - started_at - paused_ms`.
- Multiple Complete → Resume cycles accumulate into the same column.
- Historical rows default to `paused_ms = 0`; their effective duration is unchanged.

## 2026-04-16 — Per-plan dup prevention: `performed_on` + partial unique index on `(user_id, plan_id, day_index, performed_on)`

Closes two limitations (multi-tab duplicate workouts, first-insert retry dup) with one DB-level constraint.

**Shape that works:**
```sql
create unique index workouts_plan_day_once_per_date
  on workouts (user_id, plan_id, day_index, performed_on)
  where plan_id is not null;
```

Ad-hoc workouts (plan_id NULL) are intentionally excluded so "+ New Session" can create many per day.

**Why the key includes `plan_id`:** the first pass omitted it and keyed on `(user_id, day_index, performed_on)` only. That was too strict — it blocked a user from starting a new-plan workout on the same calendar day that already had an old-plan workout, which collides with the Feature 3 mid-day-import behavior (old-plan workouts are kept in the DB marked historical while the newly active plan takes over). Including `plan_id` still catches the actual race cases (multi-tab and retry both race within a single plan_id) while allowing legitimate plan-switch-mid-day inserts. Corrected in [supabase/migrations/20260417000000_fix_workout_uniqueness_per_plan.sql](supabase/migrations/20260417000000_fix_workout_uniqueness_per_plan.sql).

**How to apply:**
- Client always sends `performed_on` on insert (user-local `YYYY-MM-DD` from `sessionTodayDateString()`, tied to the hydration snapshot).
- On Postgres error `23505` (unique_violation) during insert, the client re-queries by `(user_id, plan_id, day_index, performed_on)` and adopts the existing row instead of creating a duplicate.
- `current_date` is set as the column DEFAULT as a server-side fallback for any row inserted outside the app flow.

## 2026-04-12 — Active plan uniqueness

At most one `plans` row per user may have `is_active = true`, enforced at the database level via a partial unique index:

```sql
create unique index plans_one_active_per_user on plans (user_id) where is_active;
```

**Why DB-level, not app-level:** app-enforcement leaves silent failure modes — race conditions on concurrent import, direct edits from the Supabase dashboard, or interrupted imports — where two rows end up active simultaneously. The v2 AI planner will read "the active plan" and must never ambiguously pick one of two. Making the invalid state impossible is cheaper than defending against it everywhere downstream.

**How to apply:** when importing a new plan, the client must un-flag the previous active plan (`update plans set is_active = false where user_id = auth.uid() and is_active`) in the same logical operation as inserting the new one. A naïve "insert with is_active=true" will be rejected by the unique index.

**Amendment 2026-04-13 — applied state correction.** The index was originally written into `20260412000000_init.sql`, but a re-run failure against the live database meant only the table-creation portion of that migration actually executed; the index never landed. To reconcile file-state with applied-state, the index was split into a follow-up migration (`20260413000000_add_active_plan_unique_index.sql`) and the original init file was edited to remove the index line so it accurately reflects what is in the database. This is a one-time exception: going forward, never edit a previously-run migration — always write a new forward-only migration instead.

## 2026-04-12 — Ad-hoc exercises (extras)

Users will be able to log exercises they did not import from the plan JSON. These live separately from the prescribed plan blob.

- **Client shape (pre-Supabase):** stored on a per-day `extras` array inside `logData`, e.g. `logData.day_<i>.extras = [{ name, sets: [{ weight, reps, done, rpe }], note }]`. The plan blob is never mutated.
- **Supabase shape:** extras become ordinary rows in `sets` with `exercise_order > plan_length`, `prescribed_weight` and `prescribed_reps` null, and a normal `exercise_id` FK (lazy-create the `exercises` row on first use, same as prescribed exercises). No schema change required.
- **Why keep them separate:** the plan blob stays immutable, so re-importing a plan never wipes logged extras, and "did I hit the plan?" queries stay clean (filter `prescribed_reps is not null`). Mutating the plan to append ad-hoc exercises would conflate prescription with execution.
- **Status:** post-v1 feature. Document now, build after Supabase is live.

## 2026-04-12 — Per-set and per-workout timestamps

Per-set timestamps captured for rest-interval analysis, fatigue timing, and skipped-exercise detection. Order fields kept separately as canonical sequence.

- `sets.started_at` (nullable): set when weight or reps is first entered.
- `sets.completed_at`: set when `done` flips true; enforced with a CHECK constraint (`done = false or completed_at is not null`); app defaults it to `now()` on the false→true transition.
- `workouts.started_at` / `workouts.ended_at` (nullable): session bounds. `started_at` on first set touch; `ended_at` on explicit end or falls back to the last set's `completed_at`.
- Added index `sets (workout_id, completed_at)` for time-ordered in-session queries.
- `exercise_order` / `set_order` remain the canonical sequence — timestamps are truth for *when*, order fields for *sequence*. Both matter: order survives if timestamps are ever null/broken, timestamps unlock things order alone can't (rest intervals, total duration, pacing).

## 2026-04-12 — Open questions from HANDOFF.md resolved

**Un-checking a done set → update `done=false`, do not delete.** Mis-taps are common on mobile; preserving fields lets a re-tap restore without re-entry. Analytics filter `where done = true`. Deletion also loses `completed_at` across flaky-wifi tap cycles.

**Edits after completion → auto-upsert changed fields; only the false→true transition bumps `completed_at`.** Once the row exists, corrections must sync. `completed_at` means "when the lift happened," not "when the row was last touched" — v2 progression models depend on this.

- `done` false→true: upsert, `completed_at = now()`.
- Edit while `done=true`: upsert changed fields, leave `completed_at`.
- `done` true→false: update `done=false`, leave `completed_at` (overwrite only if re-done later).
