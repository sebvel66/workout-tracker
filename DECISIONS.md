# Decisions

Running log of architecture/behavior decisions for the workout tracker. Newest first.

## 2026-04-19 — Explicit session-start modal replaces silent day-of-focus default

Before `v2.0.16`, hydrate silently chose which tab to focus: lowest-index plan day with a today-state, else Day 0, else the first ad-hoc. No choice point, no concept of "which day am I actually training today." This mapped poorly to the real-world case where the user's calendar doesn't match the plan's rotation (skipped rest day, travel week, rearranged split). It also meant a user with no active plan had nowhere to begin — the tab strip only rendered when a plan existed.

**Chosen:** a bottom-sheet modal on hydrate whenever no session is in-progress. Three paths:

1. **Suggested day** — `(lastCompletedDayIndex + 1) mod plan.days.length`, computed once per hydrate by `loadSuggestedDayIndex()` via one SELECT on `workouts` filtered to `plan_id = active AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`. First-ever session → Day 0.
2. **Pick a different day** — in-place expanding list of all plan days with badges (`in progress`, `completed today`).
3. **Blank session** — existing `createAdHocSession()`; no plan dependency, so this is also the only path in the no-active-plan state.

**Why this shape:**

- **Modal, not full-screen takeover.** Reuses the existing `.modal-overlay` pattern (History, Hamburger, Gym Profiles, etc.), so zero new CSS primitives and the hydrate render flow is unchanged — the session view still renders beneath, the modal overlays.
- **Rotation+1, not day-of-week.** Day-of-week mapping would re-introduce exactly the calendar-rigidity the modal is trying to break. Rotation+1 honors "the plan is the rotation, not the calendar" — skip Tuesday, come back Wednesday, still suggest the next plan day.
- **In-progress sessions skip the modal.** Modal is the *start* experience; once you're mid-workout, reloads should drop you straight back into the session. The focus hierarchy (v2.0.16) also promotes an in-progress session above lowest-day-index, so a user who completed Day 2 and started Day 3 today lands on Day 3 on reload instead of Day 2.
- **"Start another workout" hamburger item is always available.** Covers the second-session-same-day and the "I changed my mind mid-session but haven't logged anything yet" cases with a single trigger.
- **No schema changes.** One SELECT added to hydrate, everything else composes from existing tables.

**How to apply:**

- Any feature that wants to insert a new session-start path should add a fourth card to the modal rather than introducing a new entry point. The modal is the canonical "which workout am I doing" surface.
- Do not re-introduce day-of-week auto-selection. If the user wants the modal to remember a different default, that's a preference setting, not a silent heuristic.
- The "+ New Session" standalone button has been removed as redundant — "Blank session" (Path 3) is the canonical ad-hoc entry. Don't re-add a shortcut button for ad-hoc.

Design: [docs/superpowers/specs/2026-04-19-flexible-session-start-design.md](docs/superpowers/specs/2026-04-19-flexible-session-start-design.md).

## 2026-04-19 — Partial unique index on `sets (workout_id, exercise_id, exercise_order, set_order) where done = true`

The v1 schema indexed `sets (workout_id, exercise_order, set_order)` for in-session ordered reads but did not make the combination unique. This let a historical-data import script (Fitbod CSV pasted into the Supabase SQL Editor) re-run end-to-end and silently double-insert ~1107 set rows across ~22 workouts, surfacing as doubled entries in the per-exercise View Recent modal (see `MAJOR-BUGS.md` for the full incident write-up).

**Chosen shape:**

```sql
create unique index sets_unique_position_per_workout
  on sets (workout_id, exercise_id, exercise_order, set_order)
  where done = true;
```

**Why this exact shape rather than a full unique index:**

- `done = true` partial: leaves room for non-done placeholder or transient rows (if ever introduced — e.g. an auto-save that pre-creates rows before the checkbox flips) without failing the constraint. Only finalized/history rows are constrained.
- Includes `exercise_id` in the key: the partial workout-uniqueness index (from 2026-04-16) is `(user_id, plan_id, day_index, performed_on)` — it guards against duplicate *workouts*. This index is the complementary set-level guard. Including `exercise_id` handles the case where a client or import assigns identical `(exercise_order, set_order)` to rows that genuinely belong to different exercises (unlikely in the current app but defensive for bulk inserts).
- Chosen over application-level dedup: the actual incident was an external SQL Editor script, not client code, so only a DB-level constraint could have prevented it.

**How to apply:**

- Any future SQL import / bulk insert that re-runs will now 23505 instead of silently double-inserting. Scripts should `ON CONFLICT DO NOTHING` if idempotent re-runs are expected.
- Client-side `persistSet` already handles one-row-at-a-time and will never trip the constraint under normal tap-done flow. The `update` / `insert` branches in [persistSet](js/data.js) don't need changes.
- Migration file is forward-only: `supabase/migrations/20260419010000_sets_unique_position.sql`. Must be dedup'd first (any pre-existing duplicates will block creation).

## 2026-04-19 — Timers use wall-clock deadlines, not counters. Notification API rejected for rest timer.

All time-sensitive UI in this app must be **wall-clock anchored** rather than counter-based. The session timer already does this (`sessionElapsedMs = Date.now() - startedAt - pausedMs`); the rest timer was the outlier until `v2.0.14` — it counted down a `restSeconds` variable via `setInterval(..., 1000)`, and iOS suspended the interval when the PWA lost focus, freezing the timer mid-rest.

**The rule:** any countdown or elapsed display stores `targetMs` (deadline) or `startedAt` (start time) as an absolute `Date.now()` value. The re-render interval just reads `Date.now()` each tick and computes remaining/elapsed. `visibilitychange → visible` handlers catch up on any state that a backgrounded tick missed (e.g. the deadline passed, fire the completion path now).

**Notification API was considered and rejected** for the rest timer. On iOS PWAs:
- `new Notification(...)` only fires when the calling JS is actually running.
- iOS suspends backgrounded PWA JavaScript, so `setTimeout(notify, remainingMs)` won't fire at the deadline.
- Reliable background notifications require a service worker + Web Push (server-scheduled). That's a feature-of-its-own-scale and not warranted by a rest-timer fix.
- On `visibilitychange → visible` after a backgrounded expiration, we could call `new Notification(...)` — but by then the user is already looking at the app, and the vibrate + beep + UI dismissal are already firing. The notification adds nothing beyond a stale unread marker in Notification Center.

**How to apply:**
- If a new feature wants "tell the user something happened while they were away," it's out of scope until we take on a service-worker project. Design around the user returning to the app, not around pushing into their notification center.
- Wake Lock (`navigator.wakeLock.request('screen')`) is a valid orthogonal improvement for foreground flows (keeps the screen on during rest). Not shipped yet; revisit if screen-sleep during rest becomes annoying.

## 2026-04-19 — Gym profiles: `pendingLocationId` sentinel for pre-workout selection

The gym-profiles feature lets a user pick a gym **before** any set is logged — specifically on a plan-day tab where the `workouts` row doesn't exist yet (lazy-created on first set-done or notes-blur via `ensureWorkout`). Three states needed to be distinguishable at render and write time:

1. **User hasn't touched the dropdown** — the UI should default to `recentLocationId` (the last workout with a location tagged), and `ensureWorkout` should persist that default on INSERT.
2. **User explicitly picked "— No gym"** — the UI should show "— No gym" sticky, and `ensureWorkout` should persist `null`, not fall back to `recentLocationId`.
3. **User picked a specific gym** — UI shows it, `ensureWorkout` persists that UUID.

**Chosen encoding:** `state.pendingLocationId`, sitting alongside `state.locationId` on the workout state object. `undefined` = case 1, `null` = case 2, a UUID = case 3. `getOrInitToday` does **not** initialize this field (keeps it `undefined` by default); `persistWorkoutLocation` sets it to the user's choice; `ensureWorkout` reads `state.pendingLocationId !== undefined ? state.pendingLocationId : recentLocationId` to compute the INSERT value, then deletes the field after the row is written.

**Why this shape rather than a single field with a string sentinel:** JS `undefined` vs `null` is the exact distinction we need, and reading `x !== undefined` is clearer than introducing a magic constant like `"UNSET"`.

**How to apply:**
- Any new state factory that creates a workout-state object must leave `pendingLocationId` absent, not `null`.
- Any write path that creates a workout row (currently `ensureWorkout` and `createAdHocSession`) must compute the effective location id from `pendingLocationId` with the `recentLocationId` fallback.
- Hydrated states (`stateFromWorkout`) don't touch `pendingLocationId` — only `locationId` is populated from the DB.

## 2026-04-19 — Exercise name resolution via candidate-list matcher + alias map

Plan JSON stores exercise names as **display labels** with coaching context ("Pull-ups (BW, full ROM)", "DB Incline Bench Press (30°)", "Cable Chest Fly (mid)"), not canonical identifiers. Before this, `ensureExerciseId(planName)` and `openExerciseHistory(planName)` both keyed `exerciseLibraryByName[normName(name)]` directly — so the vast majority of plan exercises silently missed the seed library, created divergent user-custom rows on set-save, and returned "No history" on View Recent even when canonical history existed.

**Approach considered and rejected:** mutate `normName` to do heavier canonicalization (strip parens, hyphens, pluralization). Rejected because `normName` is the hash used at ~20 sites including `sets.name` inserts; changing the contract risks silent data-divergence elsewhere.

**Chosen:** a separate `resolveLibraryRow(name)` that generates candidates via **deterministic transformations** applied cumulatively, checks each against the existing `exerciseLibraryByName` map, and returns the first match or null. Never fabricates a match — only resolves to rows that already exist.

**Transformations, in order:**
1. `normName(name)` — baseline.
2. Strip trailing parenthetical: `"foo (bar)"` → `"foo"`.
3. Hyphen → space: `"pull-up"` → `"pull up"` (bidirectional coverage via library-side secondary index below).
4. Depluralize: trim `-es` / `-s` from each candidate.
5. `EXERCISE_ALIASES[candidate]` override (inline constant; additive as new plan exercises surface).

Library-side secondary hyphen index in `loadExerciseLibrary` keys seed rows both hyphenated (`"pull-up"`) and dehyphenated (`"pull up"`) so lookups either direction resolve without a `normName` contract change.

**Applied in both paths:** `ensureExerciseId` (write) calls the resolver first and reuses the canonical `exercise_id`; `openExerciseHistory` (read) calls it to locate the row to query. Fallback on resolver miss is the prior behavior — upsert a custom row under the normalized plan name — so set-save never blocks on an unknown name. Fallback rows are caught by periodic data audits, not at write time.

**How to apply:**
- Add entries to `EXERCISE_ALIASES` as new plan exercise names surface that don't resolve via the built-in transformations. Keys are raw-normalized forms; values are existing library names.
- Migrating legacy orphans (rows written under the raw-normalized name before this landed) is a separate data-cleanup task, not handled by the resolver. See `HANDOFF.md` → "Known v1 limitations → Open".

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
