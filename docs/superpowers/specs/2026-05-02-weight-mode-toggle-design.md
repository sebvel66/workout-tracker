# Per-workout-instance weight-mode toggle — design

**Date:** 2026-05-02
**Target version:** v3.1.0
**Status:** approved, ready for implementation plan

## Problem

The same exercise name can map to different machines at different gyms. Hammer Strength Incline Chest Press is plate-loaded (per-side) at one location and pulley-driven (total) at another. Today, an exercise's `weight_mode` is fixed in the library, so the user can't tell the app "today's weight is per-side" without permanently changing the exercise.

The schema already supports `weight_mode` on `exercises` (`'total' | 'per_side' | 'bodyweight' | 'none'`) and the existing UI / volume math / CSV export already respect it. The gap is **how the user overrides it for a single workout**.

## Goal

Let the user flip the weight-mode interpretation for one exercise placement in one workout, without editing the library and without per-set granularity. Out of scope: location-aware overrides, propagation back to the library, per-set toggles.

## UX

Each exercise card gets a small chip in its header next to the existing **"view recent"** button. The chip reads "Total" or "Per side" and reflects the *effective* weight mode. Tap the chip → toggles the override → re-renders the card so:

- The "per side" hint under the weight input appears or disappears.
- The volume math (used in coach context, history, charts, CSV) re-resolves.

Chip visibility:

- Shown only when the effective mode is `total` or `per_side` — i.e. resistance exercises.
- Hidden for `bodyweight`, `none`, and cardio rows (rows where `muscle_group === 'cardio'`).

Where the chip lives:

- **Editable session view** (today's plan day, ad-hoc session): tap toggles and writes immediately.
- **Historical edit view** (the v3.0.3 surface that lets the user revise sets/RPE/notes after the fact): same chip, same behavior. This lets the user correct sessions logged before the toggle existed.
- **Read-only history detail modal:** chip is rendered as a static label (no tap-to-toggle), so historical sessions show what was actually logged.

No prompt, no confirm, no "remember as default" propagation. Toggling is reversible by tapping again.

## Schema

One additive migration:

```sql
-- 20260502000000_set_weight_mode_override.sql
alter table sets
  add column weight_mode text
    check (weight_mode in ('total', 'per_side'));
```

Semantics:

- `NULL` → inherit from `exercises.weight_mode` (current behavior). Every existing row defaults to NULL on migration, so nothing changes for existing data.
- `'total'` or `'per_side'` → override.

Why on `sets` (not a new `workout_exercises` table): the rest of the app already treats `(workout_id, exercise_id, exercise_order)` as the implicit join key for an exercise placement. Adding a table now would force a wider refactor and only saves a few bytes per set. The redundancy is acceptable.

The check constraint deliberately excludes `'bodyweight'` and `'none'` — those are properties of the exercise itself, not something a user would override per workout.

## Data flow

The toggle stamps the override on **every set in the placement** in one batched upsert:

1. User taps chip on exercise card.
2. UI flips local state's effective weight mode for that placement and re-renders.
3. Persistence writes `sets.weight_mode = <new value>` for every set whose `(workout_id, exercise_order)` matches the placement (including any extra sets and drop sets).
4. Future sets added to the placement during the same session inherit the placement's current effective mode at insert time.

This gives the resolver a simple rule: **read the override off any set in the placement**; they are kept in sync by every write path.

## Resolver changes

One helper, added to `js/resolver.js`:

```js
function effectiveWeightMode(set, exerciseMeta) {
  if (set && set.weight_mode) return set.weight_mode;
  return (exerciseMeta && exerciseMeta.weight_mode) || 'total';
}
```

Replaces the existing `meta.weight_mode || 'total'` lookups at:

- `js/ui.js:267` (per-side hint in `renderSetRow`)
- `js/ui.js:527` (substitution path)
- `js/ui.js:667, 778, 1947, 1970, 1983` (exercise card render across plan / extras / ad-hoc / history)
- `js/ui.js:3207` (history value formatter)
- `js/ui.js:3955, 4105` (swap snapshot, restore)
- `js/data.js:760` (volume math: `mode === 'per_side'` → `weight × 2 × reps`)
- `js/ui.js:5640` (CSV export row)

The function takes both `set` and `exerciseMeta` so callers without a specific set in scope (e.g. card-level decisions about whether to show the chip) can still derive the effective mode from any one set in the placement.

## State stamping

Where the in-memory `state.exercises[ek].sets[i]` objects are constructed — `stateFromWorkout` and the ad-hoc/extras paths — the per-set `weight_mode` field is plumbed through from the DB row so `effectiveWeightMode` can read it without a re-fetch.

When the user toggles the chip:

- Local state: every set in the placement gets `set.weight_mode = newMode`.
- DB: a single `update sets set weight_mode = $1 where workout_id = $2 and exercise_order = $3` covers all sets, done or not.

When a new set is added to the placement (`+ Add Set`, `+ Drop Set`, or extra-set on a prescribed exercise), the new row is inserted with `weight_mode = <placement's current set.weight_mode value>` — i.e. NULL if the user has never toggled the chip, or the explicit value if they have. This keeps every set in the placement in sync.

## Plan-author intent

The AI planner's `prescribed_weight` is interpreted in the **library default** mode. If the planner prescribes 100 lb on a `total`-default exercise and the user toggles per-side at execution time, the user enters their per-side load (e.g. 50) and volume math doubles it back to 100 — matching the planner's intent. No changes to the planner prompt or the analyze API.

## CSV export

Export already includes a `weight_mode` column. Switch it to read the effective mode (`effectiveWeightMode(set, exerciseMeta)`) so an exported per-side override is visible.

## What does **not** change

- Volume math itself (`× 2` for per-side) is already correct in `js/data.js:635-760`.
- The "per side" hint in `renderSetRow` already exists at `js/ui.js:267`.
- Custom-exercise creation (`cfWeightMode` form field) is unchanged.
- AI planner / analyze API / coach context.

## Testing checklist (smoke)

- Plan day: toggle per-side on Hammer Strength Incline → "per side" hint appears, volume in coach context doubles, persists across reload.
- Ad-hoc session: same as above on a freshly-added exercise.
- Add set after toggling → new set inherits the override.
- Drop set after toggling → drop sets inherit the override.
- Toggle back to original → chip returns to its starting label and the override is stored verbatim (`'total'` or `'per_side'`), not cleared to NULL. **Why store verbatim instead of clearing:** the chip is stable and predictable — tapping twice gives the same result regardless of any later library-default changes — and the resolver logic stays a single conditional on `set.weight_mode`. Cost is one extra non-NULL value per toggled placement, which is negligible.
- Historical edit view: toggle on an old session → volume in subsequent renders updates.
- Read-only history modal: chip renders as static label, no tap.
- CSV export: per-side override appears in the `weight_mode` column.
- Bodyweight / cardio rows: chip not rendered.

## Migration safety

Pure additive column with a check constraint, defaults to NULL. No backfill needed. Existing analyze / coach / history queries (`select '*, sets(*, exercises!exercise_id(...))'`) continue to work; new column is silently included via `*`.

## Open questions

None blocking. All pre-implementation decisions resolved during brainstorming.
