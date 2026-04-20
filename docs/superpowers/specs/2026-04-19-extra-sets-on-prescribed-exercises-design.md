# Extra Sets on Prescribed Exercises — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** Allow the user to add extra sets to any prescribed exercise on an editable plan-day session. Only the user-added extras are deletable from the UI; prescribed sets stay immutable (no delete, no shift, no visual change). Follow-up item from ROADMAP.md → "UX improvements → Extra sets on prescribed exercises (add-only from plan)".

## Why

Plans specify a set count per exercise (e.g., "Pull-ups: 3 sets of 12"). Real-world training diverges — sometimes you feel strong and do a fourth set, sometimes a warm-up becomes a working set. Today the only affordance to log extras is the "+ Add exercise" flow (which creates a separate extra exercise) or a "+ Add set" button that exists only on ad-hoc sessions and on extras-exercises. A user doing a 4th set of a prescribed exercise has no clean way to record it — they either pollute the extras-exercise area or skip logging it.

The fix: a per-exercise "+ Add set" button on editable plan-day exercise cards. Added sets are flagged as extras; delete affordance applies only to them.

Server-side the schema already supports this: `sets` has nullable `prescribed_weight` / `prescribed_reps`, so extras store NULLs for prescription, retain their `exercise_id` and `exercise_order` alongside the prescribed sets, and just extend the `set_order` sequence past the prescribed count.

## Design

### UI: card layout on editable plan-day sessions

For every prescribed exercise card in `buildDay`:

1. **Prescribed sets (indices `0..prescribedCount - 1`) render unchanged.** Same inputs (weight, reps, RPE, done), same placeholders pulled from the plan, no delete button, no visual decoration. This is the "the plan is immutable from the UI" invariant.

2. **Extra sets (indices `prescribedCount..end`) render below prescribed sets in the same sets table.** Visual differentiation:
   - A 3px left border in the accent color on each extra row.
   - A small ✕ delete button aligned right on each extra row (reuses existing `.set-delete` class used by extras-exercises).
   - Set number in the label column continues the sequence — if prescribed count is 3, extras display as "Set 4", "Set 5" etc.

3. **"+ Add set" button** rendered below the last set row. Dashed-outline styling to match the existing "+ Add exercise" button aesthetic. Only rendered when `viewModeFor(di) === 'editable'`. Hidden in historical / read-only views.

4. **Ad-hoc sessions and extras-exercise cards** keep their current look and delete/add affordances. Visual consistency: the 3px accent border is newly applied to all of their sets as well (already "all-extra" conceptually); this makes the rule "a left accent means this set is an extra" universal across session types.

### State model: per-set `isExtra` flag

New optional field on the in-memory set object:

```
{ weight, reps, done, setId?, startedAt?, completedAt?, exerciseId?, isExtra? }
```

`isExtra: true` is set on every extra set; prescribed sets have the field absent. This single flag drives delete-button rendering, the left-border decoration, and the `buildSetPayload` branching.

**Population points:**

- **`addExtraSet(ei)` in `js/data.js`** — always pushes `{ isExtra: true }` regardless of whether the exercise is prescribed, an extras-exercise, or ad-hoc. Centralizes the flag in one write path.
- **`stateFromWorkout(row)` in `js/data.js`** — for each set, compute:
  ```
  isExtra =
    isAdHocWorkout  ||
    exState.isExtra ||  // extras-exercise on a plan day
    (prescribedCount > 0 && s.set_order >= prescribedCount)
  ```
  where `prescribedCount = pinnedPlan.days[row.day_index].exercises[s.exercise_order].sets.length`. Missing plan / cache-miss cases default to `false` (no plan context means we can't determine "extra" — treat as prescribed-shaped; existing behavior).

### `buildSetPayload` branching

Current code crashes for extras on prescribed exercises because `ex.sets[si]` is `undefined` when `si >= ex.sets.length`. Updated branching:

```javascript
if (todayState.isAdHoc || exState.isExtra || (exState.sets[si] && exState.sets[si].isExtra)) {
  // No prescription for this set.
  exerciseId = exState.exerciseId || exerciseIdCache[normName(plan.days[di].exercises[ei].name)];
  prescribedWeight = null;
  prescribedReps = null;
} else {
  // Existing prescribed branch — unchanged.
  var ex = plan.days[di].exercises[ei];
  var set = ex.sets[si];
  exerciseId = exerciseIdCache[normName(ex.name)];
  prescribedWeight = set.weight != null ? set.weight : null;
  prescribedReps = set.reps_target != null ? set.reps_target : null;
}
```

Extras on a prescribed exercise carry the prescribed exercise's `exerciseId` (not a separate one — this is the same movement). The only differences are null `prescribed_weight` / `prescribed_reps` and a `set_order` past the prescribed count.

### `deleteSet` guard update

Current guard rejects deletion if the exercise isn't an extra or ad-hoc. New guard also accepts per-set `isExtra`:

```javascript
var sl = exState.sets[si];
if (!sl) return;
if (!sl.isExtra && !exState.isExtra && !todayState.isAdHoc) return;
```

The rest of `deleteSet` (delete from DB, renumber higher `set_order`s) works as-is. Since the UI only renders delete buttons on `sl.isExtra` sets, in practice only extras get deleted, and renumbering shifts only other extras at higher `set_order`s. Prescribed sets are never touched.

### Render pipeline integration

`buildDay` / `buildAdHocDay` already iterate `exState.sets` to emit rows. The changes:

- Wrap each extra row in a class that applies the left-border accent (e.g., `.set-row.set-extra`). Existing `.set-row` stays unchanged.
- Render the `.set-delete` ✕ button only when `sl.isExtra === true`.
- After the last set row, if `viewModeFor(di) === 'editable'`, append a `.add-set-btn` that dispatches to `addExtraSet(ei)` via the existing event-delegation pattern on `#workoutContainer`.

No changes to `buildTabs`, rest timer, session timer, picker, or history modal.

### Edge cases

- **Plan re-import narrows sets per exercise (4 → 3).** Previously prescribed set 4 becomes extra on next hydrate (`prescribedCount` shrank to 3, `set_order = 3` now satisfies `>= 3`). Set 4 gains a delete button. Acceptable — the set genuinely is beyond the new plan shape.
- **Plan re-import widens sets per exercise (3 → 4).** A user's previously-extra set 4 becomes prescribed (`prescribedCount` grew to 4, `set_order = 3` no longer satisfies `>= 4`). Delete button disappears. The DB row's `prescribed_weight` / `prescribed_reps` stay NULL (no backfill) — the app treats absence of prescription fields as "not a prescribed set" only at write time, not at read time, so render is unaffected. Acceptable.
- **Complete-then-add-extra.** Today-completed plan day (`ended_at` set) is editable per the edit-after-completion rule. Tap "+ Add set" → state gets an extra. Tap Done on the new set → `persistSet` inserts the row; `workouts.ended_at` stays set (session remains marked complete). The new set's `completed_at` is set via the existing done-tap path.
- **Historical (past-day) session.** `viewModeFor(di) === 'historical'` → "+ Add set" button is not rendered, existing extras still render without delete buttons. Consistent with current read-only semantics.
- **Extras-exercise already on a plan day.** Unchanged; the existing per-exercise `isExtra` flag continues to mark the whole exercise as user-added.
- **Ad-hoc session.** Unchanged; every set is already delete-able via `todayState.isAdHoc`. Per-set `isExtra` is added for consistency but is redundant with the session-level check.

## Manual smoke test checklist

### Add + log extra sets
- [ ] Editable plan day with prescribed 3 sets → card shows "+ Add set" button under the last row.
- [ ] Tap "+ Add set" → a 4th empty row appears with left accent + ✕ button. Set number column reads "Set 4".
- [ ] Enter weight/reps on the new row, tap Done → row persists (`sets` row inserted with `set_order = 3`, `prescribed_weight` / `prescribed_reps` NULL, correct `exercise_id`).
- [ ] Add another extra → Set 5, same behavior.

### Visual differentiation
- [ ] Prescribed rows have no left accent, no delete button.
- [ ] Extra rows have the 3px accent left border and a ✕ delete button.
- [ ] Ad-hoc session: every set has the left accent.
- [ ] Extras-exercise (added via "+ Add exercise"): every set has the left accent.

### Delete behavior
- [ ] Tap ✕ on an extra → confirm dialog → row removes from UI + DB.
- [ ] If multiple extras exist and you delete set 4 (first extra), set 5 renumbers to 4 in the DB (set_order shifts).
- [ ] Attempting to delete a prescribed set is impossible from the UI (no ✕ rendered).

### Edit-after-completion
- [ ] Complete a session (tap Complete Session, `ended_at` set). Reopen that day on reload — edit-after-completion mode.
- [ ] "+ Add set" button still available. Add + log an extra → upserts cleanly. `workouts.ended_at` stays populated.

### Historical sessions
- [ ] Select a past plan day via the History modal (or via an old todayPlanStates entry for a different user) → "+ Add set" button is NOT rendered. Delete buttons on historical extras are NOT rendered.

### Hydrate from DB
- [ ] Reload after logging extras → state reconstructs correctly. Extra rows still have accent + delete. Prescribed rows still plain.
- [ ] Plan re-import narrows prescribed 4 → 3, reload → former set 4 now flagged as extra. Visible accent + delete.
- [ ] Plan re-import widens prescribed 3 → 4, reload → former extra set 4 now flagged as prescribed. No accent, no delete.

### Regressions
- [ ] Prescribed-set auto-fill (done-tap with empty weight/reps) still populates from plan for prescribed sets.
- [ ] Extras never auto-fill from plan (no prescription to inherit).
- [ ] RPE / exercise-level note / substitution still fan out across all sets of an exercise (prescribed + extras).
- [ ] "+ Add exercise" flow (whole-exercise extras) continues to work unchanged.
- [ ] Ad-hoc sessions render unchanged except for the new left accent on every set.

## Implementation surface summary

- **[js/data.js](../../js/data.js)** — `addExtraSet`: push `{ isExtra: true }` unconditionally. `stateFromWorkout`: compute per-set `isExtra` using plan-derived `prescribedCount`. `buildSetPayload`: branch on session-ad-hoc OR exercise-extra OR per-set-extra. `deleteSet`: relax guard to accept per-set `isExtra`.
- **[js/ui.js](../../js/ui.js)** — `buildDay` / `buildAdHocDay`: render `.set-extra` class on rows where `sl.isExtra === true`; render `.set-delete` only on those rows; append `.add-set-btn` on editable plan-day exercise cards; wire the button through the existing `#workoutContainer` click delegate to call `addExtraSet(ei)`.
- **[index.html](../../index.html)** — new CSS for `.set-row.set-extra` (left-border accent) and `.add-set-btn` (dashed outline, full-width of the sets table). No new DOM templates — markup is generated in `buildDay`.
- **No SQL migration.** No schema changes.

## Non-goals

- Reordering prescribed sets.
- Deleting prescribed sets.
- Adding a delete affordance to ad-hoc session sets that doesn't already exist (they already have it via `todayState.isAdHoc`).
- Auto-prefilling extras from prescribed values (they have no prescription — they're whatever the user types).
- Visual changes to rest timer, session timer, picker, history modal, or hamburger.
- The kg/lbs unit toggle (separate spec — tabled).
