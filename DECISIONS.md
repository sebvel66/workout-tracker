# Decisions

Running log of architecture/behavior decisions for the workout tracker. Newest first.

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
