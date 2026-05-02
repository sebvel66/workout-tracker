# Per-workout weight-mode toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-exercise-card chip that overrides `weight_mode` (Total ↔ Per side) for one workout placement, without editing the library and without per-set granularity. Solves the "same exercise, different machine at a different gym" case (e.g. Hammer Strength Incline Press: plate-loaded at gym A, cable at gym B).

**Architecture:** One additive nullable column `sets.weight_mode` (`'total' | 'per_side'`). NULL = inherit from `exercises.weight_mode`. The toggle stamps every set in the placement via a single `(workout_id, exercise_order)` fan-out — same pattern `updateExerciseFanOut` and `historyUpdateExerciseRpe` already use. A new `effectiveWeightMode(set, exerciseMeta)` helper centralizes the "override-or-default" resolution, replacing ~10 sites that currently do `meta.weight_mode || 'total'` directly. Volume math (`× 2` for per-side) and the "per side" hint already exist; they just start reading effective mode.

**Tech Stack:** Plain JS (no build step), Supabase JS client (`sb`), Supabase migrations CLI. No automated tests — verification is manual browser smoke testing per project convention (`HANDOFF.md`).

**Spec:** [docs/superpowers/specs/2026-05-02-weight-mode-toggle-design.md](../specs/2026-05-02-weight-mode-toggle-design.md)

**Version target:** **`v3.1.0`** (first feature on top of v3.0.x — minor bump per the user's versioning convention: minor for new features, patches for follow-ups within a minor). The bump is the final task.

**Workflow rules (from project conventions):**
- Hard-reload the browser between JS edits and smoke-test before committing each task.
- Small, focused commits per task.
- Bump `APP_VERSION` only on the final task (one user-visible release covers the whole feature).
- **Never push.** Commits stay local until the user explicitly approves a push.

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/20260502010000_set_weight_mode_override.sql` | **NEW** — additive nullable column with check constraint. |
| `js/resolver.js` | **NEW function** `effectiveWeightMode(set, exerciseMeta)` at end of file. |
| `js/data.js` | `stateFromWorkout` (~351-368) — plumb `s.weight_mode` into `sl.weight_mode`. `buildSetPayload` (~1386-1412) — include `weight_mode: sl.weight_mode || null`. **NEW** `setExerciseWeightMode(di, ei, mode)` after `updateExerciseFanOut` (~1490). **NEW** `historyUpdateExerciseWeightMode(workoutId, exerciseOrder, mode)` after `historyUpdateExerciseNote` (~2113). Volume math (~755-770) — read effective mode per set instead of per-exercise. New-set helpers `addExtraSet` (~1828), `addDropSet` (~1860 area), `addExerciseToSession` (~1763) — pre-populate `weight_mode` from the placement's existing sets. |
| `js/ui.js` | Replace ~10 `meta.weight_mode \|\| 'total'` lookups with `effectiveWeightMode(...)`. Render chip in three card paths (plan-day prescribed `~542`, plan-day extras `~682`, ad-hoc `~793`, history `~2176`). Wire click delegator for chip taps in editable / ad-hoc / history-edit contexts. CSV export (`~5640`) reads effective mode. Swap snapshot (`~3955`, `~4105`) preserves the override. |
| `index.html` | Add CSS for `.weight-mode-chip` near `.ex-history-btn` (~1772). |
| `js/app.js` | Bump `APP_VERSION` from `v3.0.3` → `v3.1.0` (final task). |

---

### Task 1: Migration — add nullable `weight_mode` column on sets

Pure schema change. NULL on every existing row (no backfill needed). Check constraint excludes `'bodyweight'` and `'none'` — those are exercise-level properties, not user-toggleable per workout.

**Files:**
- Create: `supabase/migrations/20260502010000_set_weight_mode_override.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Per-workout-instance weight-mode override.
--
-- Each set may carry an optional weight_mode override that wins over the
-- library default in `exercises.weight_mode`. NULL means "inherit from
-- the exercise's library default" (current behavior — every existing row
-- is NULL after this migration).
--
-- The override is deliberately limited to the two interpretations a user
-- might toggle at runtime: 'total' vs 'per_side'. 'bodyweight' and 'none'
-- are intrinsic to the exercise and are not user-toggleable per workout,
-- so they're excluded from the check constraint.
--
-- The toggle in the UI stamps the same value on every set in a placement
-- via UPDATE sets SET weight_mode = $1 WHERE workout_id = $2 AND
-- exercise_order = $3, mirroring the fan-out pattern used by
-- updateExerciseFanOut and historyUpdateExerciseRpe.

alter table sets
  add column weight_mode text
    check (weight_mode in ('total', 'per_side'));
```

- [ ] **Step 2: Apply the migration**

Run:
```bash
cd /Users/sebastianvelez/workout-tracker
npx supabase db push
```

Expected: migration applies cleanly with no errors. Existing rows: NULL.

- [ ] **Step 3: Verify column exists**

Run:
```bash
npx supabase db remote --execute "select column_name, is_nullable, data_type from information_schema.columns where table_name = 'sets' and column_name = 'weight_mode';"
```

Expected: one row, `is_nullable = YES`, `data_type = text`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260502010000_set_weight_mode_override.sql
git commit -m "$(cat <<'EOF'
feat(schema): add nullable sets.weight_mode override (v3.1.0 prep)

Additive column. NULL = inherit from exercises.weight_mode.
Check constraint restricts override to 'total' | 'per_side'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Resolver helper + state plumbing

Add `effectiveWeightMode` helper, plumb the new column through `stateFromWorkout` and `buildSetPayload` so it round-trips DB ↔ memory before any UI lands. After this task, override values **persist** across reloads, but no UI surface exposes them yet.

**Files:**
- Modify: `js/resolver.js` — append helper at end (currently ends at line 70).
- Modify: `js/data.js` — `stateFromWorkout` (~351-368), `buildSetPayload` (~1386-1412).

- [ ] **Step 1: Add `effectiveWeightMode` to `js/resolver.js`**

Append at the end of `js/resolver.js` (after the closing `}` of `resolveLibraryRow` at line 70):

```js

// Resolve the effective weight_mode for a set: per-set override wins over
// the exercise's library default. Used wherever we previously read
// `exerciseMeta.weight_mode || 'total'`.
//
// `set` may be missing/null when the caller is making a card-level decision
// before any set is in scope — in that case, only the exerciseMeta default
// is consulted.
function effectiveWeightMode(set, exerciseMeta) {
  if (set && set.weight_mode) return set.weight_mode;
  return (exerciseMeta && exerciseMeta.weight_mode) || 'total';
}
```

- [ ] **Step 2: Plumb `weight_mode` into `stateFromWorkout`**

In `js/data.js`, modify the in-memory set object literal at ~351-368. Find the existing block:

```js
    state.exercises[ek].sets[s.set_order] = {
      setId: s.id, weight: s.weight, reps: s.reps, done: !!s.done,
      // exerciseId = what actually happened (substitute if subbed).
      // prescribedExerciseId (optional) = what the plan asked for when this
      // set was a plan-day set. Null for ad-hoc/extras; also null on legacy
      // rows inserted before the v2.2.1 migration backfill.
      exerciseId: s.exercise_id,
      prescribedExerciseId: s.prescribed_exercise_id || null,
      // Cardio columns (v2.5 Phase 1). Null on resistance rows.
      duration_seconds: s.duration_seconds != null ? s.duration_seconds : null,
      distance: s.distance != null ? s.distance : null,
      // Drop set chains (v2.5 Phase 1). setType='drop' rows link to a
      // parent via parent_set_id (UUID); we resolve to parentSetIdx
      // (array index in this exercise's sets[]) below after the loop.
      setType: s.set_type || 'standard',
      parentSetId: s.parent_set_id || null,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
```

Add a `weight_mode` field after `parentSetId`:

```js
    state.exercises[ek].sets[s.set_order] = {
      setId: s.id, weight: s.weight, reps: s.reps, done: !!s.done,
      // exerciseId = what actually happened (substitute if subbed).
      // prescribedExerciseId (optional) = what the plan asked for when this
      // set was a plan-day set. Null for ad-hoc/extras; also null on legacy
      // rows inserted before the v2.2.1 migration backfill.
      exerciseId: s.exercise_id,
      prescribedExerciseId: s.prescribed_exercise_id || null,
      // Cardio columns (v2.5 Phase 1). Null on resistance rows.
      duration_seconds: s.duration_seconds != null ? s.duration_seconds : null,
      distance: s.distance != null ? s.distance : null,
      // Drop set chains (v2.5 Phase 1). setType='drop' rows link to a
      // parent via parent_set_id (UUID); we resolve to parentSetIdx
      // (array index in this exercise's sets[]) below after the loop.
      setType: s.set_type || 'standard',
      parentSetId: s.parent_set_id || null,
      // Per-set weight_mode override (v3.1.0). Null = inherit from the
      // exercise's library default. effectiveWeightMode(set, meta) is the
      // single read site.
      weight_mode: s.weight_mode || null,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
```

- [ ] **Step 3: Plumb `weight_mode` into `buildSetPayload`**

In `js/data.js`, modify the return object at ~1386. Find:

```js
    set_type: setType,
    parent_set_id: parentSetId,
    // Legacy free-text column — we no longer populate it on new writes;
    // substitution is now carried structurally via exercise_id mismatch.
    substitution: null,
    note: exState.note || null,
```

Add a `weight_mode` line after `parent_set_id`:

```js
    set_type: setType,
    parent_set_id: parentSetId,
    // Per-set weight_mode override (v3.1.0). Null = inherit library default.
    // Stamped by setExerciseWeightMode (today/ad-hoc) or
    // historyUpdateExerciseWeightMode; new sets inherit from existing
    // placement sets via the add-set helpers.
    weight_mode: sl.weight_mode || null,
    // Legacy free-text column — we no longer populate it on new writes;
    // substitution is now carried structurally via exercise_id mismatch.
    substitution: null,
    note: exState.note || null,
```

- [ ] **Step 4: Smoke-verify the round-trip**

Hard-reload the app. Open DevTools console. Verify:
1. `typeof effectiveWeightMode === 'function'` → `true`.
2. Hydrate completes without errors. `todayState.exercises['ex_0'].sets[0]` (or any in-progress session set) contains a `weight_mode` field (likely `null` for all existing rows).

There's no user-visible change yet — this task only ensures the value plumbs end-to-end.

- [ ] **Step 5: Commit**

```bash
git add js/resolver.js js/data.js
git commit -m "$(cat <<'EOF'
feat(weight-mode): plumb sets.weight_mode through state + payload

Adds resolver.effectiveWeightMode and threads weight_mode into
stateFromWorkout / buildSetPayload so the override round-trips
DB <-> memory ahead of the UI work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Replace direct `meta.weight_mode` reads with `effectiveWeightMode`

Center every "what's the weight mode for this set" lookup on the new helper. After this task, the override **affects rendering** for any set that already has a non-NULL value (currently none, but this prepares for the chip writes).

**Files:**
- Modify: `js/ui.js` — ~10 sites enumerated below.
- Modify: `js/data.js` — volume math at ~755-770.

- [ ] **Step 1: Update `renderSetRow` callers (plan day prescribed)**

In `js/ui.js` near line 525-528, find the substitute-aware lookup:

```js
    // a per_side substitute for a total prescribed exercise needs the
    // substitute's mode, not the prescribed exercise's. (See ARCHITECTURE.md
    // 2026-04-19 — substitution may pivot weight mode.)
    var weightMode = (exState.subExercise && exState.subExercise.weight_mode)
      ? exState.subExercise.weight_mode
      : (exState.exerciseMeta && exState.exerciseMeta.weight_mode) || 'total';
```

Replace with a per-set effective lookup. The substitute's library row becomes the `exerciseMeta` argument when present:

```js
    // a per_side substitute for a total prescribed exercise needs the
    // substitute's mode, not the prescribed exercise's. (See ARCHITECTURE.md
    // 2026-04-19 — substitution may pivot weight mode.) Per-set override
    // (v3.1.0) wins over both.
    var subMeta = exState.subExercise || exState.exerciseMeta;
    var weightMode = effectiveWeightMode(exState.sets[si], subMeta);
```

Note: the `weightMode` variable inside `renderSetRow` is currently passed in as a parameter; the substitute-aware logic above is in the **caller**. The fix above is for the caller. `renderSetRow` itself receives `weightMode` already-resolved — leave its signature alone.

- [ ] **Step 2: Update plan-day extras card render (~666-667)**

Find:

```js
    var xMeta = xState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    var xWeightMode = xMeta.weight_mode || 'total';
```

Replace with:

```js
    var xMeta = xState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    // effectiveWeightMode reads the per-set override; passing sets[0] is
    // valid because every set in a placement carries the same value (the
    // toggle fan-out keeps them in sync).
    var xWeightMode = effectiveWeightMode(xState.sets[0], xMeta);
```

Then in the per-set render loop (~692), pass the per-set effective mode instead of the placement-level one:

Find:
```js
      h += renderSetRow(di, xei, xsi2, xsl, null, xWeightMode, dis, '—', !readOnly, xIsCardio, xLabelNum);
```

Replace with:
```js
      h += renderSetRow(di, xei, xsi2, xsl, null, effectiveWeightMode(xsl, xMeta), dis, '—', !readOnly, xIsCardio, xLabelNum);
```

(The card-level `xWeightMode` is still used for the chip render decision in Task 4; keep it.)

- [ ] **Step 3: Update ad-hoc card render (~777-778)**

Find:
```js
    var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    var weightMode = meta.weight_mode || 'total';
```

Replace with:
```js
    var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
    var weightMode = effectiveWeightMode(exState.sets[0], meta);
```

In the per-set render loop for ad-hoc, find the `renderSetRow` call (search for `renderSetRow(di, ei,` in this function) and pass per-set effective mode the same way as Step 2.

- [ ] **Step 4: Update history card renders (~1947, ~1970, ~1983)**

Three near-identical sites. Each currently does:
```js
      var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
      h += renderHistoryExerciseCard(ei, exState, meta.name, meta.weight_mode || 'total', null);
```

Change the third argument by reading effective mode from the placement's first set:

```js
      var meta = exState.exerciseMeta || { name: 'Exercise', weight_mode: 'total' };
      h += renderHistoryExerciseCard(ei, exState, meta.name, effectiveWeightMode(exState.sets[0], meta), null);
```

Apply at all three sites (search the file for `renderHistoryExerciseCard(` and update each call).

Inside `renderHistoryExerciseCard` itself (around the `renderSetRow` call at line ~2188), update so each set passes its own effective mode:

Find:
```js
    h += renderSetRow('history', ei, si, sl, prescribed, weightMode, disabledAttr, prText, false, isCardioRow, histLabelNum);
```

Replace with:
```js
    // weightMode is the placement-level effective mode (used for the chip);
    // each set still consults its own override via effectiveWeightMode in
    // case mid-placement override stamping ever lands in a future feature.
    h += renderSetRow('history', ei, si, sl, prescribed, effectiveWeightMode(sl, exState.exerciseMeta), disabledAttr, prText, false, isCardioRow, histLabelNum);
```

- [ ] **Step 5: Update history value formatter (~3207)**

Find (the function is `formatHistoricalSetValue` or near it — search for `if (mode === 'per_side') return val + ' ' + unit + '/ea';`):

```js
    if (mode === 'per_side') return val + ' ' + unit + '/ea';
```

This site receives `mode` as a parameter. Trace its callers (likely 1-2 sites in `renderHistoryDetail` neighborhood). Update each caller to pass `effectiveWeightMode(set, exerciseMeta)` instead of `meta.weight_mode || 'total'`.

Run:
```bash
grep -n "if (mode === 'per_side')" js/ui.js
```

Then for each caller of that function, ensure `mode` is sourced from `effectiveWeightMode`. If only one caller passes the placement-level mode, no change is needed beyond the upstream sites already updated in Steps 2-4.

- [ ] **Step 6: Update volume math in `js/data.js` (~755-770)**

Find:
```js
    var mode = ex.weight_mode || 'total';
```

(Search the file for that exact line — it's inside the volume calculation loop.) Replace with a per-set lookup. The surrounding loop iterates over each `set` row; pass that:

```js
    // Per-set effective mode (v3.1.0): override on the set wins over
    // ex.weight_mode (the exercise's library default). Same math otherwise.
    var mode = effectiveWeightMode(set, ex);
```

(Variable names depend on the surrounding loop. Adjust to match: if the loop variable for the row is named `s`, use `effectiveWeightMode(s, ex)`.)

- [ ] **Step 7: Smoke test**

Hard-reload. Open today's session. Verify:
1. Existing weight-mode behavior is unchanged: a `per_side` library exercise still shows the "per side" hint; a `total` exercise doesn't.
2. Coach context (open coach → check the volume numbers in the system message DevTools log) is unchanged.
3. History detail modal renders the same as before.

There's still no user-facing change yet — this task is plumbing.

- [ ] **Step 8: Commit**

```bash
git add js/ui.js js/data.js
git commit -m "$(cat <<'EOF'
refactor(weight-mode): route weight_mode reads through effectiveWeightMode

Replaces ~10 direct meta.weight_mode lookups (render paths, volume math,
history formatter) with the new resolver helper so per-set overrides
will be respected once the chip lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Editable-context fan-out helper + add-set inheritance

Add the data-layer helper that the editable chip calls. Mirrors `updateExerciseFanOut` exactly. Also update the three add-set helpers so newly added sets inherit the placement's current override.

**Files:**
- Modify: `js/data.js` — new `setExerciseWeightMode` after `updateExerciseFanOut` (~1490). Update `addExtraSet` (~1828), `addDropSet` (search for `addDropSet`), `addExerciseToSession` (~1763).

- [ ] **Step 1: Add `setExerciseWeightMode` after `updateExerciseFanOut`**

In `js/data.js`, insert directly after the closing `}` of `updateExerciseFanOut` (~line 1489), before the `// ---- User-action handlers ----` comment block:

```js

// Stamp a weight_mode override on every set in an exercise placement.
// Mirrors updateExerciseFanOut: single UPDATE keyed on (workout_id,
// exercise_order). Used by the per-card weight-mode chip in editable
// today + ad-hoc contexts.
//
// `mode` is 'total' or 'per_side' verbatim — we deliberately don't store
// NULL when the user toggles back to the library default, because that
// would make the chip's behavior depend on whether the library default
// has changed since the toggle. See spec §"What stays stored when the
// user toggles back to original" for the reasoning.
async function setExerciseWeightMode(di, ei, mode) {
  if (!todayState || !todayState.workoutId) {
    // Not yet persisted — update memory only. The first persistSet write
    // will pick up sl.weight_mode via buildSetPayload.
    var exMem = todayState && todayState.exercises['ex_' + ei];
    if (exMem) {
      for (var i = 0; i < exMem.sets.length; i++) {
        if (exMem.sets[i]) exMem.sets[i].weight_mode = mode;
      }
    }
    return;
  }
  var exState = todayState.exercises['ex_' + ei];
  if (!exState) return;
  try {
    var r = await sb.from('sets')
      .update({ weight_mode: mode })
      .eq('user_id', userId)
      .eq('workout_id', todayState.workoutId)
      .eq('exercise_order', ei);
    if (r.error) throw r.error;
    // Mirror to in-memory sets so renders + buildSetPayload (for any
    // subsequent UPDATE) see the new value without a re-fetch.
    for (var j = 0; j < exState.sets.length; j++) {
      if (exState.sets[j]) exState.sets[j].weight_mode = mode;
    }
  } catch(err) {
    console.error('setExerciseWeightMode error:', err);
    showToast("Weight mode didn't save", function() { setExerciseWeightMode(di, ei, mode); });
  }
}
```

- [ ] **Step 2: Make `addExtraSet` inherit the placement's override**

Find `function addExtraSet(ei)` near line 1828. Locate where the new set object is pushed (`exState.sets.push(newSet);` at ~1860). Just before that push, copy the placement's current weight_mode onto the new set:

```js
  // Inherit the placement's current weight_mode (v3.1.0). New sets in a
  // toggled placement should carry the same override so renders + volume
  // math + persistence are consistent.
  newSet.weight_mode = (exState.sets[0] && exState.sets[0].weight_mode) || null;
  exState.sets.push(newSet);
```

- [ ] **Step 3: Make `addDropSet` inherit the placement's override**

Find the function via:
```bash
grep -n "function addDropSet\b" js/data.js
```

Locate the equivalent push (`exState.sets.push(newSet);` at ~1933). Apply the same one-line inheritance just before the push.

- [ ] **Step 4: Make `addExerciseToSession` inherit nothing (new placement)**

`addExerciseToSession` (~1763) creates a brand-new placement — there are no prior sets to inherit from. The `weight_mode` field on its initial sets stays `null`/`undefined`. `effectiveWeightMode` falls back to the library default. **No change needed**, but confirm by reading the function and verifying initial sets are constructed without an explicit `weight_mode`.

- [ ] **Step 5: Smoke test**

Hard-reload. Open today's session. In DevTools console:

```js
// Pick any exercise placement that's already persisted (has setIds).
await setExerciseWeightMode(0, 0, 'per_side');
todayState.exercises['ex_0'].sets.map(s => s && s.weight_mode);
// Expected: array of 'per_side' strings.
```

Then in the Supabase Studio (or via psql), verify:
```sql
select set_order, weight_mode from sets
  where workout_id = '<that workout id>' and exercise_order = 0;
```
Expected: every row has `weight_mode = 'per_side'`.

Reset for sanity:
```js
await setExerciseWeightMode(0, 0, 'total');
```

- [ ] **Step 6: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
feat(weight-mode): editable-context fan-out + add-set inheritance

setExerciseWeightMode mirrors updateExerciseFanOut: single UPDATE keyed
on (workout_id, exercise_order), then in-memory mirror. addExtraSet /
addDropSet inherit the placement's current weight_mode so newly added
sets stay in sync with a toggled placement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: History-edit fan-out helper

Mirror of Task 4 for the historical-edit context. Direct DB-only pattern, no `todayState`. Mirrors `historyUpdateExerciseRpe` exactly.

**Files:**
- Modify: `js/data.js` — insert after `historyUpdateExerciseNote` (~2113).

- [ ] **Step 1: Add `historyUpdateExerciseWeightMode`**

Insert directly after the closing `}` of `historyUpdateExerciseNote`:

```js

// History-edit equivalent of setExerciseWeightMode. Same fan-out pattern
// as historyUpdateExerciseRpe: UPDATE all sets in (workout_id, exercise_order).
// Caller is responsible for patching historyDetails[workoutId] in-memory
// so re-render reflects the change.
async function historyUpdateExerciseWeightMode(workoutId, exerciseOrder, mode) {
  if (!userId || !workoutId) throw new Error('Missing context');
  var r = await sb.from('sets')
    .update({ weight_mode: mode })
    .eq('user_id', userId)
    .eq('workout_id', workoutId)
    .eq('exercise_order', exerciseOrder);
  if (r.error) throw new Error(r.error.message);
}
```

- [ ] **Step 2: Smoke test**

Hard-reload. Open History → tap any historical session → tap **Edit**. In DevTools console:

```js
// Replace with a real workout id from historyDetails.
var wid = Object.keys(historyDetails)[0];
await historyUpdateExerciseWeightMode(wid, 0, 'per_side');
```

Verify in Supabase Studio that `sets.weight_mode = 'per_side'` for that placement. (Reset to NULL if you want — `update sets set weight_mode = null where workout_id = '...' and exercise_order = 0;`.)

- [ ] **Step 3: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
feat(weight-mode): history-edit fan-out helper

Mirrors historyUpdateExerciseRpe: single UPDATE on
(workout_id, exercise_order). Used by the chip in the history-edit view
(v3.0.3) to retroactively correct weight mode on past workouts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Chip UI + click delegation

Render the chip in plan-day prescribed cards, plan-day extras cards, ad-hoc cards, and history-detail cards. Wire click handlers in three contexts: editable today (plan + ad-hoc share the same handler), and history-edit. Read-only history detail renders the chip as a static label.

**Files:**
- Modify: `index.html` — add chip CSS near `.ex-history-btn` (~1772).
- Modify: `js/ui.js` — render chip in 4 card paths; add click delegators.

- [ ] **Step 1: Add chip CSS**

In `index.html`, insert directly after the `.ex-history-btn:active` rule at ~line 1772:

```css

/* Per-workout weight-mode chip (v3.1.0). Sits next to .ex-history-btn
   inside .exercise-name-block. Toggles between Total and Per side; the
   .is-per-side variant is just a different color so the override is
   visually distinct from the default. */
.weight-mode-chip {
  align-self: flex-start;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text2);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  margin-top: 4px;
  border-radius: 3px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.weight-mode-chip.is-per-side {
  background: var(--accent-soft, var(--surface3));
  color: var(--accent, var(--text));
  border-color: var(--accent, var(--border));
}
.weight-mode-chip:disabled,
.weight-mode-chip.is-readonly {
  cursor: default;
  opacity: 0.85;
}
```

- [ ] **Step 2: Add a chip-render helper at the top of `js/ui.js`**

Near the top of `js/ui.js` (search for the existing `function escapeHtml` or `function escapeAttr` — colocate near them). Add:

```js
// Render the per-workout weight-mode chip for an exercise card.
// `mode` is the effective mode (output of effectiveWeightMode).
// `meta` is the exerciseMeta — used to decide visibility (skip for
// bodyweight/none/cardio rows). `ctx` is one of:
//   - 'editable' — today plan day or ad-hoc; clickable, fires
//                  data-toggle-weight-mode-ei.
//   - 'history-edit' — historical edit mode; clickable, fires
//                      data-history-toggle-weight-mode with workout id.
//   - 'history-readonly' — no click, static label.
// Returns '' (chip hidden) when the exercise is bodyweight/none/cardio.
function renderWeightModeChip(ei, mode, meta, ctx, workoutId) {
  if (!meta) return '';
  var lib = meta.weight_mode || 'total';
  // Skip for non-resistance modes; the toggle has no meaning there.
  if (lib === 'bodyweight' || lib === 'none') return '';
  if (meta.muscle_group === 'cardio') return '';
  var isPerSide = mode === 'per_side';
  var label = isPerSide ? 'Per side' : 'Total';
  var classes = 'weight-mode-chip' + (isPerSide ? ' is-per-side' : '');
  var attrs = '';
  if (ctx === 'editable') {
    attrs = ' type="button" data-toggle-weight-mode-ei="' + ei + '"';
  } else if (ctx === 'history-edit') {
    attrs = ' type="button" data-history-toggle-weight-mode="1"' +
            ' data-history-ex-order="' + ei + '"' +
            ' data-history-workout-id="' + escapeAttr(workoutId || '') + '"';
  } else {
    // history-readonly: render as a non-button so it's unambiguously static.
    return '<span class="' + classes + ' is-readonly">' + label + '</span>';
  }
  return '<button class="' + classes + '"' + attrs + '>' + label + '</button>';
}
```

- [ ] **Step 3: Render chip in plan-day prescribed card (~542)**

Find the existing line:
```js
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(displayName) + prescribedBadge + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(displayName) + '">view recent</button></div><div class="exercise-status ' + sc + '">' + stat + '</div>' + swapBtn + '</div>';
```

Determine the effective mode for the chip earlier in this function. The substitute-aware lookup landed in Task 3 Step 1 — it produced `weightMode` and `subMeta`. Use that. Insert the chip immediately after the `view recent` button (still inside `.exercise-name-block`):

Replace the line above with:
```js
    var chipMeta = exState.subExercise || exState.exerciseMeta || (exState.subExercise == null && plan && plan.days[di] && plan.days[di].exercises[ei] ? exerciseLibraryById[exerciseIdCache[normName(plan.days[di].exercises[ei].name)]] : null);
    var chipMode = effectiveWeightMode(exState.sets[0], chipMeta);
    var chipHtml = readOnly
      ? renderWeightModeChip(ei, chipMode, chipMeta, 'history-readonly', null)
      : renderWeightModeChip(ei, chipMode, chipMeta, 'editable', null);
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(displayName) + prescribedBadge + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(displayName) + '">view recent</button>' + chipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div>' + swapBtn + '</div>';
```

- [ ] **Step 4: Render chip in plan-day extras card (~682)**

Find:
```js
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(xMeta.name) + '<span class="extras-badge">added</span></div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(xMeta.name) + '">view recent</button></div><div class="exercise-status ' + xsc + '">' + xstat + '</div>' + (readOnly ? '' : '<button class="card-delete" data-di="' + di + '" data-ei="' + xei + '" aria-label="Delete exercise" type="button">×</button>') + '</div>';
```

Replace with:
```js
    var xChipHtml = readOnly
      ? renderWeightModeChip(xei, xWeightMode, xMeta, 'history-readonly', null)
      : renderWeightModeChip(xei, xWeightMode, xMeta, 'editable', null);
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(xMeta.name) + '<span class="extras-badge">added</span></div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(xMeta.name) + '">view recent</button>' + xChipHtml + '</div><div class="exercise-status ' + xsc + '">' + xstat + '</div>' + (readOnly ? '' : '<button class="card-delete" data-di="' + di + '" data-ei="' + xei + '" aria-label="Delete exercise" type="button">×</button>') + '</div>';
```

- [ ] **Step 5: Render chip in ad-hoc card (~793)**

Find:
```js
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(meta.name) + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(meta.name) + '">view recent</button></div><div class="exercise-status ' + sc + '">' + stat + '</div><button class="card-delete" data-di="' + di + '" data-ei="' + ei + '" aria-label="Delete exercise" type="button">×</button></div>';
```

Replace with:
```js
    var adChipHtml = renderWeightModeChip(ei, weightMode, meta, 'editable', null);
    h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(meta.name) + '</div><button class="ex-history-btn" type="button" data-exercise-name="' + escapeAttr(meta.name) + '">view recent</button>' + adChipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div><button class="card-delete" data-di="' + di + '" data-ei="' + ei + '" aria-label="Delete exercise" type="button">×</button></div>';
```

- [ ] **Step 6: Render chip in history detail card (~2176)**

Find inside `renderHistoryExerciseCard`:
```js
  h += '<div class="exercise-card' + cc + '" data-history-ex-order="' + ei + '">';
  h += '<div class="exercise-header"><div class="exercise-name">' + escapeHtml(name) + '</div><div class="exercise-status ' + sc + '">' + stat + '</div></div>';
```

The history detail card lacks an `.exercise-name-block` wrapper — wrap so the chip can sit beneath the name like in the live cards. Replace with:

```js
  h += '<div class="exercise-card' + cc + '" data-history-ex-order="' + ei + '">';
  // weightMode is the placement-level effective mode passed in by the caller.
  var histCtx = historyEditMode ? 'history-edit' : 'history-readonly';
  var histChipHtml = renderWeightModeChip(ei, weightMode, exState.exerciseMeta, histCtx, /* workoutId */ histWorkoutId);
  h += '<div class="exercise-header"><div class="exercise-name-block"><div class="exercise-name">' + escapeHtml(name) + '</div>' + histChipHtml + '</div><div class="exercise-status ' + sc + '">' + stat + '</div></div>';
```

You'll notice `histWorkoutId` isn't yet defined in this function. Trace `renderHistoryExerciseCard`'s signature; it currently takes `(ei, exState, name, weightMode, prescribedSets)`. Add a sixth parameter:

```js
function renderHistoryExerciseCard(ei, exState, name, weightMode, prescribedSets, histWorkoutId) {
```

And update the three call sites (~1947, ~1970, ~1983) to pass `workout.id` (the surrounding `workout` variable in those functions):

```js
      h += renderHistoryExerciseCard(ei, exState, meta.name, effectiveWeightMode(exState.sets[0], meta), null, workout.id);
```

(Variable name for the workout may differ across the three sites — verify each.)

- [ ] **Step 7: Wire editable click delegator**

Find the existing today/ad-hoc click delegator. Run:
```bash
grep -n "data-toggle-weight-mode-ei\|workoutContainer.*click\|'click'.*workoutContainer\|onclick.*persistSet" js/ui.js | head -10
```

The today click handler is attached to `#workoutContainer` (or similar). Find an existing branch like the one for `data-add-set-ei` or `data-toggle-substitute` and add a sibling branch.

Inside that handler (search for `// Handle clicks on the workout container` or the function that delegates), add:

```js
  // Per-workout weight-mode chip toggle (v3.1.0). Editable today + ad-hoc.
  var wmEi = e.target.closest && e.target.closest('[data-toggle-weight-mode-ei]');
  if (wmEi) {
    var ei = parseInt(wmEi.getAttribute('data-toggle-weight-mode-ei'), 10);
    var di = currentDay;
    var st = todayState && todayState.dayIndex === di ? todayState : findAdHoc(di);
    if (!st) return;
    var exState = st.exercises['ex_' + ei];
    if (!exState) return;
    var meta = exState.subExercise || exState.exerciseMeta || {};
    var current = effectiveWeightMode(exState.sets[0], meta);
    var next = current === 'per_side' ? 'total' : 'per_side';
    setExerciseWeightMode(di, ei, next).then(function() {
      // Re-render the appropriate day so the chip + per-side hint + volume
      // all update.
      if (st.isAdHoc) buildAdHocDay(di);
      else buildDay(di, viewModeFor(di));
    });
    return;
  }
```

(Adapt `currentDay` / `viewModeFor` / `buildDay` / `buildAdHocDay` / `findAdHoc` to whatever names the file actually uses — search to confirm.)

- [ ] **Step 8: Wire history-edit click delegator**

Find the existing history click delegator. Run:
```bash
grep -n "historyBody.*click\|'click'.*historyBody\|historyEditMode = !historyEditMode" js/ui.js | head -5
```

Locate the handler attached to `#historyBody` (the one that handles `data-history-rpe`, etc.). Add a branch:

```js
  // History-edit weight-mode chip toggle (v3.1.0).
  var hwm = e.target.closest && e.target.closest('[data-history-toggle-weight-mode]');
  if (hwm) {
    var hei = parseInt(hwm.getAttribute('data-history-ex-order'), 10);
    var hwid = hwm.getAttribute('data-history-workout-id');
    var details = historyDetails[hwid];
    if (!details) return;
    var hex = details.exercises['ex_' + hei];
    if (!hex) return;
    var hmeta = hex.exerciseMeta || {};
    var hcur = effectiveWeightMode(hex.sets[0], hmeta);
    var hnext = hcur === 'per_side' ? 'total' : 'per_side';
    historyUpdateExerciseWeightMode(hwid, hei, hnext).then(function() {
      // Mirror to in-memory historyDetails so re-render reflects the new mode.
      for (var i = 0; i < hex.sets.length; i++) {
        if (hex.sets[i]) hex.sets[i].weight_mode = hnext;
      }
      renderHistoryDetail(details);
    }).catch(function(err) {
      console.error('history weight-mode toggle failed:', err);
      showToast("Weight mode didn't save");
    });
    return;
  }
```

- [ ] **Step 9: Smoke test the chip end-to-end**

Hard-reload. Then run through every chip context:

**Editable today (plan day):**
1. Open today's plan day. Find a resistance exercise (not bodyweight/cardio).
2. Confirm a "Total" or "Per side" chip appears under the exercise name, next to "view recent".
3. Tap it. Chip flips. The "per side" hint under the weight input appears or disappears. The card re-renders.
4. Hard-reload. Chip remembers its new value.

**Editable ad-hoc:**
5. Repeat steps 1-4 in an ad-hoc session.

**Add a set after toggling:**
6. With the chip on "Per side", tap "+ Add Set". The new set should also show the "per side" hint (i.e. it inherited the override).

**History-edit:**
7. Open History → an old session → tap **Edit**. Confirm chip is editable on the exercise cards.
8. Tap the chip. It flips. Hard-reload. Sticks.

**History read-only:**
9. Re-open the same session without entering edit mode. Chip renders as a static label (no button cursor, no tap behavior).

**Hidden contexts:**
10. Confirm chip does **not** render on bodyweight exercises (e.g. Pull-ups), cardio rows (e.g. Treadmill Walk), or `none`-mode rows.

If any of the above fails, fix before committing.

- [ ] **Step 10: Commit**

```bash
git add index.html js/ui.js
git commit -m "$(cat <<'EOF'
feat(weight-mode): per-workout chip in plan / ad-hoc / history cards

Tappable chip next to "view recent" toggles weight_mode for one
exercise placement. Editable in today + ad-hoc + history-edit;
static label in read-only history. Hidden for bodyweight / none /
cardio rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CSV export + swap-snapshot preservation

Two small write-side fixes that complete the feature: CSV export should reflect the effective mode (override or library default); the swap-out/swap-back snapshot should preserve the override so swapping doesn't accidentally reset it.

**Files:**
- Modify: `js/ui.js` — CSV export at ~5640; swap snapshot at ~3955 and ~4105.

- [ ] **Step 1: Update CSV export**

Find at ~5640:
```js
            ex.weight_mode || '',
```

This iterates over historical exercise rows for export. Replace with the effective mode using the joined library row plus any per-set override. The simplest correct read uses the **first set's** override (since the toggle keeps all sets in sync) and the joined exercise row as the fallback:

```js
            // Effective mode (v3.1.0): per-set override wins over library
            // default. All sets in a placement carry the same value, so
            // reading from sets[0] is sufficient.
            (ex.sets && ex.sets[0] && ex.sets[0].weight_mode) || ex.weight_mode || '',
```

(Variable names depend on the surrounding loop. Verify by reading 5610-5650 — the export structure may already iterate with `s` as the set; if so, use the per-set override directly per-row.)

- [ ] **Step 2: Update swap snapshot at ~3955**

Find:
```js
      weight_mode: meta ? (meta.weight_mode || 'total') : 'total',
```

The swap snapshot stores the original exercise's library mode so it can be restored. Since the per-set override is independent of the library default, the snapshot's `weight_mode` field doesn't need to change — but the in-memory `weight_mode` on the swapped-in sets should be cleared so the new exercise starts fresh:

Verify the surrounding `swapState.snapshot` construction. If the snapshot is restored verbatim into new sets, ensure the restored `weight_mode` on sets is whatever was on the original sets (preserved) rather than carried over from the swapped-in placement. If the snapshot is exercise-meta only (not per-set), no change needed here.

Read the function around 3940-3970:
```bash
grep -n "swapState\|weight_mode" js/ui.js | sed -n '1,50p'
```

Then make the minimal change so:
- Swap-out: per-set `weight_mode` values are stored alongside other set state.
- Swap-back: per-set `weight_mode` values are restored.

Concretely, where the snapshot stores per-set state, add `weight_mode: sl.weight_mode || null`. Where it restores, restore `weight_mode` onto each set.

If the swap path is large enough that a clean diff isn't obvious, a safe fallback is to leave swap untouched and add a known-issue note here in the plan: swap currently doesn't preserve per-workout override across swap cycles. **Defer to user.**

- [ ] **Step 3: Smoke test**

**CSV export:**
1. Toggle a placement to per-side.
2. Trigger CSV export (search for the export button — likely in a hamburger-menu item).
3. Open the CSV. Confirm the row for that exercise/set has `per_side` in the `weight_mode` column.

**Swap (if Step 2 was applied):**
4. In a session, swap an exercise that has a per-side override. Cancel the swap (swap back).
5. Confirm the chip still reads "Per side" after the swap-back.

**Swap (if Step 2 was deferred):**
4'. Skip — known limitation noted in the plan.

- [ ] **Step 4: Commit**

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
feat(weight-mode): CSV export reads effective mode (+ swap preservation)

CSV export now reflects per-set override when present. Swap snapshot
preserves the override across swap-out/swap-back cycles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Version bump + final smoke pass

Bumps `APP_VERSION` to mark the feature as a single user-visible release. Per project convention, this is the only commit that touches `APP_VERSION` for this milestone.

**Files:**
- Modify: `js/app.js` — line 10.

- [ ] **Step 1: Bump APP_VERSION**

In `js/app.js` line 10, change:
```js
var APP_VERSION = 'v3.0.3';
```

to:
```js
var APP_VERSION = 'v3.1.0';
```

- [ ] **Step 2: Final smoke pass — full feature**

Hard-reload. Walk through:

1. Footer reads `v3.1.0`.
2. Today's plan day → pick a resistance exercise → toggle chip → confirm:
   - Chip flips visually.
   - "per side" hint appears under weight input (if toggled to per_side) or disappears (if toggled to total).
   - Hard-reload preserves the chip state.
3. `+ Add Set` after toggling → new set inherits override.
4. `+ Drop Set` after toggling → drop sets inherit override.
5. Open coach → confirm volume reflects the override (`× 2` for per-side).
6. Open History → tap an old session → enter Edit mode → toggle chip → confirm DB write succeeds (verify in Supabase Studio if needed).
7. Exit edit → chip renders as static label (not a button).
8. Bodyweight exercise (e.g. Pull-ups) → no chip rendered.
9. Cardio row (e.g. Treadmill Walk) → no chip rendered.
10. `none`-mode exercise (if any in the library) → no chip rendered.
11. CSV export → effective `weight_mode` appears in export rows.

If any check fails, fix before committing this task.

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
v3.1.0 -- per-workout weight-mode toggle

Per-exercise-card chip overrides weight_mode for one workout placement
without editing the library. Solves the "same exercise, different
machine at different gyms" case (e.g. Hammer Strength Incline plate
vs cable). Editable in today + ad-hoc + history-edit; static in
read-only history. Volume math, "per side" hint, and CSV export all
respect the override via the new effectiveWeightMode helper.

Schema: nullable sets.weight_mode column (NULL = inherit library
default). Fan-out follows the same (workout_id, exercise_order)
pattern as updateExerciseFanOut / historyUpdateExerciseRpe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Update HANDOFF.md**

HANDOFF.md is currently stale at v3.0.1 (per the git log it should already say v3.0.3, and now needs v3.1.0). Bring it current as a follow-up commit:

Open `HANDOFF.md` and update:
- The "Current live version" line at the top.
- Add a paragraph for v3.1.0 in the same format as the v3.0.x paragraph (~line 11).

Then:
```bash
git add HANDOFF.md
git commit -m "$(cat <<'EOF'
docs: HANDOFF current through v3.1.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: (Pending user approval) push**

Per project convention, **do not push** without explicit user approval. After all the above is committed locally, ask the user:

> "v3.1.0 ready to push. Confirm and I'll push to origin/main?"

Wait for explicit confirmation before running `git push`.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Schema (`alter table sets add column weight_mode`) | Task 1 |
| Resolver helper `effectiveWeightMode` | Task 2 |
| Plumb override through state + payload | Task 2 |
| Replace ~10 direct `meta.weight_mode` reads | Task 3 |
| Volume math reads effective mode | Task 3 |
| Editable fan-out helper `setExerciseWeightMode` | Task 4 |
| New-set inheritance (`addExtraSet`, `addDropSet`) | Task 4 |
| History-edit fan-out helper | Task 5 |
| Chip render in plan / extras / ad-hoc / history | Task 6 |
| Chip CSS + visibility rules (skip bw/none/cardio) | Task 6 |
| Click delegators for editable + history-edit | Task 6 |
| CSV export reads effective mode | Task 7 |
| Swap-snapshot preserves override | Task 7 |
| Version bump v3.1.0 | Task 8 |
| HANDOFF refresh | Task 8 |

All spec sections covered.

**Open caveats inside the plan that need user awareness:**

- **Task 7 Step 2 (swap-snapshot preservation):** the swap path is non-trivial; if the per-set extension turns out larger than expected at execution time, the plan explicitly allows deferring with a noted known limitation. Flag this back to the user during execution if the deferral is taken.
- **Task 6 Step 3 (chipMeta lookup for prescribed plan exercises):** the code derives `chipMeta` via three fallbacks. If the prescribed exercise's library row isn't loaded yet (`exerciseLibraryById` cold), the chip won't render until hydration completes — acceptable, since the rest of the card already depends on hydration.

**Type-consistency check:** `renderWeightModeChip` signature `(ei, mode, meta, ctx, workoutId)`, `setExerciseWeightMode` signature `(di, ei, mode)`, `historyUpdateExerciseWeightMode` signature `(workoutId, exerciseOrder, mode)`. All call sites in the plan match these signatures. Mode values are always `'total'` or `'per_side'` strings (never NULL except in the migration's "inherit" semantic).
