# Major bugs

Record of significant bugs that required non-trivial investigation or data cleanup. Newest first. Small, in-code-fixed-in-one-commit bugs don't belong here — those live in git history. This file is for bugs where the root cause, the fix, or the blast radius is worth knowing later.

## 2026-04-19 — "View Recent" modal: doubled sets + blank exercises (v2.0.15)

### Symptoms

Per-exercise View Recent modal showed two independent issues:
1. **Doubled sets on historical sessions.** Pull-ups on April 12 displayed `0 × 12 · 0 × 12 · 0 × 12 · 0 × 12 · 0 × 7 · 0 × 7` when only 3 sets were actually performed (2×12, 1×7). Same pattern across the entire "Fitbod Import" history (every exercise, every imported session).
2. **Blank modal for exercises with known prior history.** DB Romanian Deadlift opened the modal but rendered "No prior sessions logged" despite 10+ weekly Fitbod sessions on record.

### Root causes

**Bug 1 — Fitbod Import script ran twice.** Historical Fitbod CSV data was imported via SQL scripts pasted into the Supabase SQL Editor. One of the import batches was executed twice, silently double-inserting every set. Evidence: identical `completed_at` timestamps to the second across all duplicate pairs, and duplicate `(workout_id, exercise_id, exercise_order, set_order)` tuples across ~22 "Fitbod Import" workouts. Roughly 1107 extra rows total.

**Bug 2 — Orphan user-custom exercise row intercepted `resolveLibraryRow`.** A `db romanian deadlift` row in `exercises` with `user_id = <uid>` and `is_custom = true` existed from pre-`v2.0.10` `ensureExerciseId` behavior (before the resolver landed, every plan exercise name was upserted as a user-custom row). [resolveLibraryRow](js/resolver.js) tries raw-normalized candidates before applying the alias map, so for "DB Romanian Deadlift" it hit the orphan (4 sets, all from today's workout) *before* the alias `'db romanian deadlift' → 'dumbbell romanian deadlift'` got a chance. All 4 orphan sets then got filtered out by `todayState.workoutId` exclusion in `openExerciseHistory` → blank modal. Meanwhile the ~40 Fitbod Import sessions stayed stranded on the canonical seed row.

### What was fixed

**Data cleanup (SQL run in Supabase dashboard, one-off, not a migration):**

- **Deduped Fitbod Import sets** — kept one row per `(workout_id, exercise_id, exercise_order, set_order, done)` tuple. ~1107 duplicate rows deleted.
- **Merged orphan `db romanian deadlift`** → canonical `dumbbell romanian deadlift` via `UPDATE sets SET exercise_id = <canonical>` then `DELETE FROM exercises WHERE id = <orphan>`.
- **Deleted empty orphan `db bench press`** — 0 sets, safe straight delete.
- **Merged `cable crossover` → `cable fly`** for this user's sets (19 sets moved). Fitbod used "cable crossover" where the plan uses "Cable Chest Fly"; merging onto `cable fly` lands them on the same canonical.
- **Plan JSON clean-up** — renamed "Weighted Reverse Crunch" → "Reverse Crunch" (so the resolver finds the canonical where Fitbod history lives, since both names exist as distinct seed rows and raw-normalized wins over alias); removed vestigial "VO2 Max 4×4 Intervals (Saturday)" and "Zone 2 Walk (Friday)" entries.

**Code changes ([v2.0.15](js/app.js)):**

- Added `'db bench press' → 'dumbbell bench press'` to [EXERCISE_ALIASES](js/resolver.js#L17-L37) so future logging under the "DB Bench Press" plan name doesn't create a new orphan (the existing `db flat bench press` alias didn't cover the plain form).

**Schema hardening ([new migration](supabase/migrations/20260419010000_sets_unique_position.sql)):**

- Partial unique index `sets_unique_position_per_workout` on `sets (workout_id, exercise_id, exercise_order, set_order) where done = true`. Would have 23505'd the Fitbod Import re-run. Applied after data cleanup so existing duplicates don't block it.

### Debugging path (for future sessions)

Query progression that isolated the bugs:
1. Q1 — `count(sets)` per workout on affected date → **one workout, 6 sets** (not two workouts).
2. Q2 — raw set rows → **identical `completed_at` across duplicates, duplicate `set_order` pairs**.
3. Q3 — user-custom exercises with done counts → found 2 orphans.
4. Q4 — where DB RDL history lives (orphan vs canonical) → confirmed 10 Fitbod sessions on canonical, 4 orphan sets all on today's workout.
5. Q5 — scope check across all Fitbod Imports → `done_rows = 2 × distinct_positions` uniformly.
6. Q6 — all exercises matching affected names → confirmed orphan was intercepting resolver.
7. Q (b) — all Fitbod Import exercise names → used to cross-reference plan coverage and identify mismatches.

### Known leftover concerns (not fixed this session)

- **Pseudo-seed rows from Fitbod Import script.** Several Fitbod exercise names that aren't in the app's seed library (`kettlebell sumo squat`, `stability ball roll out`, `tuck crunch`, `cable chest press`, `hammerstrength incline chest press`, `hammerstrength chest press`, `balance trainer reverse hyperextension`, `exercise ball crunch`, `bench dip`, `tricep push up`, `vertical leg raise`, `calf press`, `tricep push up`) were inserted with `user_id = NULL` and `is_custom = false` — pseudo-seeds that pollute the global library. Harmless for a single-user app; cleanup deferred. If multi-user support ever ships, these need to be either promoted to real seeds or moved to user-custom.
- **Resolver ordering: raw-normalized wins over alias.** The `weighted reverse crunch` case exposed that when a seed and an alias target both exist, the raw-normalized candidate short-circuits before the alias runs. Worked around by renaming the plan entry; a deeper fix would be a separate "override" map or re-ordering the candidate generation. Not urgent — the resolver is scheduled to be replaced by plan-import-time resolution (see ROADMAP.md → "Resolve plan exercise names at import time").
- **Migration application.** `20260419010000_sets_unique_position.sql` must be applied against the live Supabase database (the file in the repo is forward-only but not auto-applied). Apply via the SQL editor or Supabase CLI if not already done.
