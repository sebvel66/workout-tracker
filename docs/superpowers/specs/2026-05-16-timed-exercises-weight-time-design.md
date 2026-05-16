# Time-based exercises: weight + time + hold timer

**Date:** 2026-05-16
**Status:** Approved, building

## Problem

Isometric / hold exercises (plank, dead hang, wall sit, side plank,
hollow hold, copenhagen plank) are tagged `movement_pattern =
'isometric'` but the app prescribes and logs them as **reps + weight**.
There's no way to record a hold duration and no timer to help. The user
wants these to be **weight + time**, with a count-up timer.

## Decisions (from brainstorming)

- Detection: **auto** when `movement_pattern === 'isometric'`, plus a
  **per-user manual override** so any exercise can be forced timed / not
  timed.
- Timer: **count-up, manual stop**. Stop writes elapsed seconds to the
  set's time and marks it done (same post-set behavior as the done
  button, including the rest timer).
- AI planner: **prescribe a duration** for isometric/timed exercises
  instead of reps.
- Override surfaced as a **chip on the exercise card**, next to the
  weight-mode chip.

## Design

### 1. Detection + storage

New table `exercise_prefs (user_id uuid, exercise_id uuid, timed
boolean not null, primary key (user_id, exercise_id))`, RLS to
`auth.uid() = user_id` (mirror existing per-user tables). Per-user so
toggling a shared seed exercise never affects other users.

Migration file under `supabase/migrations/`. **Must be applied to the
hosted Supabase DB on deploy** — flagged in the final summary; the
agent cannot apply it.

`loadExerciseLibrary()` also loads the user's `exercise_prefs` into
`exercisePrefsById = { exercise_id: boolean }`. Resolver in `js/data.js`:

```
function isTimedExercise(meta) {
  if (!meta) return false;
  if (meta.muscle_group === 'cardio') return false;      // cardio path wins
  var ov = meta.id != null ? exercisePrefsById[meta.id] : undefined;
  if (ov === true || ov === false) return ov;
  return meta.movement_pattern === 'isometric';
}
```

### 2. Set-row shape (`renderSetRow`, `js/ui.js`)

Add an `isTimed` parameter (after `isCardio`). Branch order: cardio →
timed → resistance. The timed branch reuses the resistance weight
input verbatim (driven by `weightMode`: `none` → no weight field;
`bodyweight` → "ADD WT"; else LBS/KG) and replaces the REPS input with
a **TIME** input — `type=text`, `inputmode`, `data-field="duration_seconds"`,
value `formatDurationMSS(sl.duration_seconds)`, placeholder from
`prescribedSet.duration_seconds` (reuse the exact cardio duration
input markup). It also emits a per-row **▶ Time** button
(`data-hold-di/-ei/-si`), hidden when `disabledAttr` is set
(history-readonly).

`logSet` already parses `duration_seconds` via `parseDurationMSS`, and
`buildSetPayload` / `stateFromWorkout` already round-trip
`duration_seconds`. No persistence change needed for the value itself.

All 7 `renderSetRow` call sites compute `isTimed` from the row's meta
via `isTimedExercise(meta)` (parallel to the existing `isCardioRow`),
passing `false` where cardio is already true.

### 3. Hold timer (count-up)

A second floating pill `#holdTimer` in `index.html`, reusing the
rest-timer pill CSS (own id, count-up). State in `js/ui.js`:
`holdStartMs`, `holdInterval`, `holdTarget = {di,ei,si}`. ▶ Time →
`startHoldTimer(di,ei,si)`: show pill, tick every 250ms showing
`fmtElapsed(Date.now()-holdStartMs)`. Stop → `stopHoldTimer()`: compute
elapsed whole seconds, set the set's `duration_seconds`, then route
through the normal done path — set the in-memory value and call
`toggleSet(di,ei,si)` if not already done (this persists, fires the
rest timer, and rebuilds the day exactly like tapping the check). If
already done, set value + `persistSet` + `buildDay`. Manual typing of
the TIME field still works (unchanged `logSet`). No target chime (pure
count-up).

Hold timer and rest timer are independent phases; stopping the hold
naturally triggers the rest timer through `toggleSet`.

### 4. Override chip (`renderWeightModeChip` sibling)

New `renderTimedChip(ei, isTimed, meta, ctx)` rendering a `timed` /
`reps` chip, shown for non-cardio exercises, placed next to the
weight-mode chip in the card header (live + ad-hoc + extras; readonly
label in history). Click (`data-toggle-timed-ei`) resolves the
exercise id (exerciseMeta or library-by-name for plan rows), upserts
`exercise_prefs` (`timed = !current`), updates `exercisePrefsById`,
re-renders the day. Visual cue (e.g. a dot/italic) when the value is an
explicit override vs the isometric default.

### 5. AI planner

`system-prompt-plan.md` and the `SWAP_SYSTEM_PROMPT` in
`api/generate-plan.js` get an isometric rule paralleling the existing
cardio rule: when an exercise's `movement_pattern` is `isometric`,
prescribe `duration_seconds` per set (and keep `weight` only if
`weight_mode != 'none'`), **omit** `reps_target` / `reps_range`. The
`repeat:N` shorthand still applies. `fmtP()` already renders
`duration_seconds`, so prescribed targets ("plank 3 × 0:45") display
with no further change.

### 6. History / backward-compat

Old isometric sets were logged as reps. In the **history** render path
only, treat a set as timed only when `sl.duration_seconds != null`
(else fall back to resistance so a historical rep-logged plank still
shows its reps). Live/ad-hoc paths use `isTimedExercise(meta)` directly.
This mirrors the existing cardio pre-feature fallback.

## Verification

- `node --check` on changed JS.
- Node unit test of `isTimedExercise`: isometric → true; cardio → false
  (even with a stray pref); explicit pref true/false overrides the
  movement_pattern default; non-isometric with no pref → false.
- Node string test of the `renderSetRow` timed branch: emits a
  `data-field="duration_seconds"` input and a hold button, no REPS
  input; respects `weightMode='none'` (no weight input) vs `bodyweight`
  ("ADD WT").
- Manual browser pass: plank logs time, hold timer captures elapsed and
  marks done + starts rest; chip flips a non-isometric exercise to
  timed and back; a new generated plan prescribes plank with a duration.

## Scope

`supabase/migrations/` (new `exercise_prefs` table — manual apply on
deploy). `js/data.js` (prefs load/cache, `isTimedExercise`, hold-timer
helpers may live here or ui.js, upsert helper). `js/ui.js` (timed
branch in `renderSetRow` + 7 call sites, `renderTimedChip`, chip toggle
handler, hold-timer pill handlers, history fallback). `index.html`
(hold-timer pill markup + CSS, chip CSS). `system-prompt-plan.md` +
`api/generate-plan.js` (prompts). `APP_VERSION` patch bump. No change
to volume math (a timed set still counts as one set). Commit; do not
push without approval.
