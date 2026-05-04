# Supersets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class superset (and giant set) support across plan generation, mid-session interaction, and history rendering — so users can have N-exercise groups performed as alternating rounds, both AI-prescribed and manually paired.

**Architecture:** A new optional **block container** in the plan JSON (`{superset:true, rest, exercises:[...]}` alongside regular exercises in `day.exercises[]`), persisted at workout-time via a new `workouts.superset_groups jsonb` column so history renders independently of plan mutations. Mid-session pairing uses a new ⟷ icon in each card header that opens a picker scoped to other-on-day items. AI prescription gets a `## SUPERSETS` section in `system-prompt-plan.md` with opportunistic rules (antagonist pairs, accessory finishers, time-constrained sessions). Drop sets inside members work unchanged because the cascade walks the member's local `sets[]` array.

**Tech Stack:** Plain JS (no build step), Supabase JS client (`sb`), Supabase migrations forward-only, Vercel serverless function for `/api/generate-plan`. No automated test framework — verification is `node --check` for parsing + manual browser smoke tests.

**Spec:** [docs/superpowers/specs/2026-05-02-supersets-design.md](../specs/2026-05-02-supersets-design.md)

**Version target:** **`v3.4.0`** at the end of the plan (next minor bump after v3.3.0; first-class supersets is a milestone-grade feature).

**Workflow rules (from project conventions):**
- Verify with `node --check` after every JS edit. Hard-reload the browser after each task that touches the UI.
- Small focused commits per task. Use the heredoc commit-message pattern with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
- Bump `APP_VERSION` only at the final task — one user-visible release covers the whole feature.
- **Never push.** Commits stay local until the user explicitly approves.
- Heredoc gotcha: avoid apostrophes in commit-message bodies (single-quoted heredoc breaks on contractions).

---

## File map

| File | Change |
|---|---|
| `supabase/migrations/20260504000000_workouts_superset_groups.sql` | Create. Adds `workouts.superset_groups jsonb default '[]'`. |
| `api/generate-plan.js` | Validator: accept block shape; recurse into children; reject members with own `rest`. `expandSetRepeats` recurses into block children. `formatCurrentPlan` walks blocks for plan + analyze + refine + swap context. |
| `system-prompt-plan.md` | New `## SUPERSETS` section between `## DROP SETS` and `## CARDIO PRESCRIPTION`. |
| `js/data.js` | `stateFromWorkout` derives `supersetGroup` per exercise from `row.superset_groups`. `ensureWorkout` writes `superset_groups` from plan-day block structure on lazy-create. New helpers `applySupersetMerge` / `applySupersetSeparate` mutate `plan.data` + persist + rewrite `workouts.superset_groups`. `_formatPlanForCoach` walks blocks. `getLiveContext` tags superset members. |
| `js/ui.js` | New `renderSupersetBlock` (used by `buildDay`, `buildAdHocDay`, `renderHistoryDetail`). New `openSupersetPicker` (scoped to other-on-day). New `onMergeIntoSuperset` / `onRemoveFromSuperset` / `onAddRoundToBlock` handlers. ⟷ icon in card header + click delegate. Drag-to-reorder updates: within-block sort zone + day-level block-as-unit. Round indicator + rest-timer trigger update. |
| `index.html` | CSS: `.superset-block`, `.superset-block-header`, `.superset-member`, `.superset-badge`, `.superset-add-round`, `.ex-superset-btn`. New `<style>` block additions only (~40 lines). |
| `js/app.js` | `APP_VERSION` bump from current → `v3.4.0` at the final task. |

No prompt-cache invalidation surprise: the `## SUPERSETS` addition causes a one-time Anthropic cache miss (~35-45s on first call after deploy); warm thereafter. Operationally normal.

---

### Task 1: Migration — `workouts.superset_groups jsonb`

Add the new column. Default `'[]'` so every existing workout reads as "no supersets" (which is correct — none of them have any).

**Files:**
- Create: `supabase/migrations/20260504000000_workouts_superset_groups.sql`

- [ ] **Step 1: Write the migration**

Create `/Users/sebastianvelez/workout-tracker/supabase/migrations/20260504000000_workouts_superset_groups.sql`:

```sql
-- Adds per-workout superset block structure.
--
-- Each entry: {exercise_orders: [int, ...], rest: int_seconds}
-- Empty array = no supersets in this workout (rendered as flat list,
-- preserving pre-v3.4 behavior).
--
-- Why workout-level (not plan-level) persistence: history detail must
-- survive plan deactivation, deletion, or post-workout structural
-- changes (Swap, Merge, Separate after a session ended). Plan.data is
-- the canonical structure for live render; workouts.superset_groups
-- is the historical record.

alter table workouts
  add column superset_groups jsonb not null default '[]';
```

- [ ] **Step 2: Apply via Supabase dashboard**

Open the Supabase SQL editor for the project, paste the migration, and run it. Verify with:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'workouts' and column_name = 'superset_groups';
```

Expected: one row, `jsonb`, default `'[]'::jsonb`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260504000000_workouts_superset_groups.sql
git commit -m "$(cat <<'EOF'
db: add workouts.superset_groups jsonb for per-workout block structure

Adds the column that persists superset block membership independently
of plan.data so History detail renders historical sessions correctly
even after the plan is mutated or deactivated. Default empty array
means existing workouts continue to render as flat lists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Plan validator — accept superset block shape

Extend `validatePlan` (and `validateRefinement` if separate) so the new shape passes through. Recurse into block children. Reject pathological inputs (empty blocks, single-member blocks, non-integer rest, members with their own rest, nested supersets).

**Files:**
- Modify: `api/generate-plan.js` — `validatePlan` and surrounding helpers.

- [ ] **Step 1: Locate the validator**

Run:
```bash
grep -n "function validatePlan\|function validateExercise\|function validateSet\|function validateRefinement" api/generate-plan.js
```

The validator iterates `plan.days[].exercises[]`. Read those functions to understand the existing shape (per-exercise validation calls per-set validation).

- [ ] **Step 2: Add `validateSupersetBlock` helper**

Add this function above `validatePlan` in `api/generate-plan.js`. Use the existing per-exercise validator function name (whatever it's currently called — `validateExercise` or `validateExerciseEntry`) for the recursive call. **Find the existing function via the grep in Step 1 and use its actual name; if the existing per-exercise validation is inline inside `validatePlan`, refactor it out into a named helper first (small refactor — extract the per-exercise body into `validateRegularExercise(entry, ctx)`, then call it from the validatePlan loop).**

```js
function validateSupersetBlock(entry, ctx) {
  if (!Array.isArray(entry.exercises) || entry.exercises.length < 2) {
    return 'Superset block must have at least 2 exercises';
  }
  if (!Number.isInteger(entry.rest)) {
    return 'Superset block rest must be an integer (seconds)';
  }
  for (var i = 0; i < entry.exercises.length; i++) {
    var child = entry.exercises[i];
    if (child && child.rest != null) {
      return 'Superset members may not have their own rest field — use block-level rest';
    }
    if (child && child.superset === true) {
      return 'Nested supersets not supported';
    }
    var childErr = validateRegularExercise(child, ctx);
    if (childErr) return childErr;
  }
  return null;
}
```

- [ ] **Step 3: Dispatch in `validatePlan`**

Inside `validatePlan`'s per-exercise loop (or per-day-exercises loop, whichever wraps the entry), branch on `entry.superset`:

```js
// Within the existing exercises[] iteration:
var entry = day.exercises[ei];
if (entry && entry.superset === true) {
  var blockErr = validateSupersetBlock(entry, ctx);
  if (blockErr) return blockErr;
  continue; // skip the per-exercise validator below — block validates its own children
}
// existing per-exercise validation below...
var err = validateRegularExercise(entry, ctx);
if (err) return err;
```

Adapt the variable names to match what's in the existing code. Use the same `return <string>` error pattern the existing validator uses (the API returns these strings to the client as 422 errors).

- [ ] **Step 4: Verify parse**

```bash
node --check api/generate-plan.js
```

Expected: no output.

- [ ] **Step 5: Sanity check via DevTools (manual)**

Skip this step — Task 7 will exercise the validator end-to-end via a generated plan. The validator changes here are inert until we ship the prompt extension in Task 13 and the AI emits a block.

- [ ] **Step 6: Commit**

```bash
git add api/generate-plan.js
git commit -m "$(cat <<'EOF'
api(validate): accept superset block shape in plan output

Adds validateSupersetBlock and dispatches on entry.superset === true
in the per-exercise loop. Rejects empty blocks, single-member blocks,
non-integer rest, members carrying their own rest field, and nested
supersets. Recurses into children using the existing per-exercise
validator so all standard rules (library names, set count, weight
mode) still apply to each member.

Inert until the system prompt is updated to teach Claude the block
shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `expandSetRepeats` — recurse into block children

The `repeat: N` shorthand needs to expand inside member sets[] just like inside regular exercises.

**Files:**
- Modify: `api/generate-plan.js` — `expandSetRepeats`.

- [ ] **Step 1: Locate the function**

Run:
```bash
grep -n "function expandSetRepeats\|expandSetRepeats(" api/generate-plan.js
```

Read the function. It walks `plan.days[].exercises[]` and rewrites set arrays where `repeat: N` is present. There may also be a per-exercise variant `expandSetRepeatsForOneExercise(ex)` (line 1525 per current grep) — the swap-mode handler uses it.

- [ ] **Step 2: Make `expandSetRepeats` recurse on blocks**

Inside the `days[].exercises[]` loop in `expandSetRepeats`, add a branch:

```js
// Within the existing iteration over day.exercises[]:
var entry = day.exercises[exi];
if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
  for (var ci = 0; ci < entry.exercises.length; ci++) {
    expandSetRepeatsForOneExercise(entry.exercises[ci]);
  }
  continue;
}
// existing per-exercise expansion below...
expandSetRepeatsForOneExercise(entry);
```

If the codebase doesn't have a `expandSetRepeatsForOneExercise` helper, extract the per-exercise expansion body into one (small refactor; the existing inline body becomes the new helper). The Swap-mode path at line 1197 (`expandSetRepeatsForOneExercise(replacement)`) suggests the helper exists already.

- [ ] **Step 3: Verify parse**

```bash
node --check api/generate-plan.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add api/generate-plan.js
git commit -m "$(cat <<'EOF'
api(expand): recurse expandSetRepeats into superset block children

The repeat: N shorthand now works inside a superset member's sets
array exactly as it does for regular exercises. Block children are
expanded via expandSetRepeatsForOneExercise so the existing
expansion logic stays the single source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `stateFromWorkout` — derive `supersetGroup` per exercise

Read `row.superset_groups` and stamp a `supersetGroup` string key on each affected `state.exercises[ek]` entry. Members of the same group share the same key.

**Files:**
- Modify: `js/data.js` — `stateFromWorkout` (~line 307).

- [ ] **Step 1: Read the function**

```bash
grep -n "function stateFromWorkout" js/data.js
```

The function builds `state.exercises[ek] = { ... }` keyed by `'ex_' + s.exercise_order`. We'll add `supersetGroup` to each entry.

- [ ] **Step 2: Add the supersetGroup derivation**

After the loop that populates `state.exercises[ek]` from `row.sets[]` finishes, add a post-pass that walks `row.superset_groups` and assigns group keys:

```js
// Stamp supersetGroup on members based on row.superset_groups.
// Format: row.superset_groups = [{exercise_orders: [int,...], rest: int}, ...]
// Group key 'g0', 'g1', ... is assigned in array order so members in
// the same group sort-stable to the same key. Standalone exercises
// stay at supersetGroup: null (the default established by the loop).
var groups = Array.isArray(row.superset_groups) ? row.superset_groups : [];
for (var gi = 0; gi < groups.length; gi++) {
  var g = groups[gi];
  if (!g || !Array.isArray(g.exercise_orders)) continue;
  var groupKey = 'g' + gi;
  for (var oi = 0; oi < g.exercise_orders.length; oi++) {
    var order = g.exercise_orders[oi];
    var ek = 'ex_' + order;
    if (state.exercises[ek]) {
      state.exercises[ek].supersetGroup = groupKey;
      state.exercises[ek].supersetRest = Number.isInteger(g.rest) ? g.rest : 60;
    }
  }
}
// Initialize null on any entry that wasn't grouped.
for (var sek in state.exercises) {
  if (state.exercises.hasOwnProperty(sek) && state.exercises[sek].supersetGroup === undefined) {
    state.exercises[sek].supersetGroup = null;
    state.exercises[sek].supersetRest = null;
  }
}
```

Place this block immediately before the `return state;` line at the bottom of `stateFromWorkout`.

- [ ] **Step 3: Verify parse**

```bash
node --check js/data.js
```

Expected: no output.

- [ ] **Step 4: Probe via DevTools**

Hard-reload the running app. Open DevTools console. Pick any workout id from the Plans modal or History view (check `todayState && todayState.workoutId`) and inspect the state map shape:

```js
Object.entries(todayState.exercises || {}).map(function(e){return [e[0], e[1].supersetGroup, e[1].supersetRest];})
```

Expected: an array of `[ek, null, null]` entries (no supersets exist yet — the column is empty for every row pre-Task 7). If you see `undefined` for either field, the loop missed the entry — re-check Step 2.

- [ ] **Step 5: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
data: derive supersetGroup on each exercise state from row.superset_groups

stateFromWorkout now walks the new workouts.superset_groups column
and stamps supersetGroup (string key like g0, g1) and supersetRest
(int seconds) on each affected exercises entry. Standalone exercises
get supersetGroup: null. Foundation for the renderer to detect and
group superset members.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `ensureWorkout` — write `superset_groups` from plan blocks on lazy-create

When a plan-day workout row is lazy-created (first set-done or notes blur), compute `superset_groups` from the plan's blocks and write it to the row.

**Files:**
- Modify: `js/data.js` — `ensureWorkout` (~line 1300).

- [ ] **Step 1: Read the function**

```bash
grep -n "async function ensureWorkout\|insert.*workouts" js/data.js
```

The function inserts a new row into the `workouts` table when the user logs the first set or types into the session notes. It uses the active plan blob to determine `plan_id`, `day_index`, etc.

- [ ] **Step 2: Add a helper to compute `superset_groups` from a plan day**

Add this helper above `ensureWorkout`:

```js
// Build the workouts.superset_groups payload from a plan-day's
// exercises array. Walks day.exercises[] and emits one entry per
// {superset:true} block: {exercise_orders: [...], rest: <int>}.
// exercise_orders are the *flat* day.exercises[] index range that
// the block occupies — i.e., if the block is at index 2 with 3
// members, exercise_orders = [2, 3, 4] and the next standalone
// exercise (if any) is at flat index 5.
//
// This mirrors how stateFromWorkout maps sets back to exercise_order:
// each set's exercise_order is the flat positional index in the day's
// exercises array, with block members occupying contiguous indices.
function supersetGroupsFromPlanDay(dayPlan) {
  var groups = [];
  if (!dayPlan || !Array.isArray(dayPlan.exercises)) return groups;
  var flatOrder = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      var orders = [];
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        orders.push(flatOrder);
        flatOrder++;
      }
      groups.push({
        exercise_orders: orders,
        rest: Number.isInteger(entry.rest) ? entry.rest : 60
      });
    } else {
      flatOrder++;
    }
  }
  return groups;
}
```

- [ ] **Step 3: Wire the helper into `ensureWorkout`**

In `ensureWorkout`'s insert path (where the `workouts` row payload is built), add `superset_groups` to the insert:

```js
// Where the existing insert payload is constructed, e.g.:
var payload = {
  user_id: userId,
  plan_id: activePlanId,
  day_index: di,
  performed_at: <existing>,
  performed_on: <existing>,
  // ...other existing fields...
};
// Add:
if (plan && plan.days && plan.days[di]) {
  payload.superset_groups = supersetGroupsFromPlanDay(plan.days[di]);
}
```

(Use the actual variable names in the file; the spirit is "compute and add the field to the insert payload before `.insert(payload)`.")

- [ ] **Step 4: Verify parse**

```bash
node --check js/data.js
```

Expected: no output.

- [ ] **Step 5: Browser smoke test**

Hard-reload. With NO supersets in the plan yet (plans don't have any until AI emits them per Task 13), this task should be inert: `supersetGroupsFromPlanDay` returns `[]`, the workout row gets `superset_groups: []`, no behavior changes. Verify by:

1. Start a session on a plan day. Mark one set done.
2. In Supabase dashboard or via DevTools console, query the just-created workouts row:

```js
sb.from('workouts').select('id, superset_groups').order('performed_at', {ascending: false}).limit(1).then(r => console.log(r.data))
```

Expected: one row with `superset_groups: []`.

- [ ] **Step 6: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
data: compute superset_groups on lazy-create from plan-day blocks

ensureWorkout now walks the active plan day for {superset:true} block
entries and writes the corresponding workouts.superset_groups payload
on insert. supersetGroupsFromPlanDay maps block members to a contiguous
exercise_orders range so set-row exercise_order values resolve back to
the right group at render time.

Inert until the AI starts emitting blocks (Task 13) or the user starts
merging cards manually (Tasks 9 / 10).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CSS — block container, member badge, A1/A2 labels, +Add round button

Add the visual treatment for superset blocks. Indigo accent, bordered container, nested member styling, A1/A2/A3 badges.

**Files:**
- Modify: `index.html` — inline `<style>` block.

- [ ] **Step 1: Locate insertion point**

```bash
grep -n "/\* Drop sets\|\.drop-set\|/\* Cardio\|/\* Card-style" index.html | head
```

Pick a logical adjacent section (drop-set styles are the closest analog). Insert the new rules immediately after.

- [ ] **Step 2: Append CSS rules**

Insert these rules in the inline `<style>` block:

```css
/* Superset blocks (v3.4.0) */
.superset-block {
  background: var(--surface);
  border: 2px solid var(--accent-indigo, #6366f1);
  border-radius: 14px;
  padding: 10px;
  margin-bottom: 12px;
}
.superset-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--accent-indigo, #6366f1);
  text-transform: uppercase;
  margin-bottom: 8px;
  padding: 0 4px;
}
.superset-block-header-meta { display: flex; gap: 8px; align-items: center; }
.superset-block-header-rest-edit {
  background: none; border: none; color: inherit;
  cursor: pointer; padding: 0 4px; font-size: 12px;
}
.superset-member { margin-bottom: 8px; }
.superset-member:last-child { margin-bottom: 0; }
.superset-badge {
  display: inline-block;
  background: var(--accent-indigo, #6366f1);
  color: white;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  margin-right: 6px;
  letter-spacing: 0.04em;
}
.superset-add-round {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 8px;
  background: transparent;
  border: 1px dashed var(--accent-indigo, #6366f1);
  border-radius: 10px;
  color: var(--accent-indigo, #6366f1);
  font-family: 'Outfit', sans-serif;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.superset-add-round:hover { background: rgba(99, 102, 241, 0.08); }
.ex-superset-btn {
  background: none;
  border: none;
  color: var(--text2);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}
.ex-superset-btn.in-block { color: var(--accent-indigo, #6366f1); }
```

If the project doesn't define `--accent-indigo`, the fallback `#6366f1` will be used at every site. (Optionally add `--accent-indigo: #6366f1;` to the `:root` block — search for `:root {` and add the line.)

- [ ] **Step 3: Browser smoke test (visual only)**

Hard-reload. Nothing should look different yet — the CSS is dormant until Task 7 emits the new class names. Open DevTools, the rules should appear in the cascade with no errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "$(cat <<'EOF'
ui(css): add superset block container, member badge, and add-round styles

Adds the visual chrome for v3.4.0 superset blocks. Indigo-accented
bordered container with a header line, nested members with A1/A2 style
badges, dashed +Add round button at the bottom. Dormant until the
renderer emits the new class names in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `renderSupersetBlock` helper + integrate into `buildDay` / `buildAdHocDay`

Add a new helper that renders a contiguous run of same-`supersetGroup` exercises as a block. Update `buildDay` and `buildAdHocDay` to detect block runs and emit the helper's output instead of N independent cards.

**Files:**
- Modify: `js/ui.js` — `buildDay` (~line 476), `buildAdHocDay` (~line 775), new `renderSupersetBlock`.

- [ ] **Step 1: Read existing day-build functions**

```bash
grep -n "function buildDay\|function buildAdHocDay" js/ui.js
```

These iterate `plan.days[di].exercises[]` (or ad-hoc state's exercises) and emit per-exercise card HTML. The current loop accumulates HTML in a string `h` and writes `c.innerHTML = h` at the end. We need to insert a "look ahead for block run" pass.

- [ ] **Step 2: Add `renderSupersetBlock`**

Insert near the top of `js/ui.js` (after `renderSetRow` declaration around line 237 is a clean spot):

```js
// Render a contiguous run of exercises that share the same supersetGroup
// key as one bordered block. members is an array of {ei, exState, name,
// weightMode, prescribedSets} — already-resolved per-member data the
// caller built up during its day-build loop. blockMeta is the block-level
// info: {key, rest, currentRound, totalRounds}. readOnly toggles input
// chrome (members render same as standalone, but inside the block frame).
//
// The caller is responsible for figuring out which exercises belong to
// the block and passing them in order. This helper does NOT walk the
// plan or state itself.
function renderSupersetBlock(di, members, blockMeta, readOnly) {
  if (!members || !members.length) return '';
  var h = '';
  h += '<div class="superset-block" data-superset-group="' + escapeAttr(blockMeta.key) + '">';
  h += '<div class="superset-block-header">';
  h += '<span>⟷ Superset · Round ' + blockMeta.currentRound + ' of ' + blockMeta.totalRounds + '</span>';
  h += '<span class="superset-block-header-meta">';
  h += '<span>' + (blockMeta.rest || 60) + 's rest</span>';
  if (!readOnly) {
    h += '<button class="superset-block-header-rest-edit" type="button" data-edit-superset-rest="' + escapeAttr(blockMeta.key) + '" data-di="' + di + '" aria-label="Edit block rest">✎</button>';
  }
  h += '</span>';
  h += '</div>';
  for (var mi = 0; mi < members.length; mi++) {
    var m = members[mi];
    h += '<div class="superset-member" data-member-ei="' + m.ei + '">';
    // The member-card HTML is a thin wrapper around what buildDay used
    // to emit per-exercise. We re-use the existing per-exercise card
    // markup verbatim — including header (name, swap, ⟷, delete, view-
    // recent, weight-mode chip), set rows, RPE, note, +Add Set, +Drop Set
    // — because members ARE full exercise cards, just nested inside the
    // block container with an A1/A2 badge prefix.
    h += m.cardHtml;  // pre-rendered by the caller using existing card-emit logic
    h += '</div>';
  }
  if (!readOnly) {
    h += '<button class="superset-add-round" type="button" data-add-round="' + escapeAttr(blockMeta.key) + '" data-di="' + di + '">+ Add round</button>';
  }
  h += '</div>';
  return h;
}
```

The caller (buildDay / buildAdHocDay / renderHistoryDetail) is responsible for pre-rendering each member's `cardHtml` (which IS the existing per-exercise card HTML the function used to emit) and packaging it into the `members` array.

- [ ] **Step 3: Add a small grouping helper**

Insert near `renderSupersetBlock`:

```js
// Group consecutive same-supersetGroup exercises together for block
// rendering. Returns an array of {kind: 'standalone'|'block', items}
// where items is the flat exercise descriptor (or array of them for a
// block). exercisesArr is the source array (plan.days[di].exercises[]
// or the equivalent for ad-hoc); stateExercises is state.exercises so
// we can look up supersetGroup per ei.
//
// For ad-hoc workouts: there's no plan, but stateExercises[ek].supersetGroup
// still tells us grouping (set in stateFromWorkout from
// row.superset_groups). For plan-day live render, use the plan's block
// containers directly (entry.superset === true).
function groupRunsForRender(planDayExercises, stateExercises) {
  var runs = [];
  if (!Array.isArray(planDayExercises)) {
    // Ad-hoc / state-only path: walk stateExercises sorted by ei,
    // grouping by supersetGroup.
    var keys = Object.keys(stateExercises || {}).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    var current = null;
    for (var ki = 0; ki < keys.length; ki++) {
      var ek = keys[ki];
      var ei = parseInt(ek.slice(3), 10);
      var ex = stateExercises[ek];
      var group = ex && ex.supersetGroup;
      if (group) {
        if (current && current.kind === 'block' && current.groupKey === group) {
          current.items.push({ei: ei, exState: ex});
        } else {
          if (current) runs.push(current);
          current = { kind: 'block', groupKey: group, rest: ex.supersetRest || 60, items: [{ei: ei, exState: ex}] };
        }
      } else {
        if (current) runs.push(current);
        runs.push({ kind: 'standalone', ei: ei, exState: ex });
        current = null;
      }
    }
    if (current) runs.push(current);
    return runs;
  }
  // Plan-day path: walk plan.days[di].exercises[] and detect blocks.
  // Maintain a flat exercise_order index that matches stateExercises keys.
  var flatEi = 0;
  for (var i = 0; i < planDayExercises.length; i++) {
    var entry = planDayExercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      var items = [];
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        var ek2 = 'ex_' + flatEi;
        items.push({ei: flatEi, planEx: entry.exercises[ci], exState: stateExercises[ek2] || null});
        flatEi++;
      }
      runs.push({ kind: 'block', groupKey: 'p' + i, rest: Number.isInteger(entry.rest) ? entry.rest : 60, items: items });
    } else {
      var ek3 = 'ex_' + flatEi;
      runs.push({ kind: 'standalone', ei: flatEi, planEx: entry, exState: stateExercises[ek3] || null });
      flatEi++;
    }
  }
  return runs;
}
```

- [ ] **Step 4: Update `buildDay` to use the grouping helper**

In `buildDay` (around line 476), replace the per-exercise iteration with the runs-based emission. The existing loop produces a per-exercise HTML chunk; refactor that chunk into a named helper `renderPlanDayExerciseCard(di, ei, planEx, exState, readOnly, isInsideBlock)` so the same chunk can be invoked from both the standalone path and the inside-block path.

The structural shape of the new `buildDay` body becomes:

```js
// (After the day-header / session-bar block already in buildDay.)
var runs = groupRunsForRender(planBlob.days[di].exercises, state.exercises);
for (var ri = 0; ri < runs.length; ri++) {
  var run = runs[ri];
  if (run.kind === 'standalone') {
    h += renderPlanDayExerciseCard(di, run.ei, run.planEx, run.exState, readOnly, false);
  } else {
    var members = [];
    var minDone = Infinity;
    var maxSets = 0;
    for (var mi = 0; mi < run.items.length; mi++) {
      var item = run.items[mi];
      var memCardHtml = renderPlanDayExerciseCard(di, item.ei, item.planEx, item.exState, readOnly, true);
      // Prefix the A1/A2/A3 badge into the rendered card by string-replacing
      // the exercise-name span. A simpler model: pass the badge as an arg
      // to renderPlanDayExerciseCard (cleaner — refactor to accept it).
      members.push({ei: item.ei, cardHtml: memCardHtml});
      var doneCount = countDoneSets(item.exState);
      var totalCount = (item.planEx && Array.isArray(item.planEx.sets)) ? item.planEx.sets.length : (item.exState && item.exState.sets ? item.exState.sets.length : 0);
      if (doneCount < minDone) minDone = doneCount;
      if (totalCount > maxSets) maxSets = totalCount;
    }
    var currentRound = (minDone === Infinity ? 1 : Math.min(minDone + 1, maxSets || 1));
    var roundLabel = (minDone >= maxSets && maxSets > 0) ? (maxSets + ' / ' + maxSets + ' ✓') : (currentRound + ' of ' + maxSets);
    h += renderSupersetBlock(di, members, {
      key: run.groupKey,
      rest: run.rest,
      currentRound: roundLabel.indexOf('of') >= 0 ? currentRound : maxSets,
      totalRounds: maxSets
    }, readOnly);
  }
}
```

The cleaner approach — **strongly prefer** — is to refactor `renderPlanDayExerciseCard` to accept an optional `badgeLabel` arg (e.g., `'A1'`, `'A2'`) and prepend it to the exercise-name span emission. Pass `null` for standalone. This avoids the hacky string-replace.

Add `countDoneSets`:

```js
function countDoneSets(exState) {
  if (!exState || !Array.isArray(exState.sets)) return 0;
  var n = 0;
  for (var i = 0; i < exState.sets.length; i++) {
    if (exState.sets[i] && exState.sets[i].done) n++;
  }
  return n;
}
```

- [ ] **Step 5: Update `buildAdHocDay` symmetrically**

`buildAdHocDay` (line 775) doesn't have a `plan.days[di]` to iterate — it walks `state.exercises` keys. Use `groupRunsForRender(null, state.exercises)` (the ad-hoc branch in the helper). Refactor the per-exercise chunk into `renderAdHocExerciseCard(state, ei, exState, readOnly, isInsideBlock, badgeLabel)` and emit standalone vs block similarly.

- [ ] **Step 6: Verify parse**

```bash
node --check js/ui.js
```

Expected: no output.

- [ ] **Step 7: Browser smoke test**

Hard-reload. Verify nothing looks different yet — there are no superset blocks in any plan or workout. Both renderers should still output the existing flat exercise card list.

If you see a regression (e.g., a card stops rendering, set rows look wrong), the refactor of `renderPlanDayExerciseCard` / `renderAdHocExerciseCard` is the likely culprit. Start the dev server (`vercel dev` or whatever the user uses) and exercise:
- Open a plan day. Verify all cards render.
- Open an ad-hoc session. Verify all cards render.
- Mark a set done. Verify status updates.
- Add a set, swap an exercise, edit RPE — all should still work because we only refactored the per-exercise emission into a named function.

- [ ] **Step 8: Commit**

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
ui(render): add renderSupersetBlock + groupRunsForRender helpers

Refactors the per-exercise card emission in buildDay and buildAdHocDay
into named helpers so the same per-card markup can be invoked both as
a standalone card and as a member of a superset block. Adds
groupRunsForRender to detect contiguous superset runs from plan blob
or state, and renderSupersetBlock to wrap members in the indigo-
accented container with header + add-round footer.

Inert visually until plans contain blocks (Task 13 prompt update) or
users merge cards manually (Task 9 / 10).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `renderHistoryDetail` — render historical blocks

History detail reads `workouts.superset_groups` (already on the row from Task 5) and uses the same `groupRunsForRender` helper to render block-preserved historical sessions.

**Files:**
- Modify: `js/ui.js` — `renderHistoryDetail` (~line 1960).

- [ ] **Step 1: Read the function**

```bash
grep -n "function renderHistoryDetail" js/ui.js
```

It iterates the historical workout's exercises. We'll insert a runs-grouping pass at the top.

- [ ] **Step 2: Pre-build a synthetic state-like object from the workout row**

`renderHistoryDetail` already reconstructs an in-memory state-like view from the row (or uses an existing reconstruction helper). The `state.exercises` map should have `supersetGroup` populated automatically because Task 4's `stateFromWorkout` change runs at history fetch time — verify by inspecting `historyDetails[workoutId].state.exercises[<some-ek>].supersetGroup` in DevTools after opening any past workout.

- [ ] **Step 3: Replace the per-exercise loop with runs**

In `renderHistoryDetail`, replace the existing iteration with:

```js
// state.exercises has supersetGroup populated by stateFromWorkout (Task 4).
// History detail is read-only for block structure; per-set values are
// editable when historyEditMode is true (v3.0.3 path stays unchanged
// because it keys on (workout_id, exercise_order) / (set_id) via the
// helpers, both of which work on members of a block unchanged).
var runs = groupRunsForRender(null, state.exercises);
for (var ri = 0; ri < runs.length; ri++) {
  var run = runs[ri];
  if (run.kind === 'standalone') {
    h += renderHistoryExerciseCard(detail, run.ei, run.exState, /*badgeLabel*/ null);
  } else {
    var members = [];
    var minDone = Infinity, maxSets = 0;
    for (var mi = 0; mi < run.items.length; mi++) {
      var item = run.items[mi];
      var badge = String.fromCharCode(65 /*A*/) + (mi + 1);  // A1, A2, A3...
      members.push({
        ei: item.ei,
        cardHtml: renderHistoryExerciseCard(detail, item.ei, item.exState, badge)
      });
      var d = countDoneSets(item.exState);
      var t = (item.exState && Array.isArray(item.exState.sets)) ? item.exState.sets.length : 0;
      if (d < minDone) minDone = d;
      if (t > maxSets) maxSets = t;
    }
    var currentRound = (minDone === Infinity ? 1 : Math.min(minDone + 1, maxSets || 1));
    h += renderSupersetBlock(/*di unused in history*/ null, members, {
      key: run.groupKey,
      rest: run.rest,
      currentRound: (minDone >= maxSets && maxSets > 0) ? maxSets : currentRound,
      totalRounds: maxSets
    }, /*readOnly*/ true);  // readOnly forbids the edit-rest button + add-round button
  }
}
```

If the existing per-exercise renderer in `renderHistoryDetail` is inline (not a named helper), refactor it into `renderHistoryExerciseCard(detail, ei, exState, badgeLabel)` for symmetry with Task 7's pattern.

- [ ] **Step 4: Verify parse**

```bash
node --check js/ui.js
```

Expected: no output.

- [ ] **Step 5: Browser smoke test**

Hard-reload. Open History → any past workout. Cards should render exactly as before (no past workout has supersets yet — `superset_groups` is `[]`). Verify:
- Read-only mode: edit toggle off → set rows look identical to pre-task render.
- Edit mode (per v3.0.3): toggle on → set values, RPE, notes, session note all editable as before.

If a card disappears or layout breaks, the `renderHistoryExerciseCard` refactor is the likely cause.

- [ ] **Step 6: Commit**

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
ui(history): block-preserved render in renderHistoryDetail

Walks the v3.4 superset_groups via groupRunsForRender and emits each
contiguous block via renderSupersetBlock with readOnly=true. Block
structure (members, block rest) is read-only in History detail —
per-set values stay editable through the existing v3.0.3
historyEditMode helpers.

Inert until historical workouts have non-empty superset_groups
(starts populating once Task 5 ensureWorkout writes blocks from
plan-day creation, or users merge mid-session per Task 9 / 10).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: ⟷ icon in card header + click delegate + merge handler

Add the chain-link icon to every editable exercise card header. Tap on a standalone card → open the picker scoped to other-on-day items. Merge with the chosen target.

**Files:**
- Modify: `js/ui.js` — card header emission (in `renderPlanDayExerciseCard` and `renderAdHocExerciseCard`); new `openSupersetPicker` and `onMergeIntoSuperset` handlers; click delegate.
- Modify: `js/data.js` — new `applySupersetMerge(di, eiA, eiB)` helper that mutates plan.data + writes to `plans` table + rewrites `workouts.superset_groups`.

- [ ] **Step 1: Add ⟷ icon to card header HTML**

In the per-exercise card emission helpers (`renderPlanDayExerciseCard`, `renderAdHocExerciseCard`, also the existing inline header HTML if you didn't fully refactor in Task 7), include the new button alongside Swap (⇄) and Delete (✕):

```js
// Within the exercise-header markup. exState.supersetGroup is the
// indicator: null → "Pair" tooltip, non-null → "Remove from superset".
var inBlock = !!(exState && exState.supersetGroup);
var supersetBtnTitle = inBlock ? 'Remove from superset' : 'Pair as superset';
var supersetBtnClass = 'ex-superset-btn' + (inBlock ? ' in-block' : '');
var supersetBtn = readOnly ? '' :
  '<button class="' + supersetBtnClass + '" type="button" data-di="' + di + '" data-ei="' + ei + '" aria-label="' + supersetBtnTitle + '" title="' + supersetBtnTitle + '">⟷</button>';
// Insert supersetBtn into the existing header alongside ⇄ and ×.
```

The button goes between Swap (⇄) and Delete (✕) per the spec mockup. Also include it in the ad-hoc path.

- [ ] **Step 2: Add `applySupersetMerge` to data.js**

Add this helper near `activateExistingPlan` / `endActivePlan` in `js/data.js`:

```js
// Merge two exercises on the same day into a superset block. eiA is
// the source (the user tapped ⟷ on this card); eiB is the target
// (picker selection). If eiB is already inside an existing block,
// eiA joins that block. If both are standalone, a new 2-member
// block is created.
//
// Mutates:
//   - plan.data (collapse two flat entries into one block, or append
//     to an existing block) — for plan-day workouts.
//   - workouts.superset_groups — recomputed and written to today's
//     plan-day row (if present). For ad-hoc, also written to the
//     ad-hoc workout row.
//
// Persists plan.data via the plans-update path (sb.from('plans').
// update({ data: plan }).eq('id', activePlanId)) — same as the v2.1.0
// Swap flow.
//
// Returns void; throws on DB error.
async function applySupersetMerge(di, eiA, eiB) {
  if (!userId) throw new Error('Not signed in');
  if (eiA === eiB) throw new Error('Cannot pair an exercise with itself');
  // The caller is responsible for providing a `di` that points at the
  // current plan day (or the ad-hoc state key); the function dispatches
  // by isAdHocKey(di).

  if (isAdHocKey(di)) {
    return _applySupersetMergeAdHoc(di, eiA, eiB);
  }
  return _applySupersetMergePlan(di, eiA, eiB);
}

async function _applySupersetMergePlan(di, eiA, eiB) {
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];

  // Walk dayPlan.exercises[] to figure out which entries the eiA / eiB
  // flat indices map to (a block entry might own several flat indices).
  var resolved = _resolveFlatEi(dayPlan, [eiA, eiB]);
  // resolved = [{flatEi, blockIdx, memberIdx}, ...] where blockIdx is the
  // dayPlan.exercises[] index of the block (or the standalone exercise),
  // and memberIdx is the position within the block (or -1 for standalone).
  if (!resolved || resolved.length !== 2) throw new Error('Could not resolve eiA/eiB to plan entries');

  var rA = resolved[0], rB = resolved[1];
  var entryA = dayPlan.exercises[rA.blockIdx];
  var entryB = dayPlan.exercises[rB.blockIdx];

  var newDay = JSON.parse(JSON.stringify(dayPlan));  // deep clone for atomic mutation
  if (entryA.superset && !entryB.superset) {
    // A is a block, B is standalone → append B as a new member
    newDay.exercises[rA.blockIdx].exercises.push(entryB);
    newDay.exercises.splice(rB.blockIdx, 1);
  } else if (!entryA.superset && entryB.superset) {
    // B is a block, A is standalone → append A as a new member
    newDay.exercises[rB.blockIdx].exercises.push(entryA);
    newDay.exercises.splice(rA.blockIdx, 1);
  } else if (!entryA.superset && !entryB.superset) {
    // Both standalone → create a new 2-member block at A's position
    var rest = entryA.rest || entryB.rest || 60;
    var memberA = JSON.parse(JSON.stringify(entryA)); delete memberA.rest;
    var memberB = JSON.parse(JSON.stringify(entryB)); delete memberB.rest;
    var block = { superset: true, rest: rest, exercises: [memberA, memberB] };
    var lo = Math.min(rA.blockIdx, rB.blockIdx);
    var hi = Math.max(rA.blockIdx, rB.blockIdx);
    newDay.exercises[lo] = block;
    newDay.exercises.splice(hi, 1);
  } else {
    // Both blocks → merge B's members into A
    newDay.exercises[rA.blockIdx].exercises = newDay.exercises[rA.blockIdx].exercises.concat(entryB.exercises);
    newDay.exercises.splice(rB.blockIdx, 1);
  }

  // Persist plan.data
  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDay;
  var r = await sb.from('plans').update({ data: newPlan }).eq('id', activePlanId);
  if (r.error) throw new Error(r.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  // Recompute today's plan-day workout's superset_groups and write it
  // (if a workouts row exists for today's plan day — i.e., user has
  // logged at least one set or written notes).
  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDay);
    var wr = await sb.from('workouts').update({ superset_groups: newGroups })
      .eq('id', todayPlanState.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    // Mirror to in-memory state so re-render sees the new groups.
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}

async function _applySupersetMergeAdHoc(di, eiA, eiB) {
  // di is 'ah_<workoutId>' for ad-hoc.
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');
  // Build a synthetic plan-day shape from current state.exercises so we
  // can reuse the same merge logic via _resolveFlatEi etc., then write
  // back into state.exercises and workouts.superset_groups.
  // (Detailed implementation: convert state.exercises map into an
  // ordered array using ek = ex_<i>; group by supersetGroup; perform
  // the merge; rewrite the supersetGroup keys; compute superset_groups
  // payload.)
  // ...[see Task 9 step 4 for full body]...
}

// Helper: resolve a list of flat exercise_order values to (blockIdx,
// memberIdx) tuples within dayPlan.exercises[].
function _resolveFlatEi(dayPlan, flatEiList) {
  var out = [];
  var flatI = 0;
  for (var i = 0; i < dayPlan.exercises.length; i++) {
    var entry = dayPlan.exercises[i];
    if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
      for (var ci = 0; ci < entry.exercises.length; ci++) {
        var idx = flatEiList.indexOf(flatI);
        if (idx >= 0) out[idx] = {flatEi: flatI, blockIdx: i, memberIdx: ci};
        flatI++;
      }
    } else {
      var idx2 = flatEiList.indexOf(flatI);
      if (idx2 >= 0) out[idx2] = {flatEi: flatI, blockIdx: i, memberIdx: -1};
      flatI++;
    }
  }
  return out;
}

// Helper: re-stamp supersetGroup / supersetRest on state.exercises
// after the column was rewritten.
function _restateFromSupersetGroups(state, groups) {
  for (var ek in state.exercises) {
    if (state.exercises.hasOwnProperty(ek)) {
      state.exercises[ek].supersetGroup = null;
      state.exercises[ek].supersetRest = null;
    }
  }
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    if (!g || !Array.isArray(g.exercise_orders)) continue;
    var key = 'g' + gi;
    for (var oi = 0; oi < g.exercise_orders.length; oi++) {
      var ek2 = 'ex_' + g.exercise_orders[oi];
      if (state.exercises[ek2]) {
        state.exercises[ek2].supersetGroup = key;
        state.exercises[ek2].supersetRest = g.rest;
      }
    }
  }
}
```

- [ ] **Step 3: Add `_applySupersetMergeAdHoc` body**

Inside `_applySupersetMergeAdHoc`:

```js
async function _applySupersetMergeAdHoc(di, eiA, eiB) {
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');

  // Compute current groups from state.
  var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });
  var currentGroups = [];  // list of {orders: [int], rest: int} — one per existing block
  var groupKeyToGroupIdx = {};
  for (var i = 0; i < orderedKeys.length; i++) {
    var ek = orderedKeys[i];
    var ex = state.exercises[ek];
    var ei = parseInt(ek.slice(3), 10);
    if (ex.supersetGroup) {
      var idx = groupKeyToGroupIdx[ex.supersetGroup];
      if (idx == null) {
        groupKeyToGroupIdx[ex.supersetGroup] = currentGroups.length;
        currentGroups.push({orders: [ei], rest: ex.supersetRest || 60});
      } else {
        currentGroups[idx].orders.push(ei);
      }
    }
  }

  // Apply merge: figure out which group(s) eiA / eiB are in, and how to combine.
  var groupOfA = -1, groupOfB = -1;
  for (var gi = 0; gi < currentGroups.length; gi++) {
    if (currentGroups[gi].orders.indexOf(eiA) >= 0) groupOfA = gi;
    if (currentGroups[gi].orders.indexOf(eiB) >= 0) groupOfB = gi;
  }

  var newGroups;
  if (groupOfA < 0 && groupOfB < 0) {
    // Both standalone — create a new block
    newGroups = currentGroups.slice();
    newGroups.push({orders: [eiA, eiB].sort(function(a,b){return a-b;}), rest: 60});
  } else if (groupOfA >= 0 && groupOfB < 0) {
    // A in a group, B standalone — append B
    newGroups = currentGroups.slice();
    newGroups[groupOfA] = {
      orders: newGroups[groupOfA].orders.concat([eiB]).sort(function(a,b){return a-b;}),
      rest: newGroups[groupOfA].rest
    };
  } else if (groupOfA < 0 && groupOfB >= 0) {
    newGroups = currentGroups.slice();
    newGroups[groupOfB] = {
      orders: newGroups[groupOfB].orders.concat([eiA]).sort(function(a,b){return a-b;}),
      rest: newGroups[groupOfB].rest
    };
  } else if (groupOfA === groupOfB) {
    // Already in the same group — no-op (caller should have validated)
    return;
  } else {
    // Both in different groups — merge B's members into A's, drop B
    newGroups = [];
    for (var gj = 0; gj < currentGroups.length; gj++) {
      if (gj === groupOfB) continue;
      if (gj === groupOfA) {
        newGroups.push({
          orders: currentGroups[gj].orders.concat(currentGroups[groupOfB].orders).sort(function(a,b){return a-b;}),
          rest: currentGroups[gj].rest
        });
      } else {
        newGroups.push(currentGroups[gj]);
      }
    }
  }

  // Persist to workouts.superset_groups.
  var payload = newGroups.map(function(g) {
    return {exercise_orders: g.orders, rest: g.rest};
  });
  var wr = await sb.from('workouts').update({superset_groups: payload})
    .eq('id', state.workoutId);
  if (wr.error) throw new Error(wr.error.message);

  // Mirror to in-memory state.
  _restateFromSupersetGroups(state, payload);
}
```

- [ ] **Step 4: Add `openSupersetPicker` and `onMergeIntoSuperset` to ui.js**

```js
// Open the merge picker for ⟷ on a standalone card. Lists other
// items on this day: standalone exercises (each pickable individually
// → creates a 2-member superset) + existing supersets (pickable as
// join targets). Excludes the source card itself.
//
// Reuses the existing modal infrastructure.
function openSupersetPicker(di, ei) {
  // Walk the day's runs (same helper as renderers) to enumerate options.
  var state, exercisesArr;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
    exercisesArr = null;
  } else {
    state = stateForDay(di);
    var planBlob = _planForState(state) || plan;
    exercisesArr = planBlob && planBlob.days && planBlob.days[di] ? planBlob.days[di].exercises : null;
  }
  if (!state) return;
  var runs = groupRunsForRender(exercisesArr, state.exercises);

  // Build option list.
  var options = [];  // [{label, type:'standalone'|'block', targetEi: int}]
  for (var ri = 0; ri < runs.length; ri++) {
    var run = runs[ri];
    if (run.kind === 'standalone') {
      if (run.ei === ei) continue;  // skip self
      var name = (run.planEx && run.planEx.name) || (run.exState && run.exState.exerciseMeta && run.exState.exerciseMeta.name) || 'Exercise';
      options.push({label: name, type: 'standalone', targetEi: run.ei});
    } else {
      // Block — list as one option using the first member's name as a label hint
      var firstMember = run.items[0];
      var firstName = (firstMember.planEx && firstMember.planEx.name) || (firstMember.exState && firstMember.exState.exerciseMeta && firstMember.exState.exerciseMeta.name) || 'Block';
      // Skip the block if the source ei is already in it (no-op merge)
      var sourceInBlock = run.items.some(function(it) { return it.ei === ei; });
      if (sourceInBlock) continue;
      options.push({label: 'Superset: ' + firstName + ' + others', type: 'block', targetEi: run.items[0].ei});
    }
  }

  if (!options.length) {
    showToast('Nothing else on this day to pair with', null);
    return;
  }

  // Render in a simple modal (reuse existing modal-overlay pattern).
  // Markup is built programmatically and shown via the existing overlay
  // pattern. Wire each row to call onMergeIntoSuperset(di, ei, target.targetEi).
  var modal = document.getElementById('supersetPickerOverlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'supersetPickerOverlay';
    modal.className = 'modal-overlay';
    modal.innerHTML = '<div class="modal" style="max-width:420px"><h3 style="margin-top:0">Pair with…</h3><div id="supersetPickerBody"></div><div class="modal-actions"><button class="modal-btn" id="btnSupersetPickerCancel" type="button">Cancel</button></div></div>';
    document.body.appendChild(modal);
    document.getElementById('btnSupersetPickerCancel').addEventListener('click', function() {
      modal.classList.remove('show');
    });
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.classList.remove('show');
    });
  }
  var body = document.getElementById('supersetPickerBody');
  body.innerHTML = options.map(function(o) {
    return '<button class="modal-btn" type="button" style="display:block;width:100%;margin-bottom:8px;text-align:left" data-target-ei="' + o.targetEi + '">' + escapeHtml(o.label) + '</button>';
  }).join('');
  body.onclick = function(e) {
    var t = e.target.closest('[data-target-ei]');
    if (!t) return;
    modal.classList.remove('show');
    onMergeIntoSuperset(di, ei, parseInt(t.getAttribute('data-target-ei'), 10));
  };
  modal.classList.add('show');
}

async function onMergeIntoSuperset(di, eiA, eiB) {
  try {
    await applySupersetMerge(di, eiA, eiB);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
    showToast('Superset created.', null);
    saveHydrationSnapshot();
  } catch (err) {
    console.error('onMergeIntoSuperset error:', err);
    showToast("Couldn't create superset: " + (err.message || 'unknown'), null);
  }
}
```

- [ ] **Step 5: Wire the click delegate**

Find the existing `workoutContainer` click delegate (around line 6000+ in `js/ui.js` per earlier grep). Add a branch for `.ex-superset-btn`:

```js
// Within the workoutContainer click delegate, near the .ex-history-btn / .card-delete branches:
var supersetBtn = e.target.closest && e.target.closest('.ex-superset-btn');
if (supersetBtn) {
  var di = supersetBtn.getAttribute('data-di');
  if (!isAdHocKey(di)) di = parseInt(di, 10);
  var ei = parseInt(supersetBtn.getAttribute('data-ei'), 10);
  if (supersetBtn.classList.contains('in-block')) {
    // Task 10 will wire the unpair branch — no-op for now.
    return;
  }
  openSupersetPicker(di, ei);
  return;
}
```

- [ ] **Step 6: Verify both files parse**

```bash
node --check js/data.js && node --check js/ui.js
```

Expected: no output.

- [ ] **Step 7: Browser smoke test**

Hard-reload. Open a plan day with multiple exercises. Tap ⟷ on a standalone card. Picker should open. Pick another standalone. Both cards should collapse into a superset block with the indigo border, A1/A2 badges visible, header reading `⟷ Superset · Round 1 of <N> · 60s rest`.

Verify:
- `plan.data` is updated (DevTools: `console.log(plan.days[di].exercises)` — should show the new block).
- `workouts.superset_groups` has the new block (only if the workout row exists — which requires logging at least one set first).
- Toast: "Superset created."
- Re-render survives.

If the picker doesn't open, the click delegate isn't matching — re-check Step 5.

- [ ] **Step 8: Commit**

```bash
git add js/ui.js js/data.js
git commit -m "$(cat <<'EOF'
ui+data: superset merge — chain icon, picker, mutate plan + workout row

Adds the ⟷ chain-link icon to every editable exercise card header.
Tap on a standalone card opens openSupersetPicker, which lists other
items on the same day filtered to pickable targets. On selection,
applySupersetMerge mutates plan.data (collapses two flat entries into
a block, or appends to an existing block) and writes the recomputed
workouts.superset_groups to today plan-day or ad-hoc row. In-memory
state is mirror-updated so the next render shows the block.

Plan-day path persists plan.data via the existing plans-update flow
(same as Swap). Ad-hoc path skips plan.data and writes directly to
the ad-hoc workout row.

Unpair branch (⟷ inside a block) is a no-op stub here; wired next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Separate (⟷ inside a block) — pop a member out

When the user taps ⟷ on a card inside a superset, remove that card from the block. If the block now has 1 member, dissolve the entire block.

**Files:**
- Modify: `js/data.js` — new `applySupersetSeparate(di, ei)`.
- Modify: `js/ui.js` — wire the click delegate's `in-block` branch to `onRemoveFromSuperset`.

- [ ] **Step 1: Add `applySupersetSeparate` to data.js**

Add next to `applySupersetMerge`:

```js
// Remove the card at ei from its superset block. If the block now has
// only 1 member, the whole block dissolves (the leftover becomes
// standalone). Mutates plan.data (plan-day) or workouts.superset_groups
// (ad-hoc); persists; mirrors to in-memory state.
async function applySupersetSeparate(di, ei) {
  if (!userId) throw new Error('Not signed in');
  if (isAdHocKey(di)) {
    return _applySupersetSeparateAdHoc(di, ei);
  }
  return _applySupersetSeparatePlan(di, ei);
}

async function _applySupersetSeparatePlan(di, ei) {
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];
  var resolved = _resolveFlatEi(dayPlan, [ei]);
  if (!resolved || !resolved[0]) throw new Error('Could not resolve ei');
  var r = resolved[0];
  if (r.memberIdx < 0) {
    return;  // already standalone — no-op
  }

  var newDay = JSON.parse(JSON.stringify(dayPlan));
  var block = newDay.exercises[r.blockIdx];
  var poppedMember = block.exercises.splice(r.memberIdx, 1)[0];

  if (block.exercises.length === 1) {
    // Dissolve the block: replace the block entry with the remaining
    // member as a standalone, and insert the popped member after it.
    var soleSurvivor = block.exercises[0];
    soleSurvivor.rest = soleSurvivor.rest || block.rest;
    poppedMember.rest = poppedMember.rest || block.rest;
    newDay.exercises[r.blockIdx] = soleSurvivor;
    newDay.exercises.splice(r.blockIdx + 1, 0, poppedMember);
  } else {
    // Block survives with N-1 members. Insert popped member after the
    // block as a standalone.
    poppedMember.rest = poppedMember.rest || block.rest;
    newDay.exercises[r.blockIdx] = block;  // already mutated
    newDay.exercises.splice(r.blockIdx + 1, 0, poppedMember);
  }

  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDay;
  var pr = await sb.from('plans').update({ data: newPlan }).eq('id', activePlanId);
  if (pr.error) throw new Error(pr.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDay);
    var wr = await sb.from('workouts').update({ superset_groups: newGroups })
      .eq('id', todayPlanState.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}

async function _applySupersetSeparateAdHoc(di, ei) {
  var state = findAdHoc(di);
  if (!state) throw new Error('Ad-hoc session not found');

  var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
    return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
  });
  var currentGroups = [];
  var groupKeyToGroupIdx = {};
  for (var i = 0; i < orderedKeys.length; i++) {
    var ek = orderedKeys[i];
    var ex = state.exercises[ek];
    var eiCur = parseInt(ek.slice(3), 10);
    if (ex.supersetGroup) {
      var idx = groupKeyToGroupIdx[ex.supersetGroup];
      if (idx == null) {
        groupKeyToGroupIdx[ex.supersetGroup] = currentGroups.length;
        currentGroups.push({orders: [eiCur], rest: ex.supersetRest || 60});
      } else {
        currentGroups[idx].orders.push(eiCur);
      }
    }
  }

  // Find the group containing ei and remove ei from it.
  var newGroups = [];
  for (var gj = 0; gj < currentGroups.length; gj++) {
    var g = currentGroups[gj];
    var has = g.orders.indexOf(ei) >= 0;
    if (!has) {
      newGroups.push(g);
      continue;
    }
    var withoutEi = g.orders.filter(function(o) { return o !== ei; });
    if (withoutEi.length >= 2) {
      newGroups.push({orders: withoutEi, rest: g.rest});
    }
    // If withoutEi has 1 entry, the block dissolves — just don't push it.
  }

  var payload = newGroups.map(function(g) {
    return {exercise_orders: g.orders, rest: g.rest};
  });
  var wr = await sb.from('workouts').update({ superset_groups: payload })
    .eq('id', state.workoutId);
  if (wr.error) throw new Error(wr.error.message);
  _restateFromSupersetGroups(state, payload);
}
```

- [ ] **Step 2: Add `onRemoveFromSuperset` to ui.js**

```js
async function onRemoveFromSuperset(di, ei) {
  try {
    await applySupersetSeparate(di, ei);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
    showToast('Removed from superset.', null);
    saveHydrationSnapshot();
  } catch (err) {
    console.error('onRemoveFromSuperset error:', err);
    showToast("Couldn't remove: " + (err.message || 'unknown'), null);
  }
}
```

- [ ] **Step 3: Wire the in-block click branch**

Update the `workoutContainer` click delegate's superset branch from Task 9:

```js
var supersetBtn = e.target.closest && e.target.closest('.ex-superset-btn');
if (supersetBtn) {
  var di = supersetBtn.getAttribute('data-di');
  if (!isAdHocKey(di)) di = parseInt(di, 10);
  var ei = parseInt(supersetBtn.getAttribute('data-ei'), 10);
  if (supersetBtn.classList.contains('in-block')) {
    onRemoveFromSuperset(di, ei);
    return;
  }
  openSupersetPicker(di, ei);
  return;
}
```

- [ ] **Step 4: Verify parse**

```bash
node --check js/data.js && node --check js/ui.js
```

- [ ] **Step 5: Browser smoke test**

Hard-reload. Create a 3-member superset (use ⟷ to merge two cards, then ⟷ on a third card → join the existing block). Now tap ⟷ on the middle member. Verify:
- Member pops out and renders as standalone immediately after the block.
- Block still has 2 members.
- Toast: "Removed from superset."
- Tap ⟷ again on one of the remaining 2 members. Block dissolves. Both members render as standalone.

- [ ] **Step 6: Commit**

```bash
git add js/data.js js/ui.js
git commit -m "$(cat <<'EOF'
ui+data: superset separate — pop member, dissolve when N=1

Tapping ⟷ on a card inside a superset block removes that member.
applySupersetSeparate mutates plan.data (plan-day) or
workouts.superset_groups (ad-hoc), persists, mirrors the new groups
to in-memory state. If the block had 2 members and one pops out, the
block dissolves and the remaining member becomes standalone in place.
The popped member is inserted right after the block in the day order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Block-level + Add round button + round indicator + rest timer

The block header shows live "Round N of M" updates. The +Add round button at the block bottom adds one set to every member. Rest timer fires only after the last member of a round has its set marked done.

**Files:**
- Modify: `js/ui.js` — wire `+ Add round` click; update round indicator on re-render; rest-timer trigger.
- Modify: `js/data.js` — small helper `addRoundToBlockMembers(di, groupKey)` if not already covered.

- [ ] **Step 1: Add `addRoundToBlockMembers` to data.js**

The +Add round button needs to add one set to every member of a block. This is N invocations of the existing `addExtraSet` (or similar) helper, scoped to each member's exercise placement.

Find the existing per-member add-set helper:

```bash
grep -n "function addExtraSet\|addSet.*ei\b" js/data.js | head
```

Wrap it:

```js
async function addRoundToBlockMembers(di, groupKey) {
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
  } else {
    state = stateForDay(di);
  }
  if (!state) return;
  var memberEis = [];
  for (var ek in state.exercises) {
    if (state.exercises.hasOwnProperty(ek) && state.exercises[ek].supersetGroup === groupKey) {
      memberEis.push(parseInt(ek.slice(3), 10));
    }
  }
  memberEis.sort(function(a, b) { return a - b; });
  for (var i = 0; i < memberEis.length; i++) {
    // Reuse the existing per-member add-set helper. Whatever its real
    // name is, call it once per member with the appropriate args. The
    // helper already handles carry-forward + DB insert.
    await addExtraSet(di, memberEis[i]);
  }
}
```

Adapt the helper name to whatever exists. If the existing `addExtraSet` is synchronous in the today-state-only path (no DB write at empty-set time), call it directly without await.

- [ ] **Step 2: Wire the +Add round click**

In the workoutContainer click delegate:

```js
var addRoundBtn = e.target.closest && e.target.closest('[data-add-round]');
if (addRoundBtn) {
  var di = addRoundBtn.getAttribute('data-di');
  if (!isAdHocKey(di)) di = parseInt(di, 10);
  var groupKey = addRoundBtn.getAttribute('data-add-round');
  (async function() {
    try {
      await addRoundToBlockMembers(di, groupKey);
      if (isAdHocKey(di)) {
        buildAdHocDay(di);
      } else {
        buildDay(di);
      }
    } catch (err) {
      console.error('addRoundToBlockMembers error:', err);
      showToast("Couldn't add round: " + (err.message || 'unknown'), null);
    }
  })();
  return;
}
```

- [ ] **Step 3: Update rest-timer trigger so it only fires on last-of-round**

Find the existing rest-timer trigger in the set-done-toggle code path:

```bash
grep -n "startRestTimer\|restTargetMs = " js/ui.js | head
```

The current trigger fires after every set-done. We need to gate it on "is this set part of a superset block, AND if so, is this tap the one that completed the current round?"

Insert this gate before the existing `startRestTimer` call:

```js
// Within the function that fires the rest timer after a set-done tap.
// Identify if this exercise is in a block. If yes, only fire the timer
// when this tap brought min(completed-set-count) across members up by one.
function shouldFireRestForBlockMember(state, ei, si) {
  var ek = 'ex_' + ei;
  var exState = state && state.exercises && state.exercises[ek];
  if (!exState || !exState.supersetGroup) return null;  // not in a block — caller fires normally
  var groupKey = exState.supersetGroup;

  var memberEisDoneCounts = [];
  var memberHasSetAtSi = [];
  for (var ek2 in state.exercises) {
    if (!state.exercises.hasOwnProperty(ek2)) continue;
    var mEx = state.exercises[ek2];
    if (mEx.supersetGroup !== groupKey) continue;
    var doneCount = 0;
    if (Array.isArray(mEx.sets)) {
      for (var i = 0; i < mEx.sets.length; i++) {
        if (mEx.sets[i] && mEx.sets[i].done) doneCount++;
      }
    }
    memberEisDoneCounts.push(doneCount);
    memberHasSetAtSi.push(Array.isArray(mEx.sets) && mEx.sets[si] != null);
  }
  if (!memberEisDoneCounts.length) return null;

  // Round just completed = every member that has a set at index si has
  // it marked done. min(doneCount) across members with a set at si is
  // the relevant signal — we fire when that min hit (si + 1).
  var minDone = Infinity;
  for (var k = 0; k < memberEisDoneCounts.length; k++) {
    if (memberHasSetAtSi[k] && memberEisDoneCounts[k] < minDone) minDone = memberEisDoneCounts[k];
  }
  if (minDone === Infinity) return null;
  if (minDone < (si + 1)) return false;  // round not complete yet — suppress
  return exState.supersetRest || 60;  // round complete — fire with block's rest
}

// In the existing set-done flow, replace direct startRestTimer(rest) call with:
var blockTrigger = shouldFireRestForBlockMember(currentState, ei, si);
if (blockTrigger === null) {
  // Standalone — existing per-exercise rest logic.
  startRestTimer(prescribedRest);
} else if (blockTrigger === false) {
  // In a block, but not last of round — suppress timer.
} else {
  // In a block, last of round — fire with block-level rest.
  startRestTimer(blockTrigger);
}
```

Adapt `currentState`, `prescribedRest`, etc. to the actual variable names in the existing flow.

- [ ] **Step 4: Verify parse**

```bash
node --check js/ui.js && node --check js/data.js
```

- [ ] **Step 5: Browser smoke test**

1. Create a 3-member superset (1 cable row + 1 lateral raise + 1 face pull, all 3 sets each).
2. Mark Cable Row set 1 done. Verify: NO rest timer fires; round indicator stays "Round 1 of 3".
3. Mark Lateral Raise set 1 done. NO timer; indicator stays "Round 1 of 3".
4. Mark Face Pull set 1 done. **Timer fires** with the block's rest (60s default). Indicator advances to "Round 2 of 3".
5. Tap +Add round at the block bottom. Verify each member gets a 4th set (carry-forward applied, `done=false`).
6. Mark all 4 sets across all 3 members. Block header reads "4 / 4 ✓".

Out-of-order test:
1. Reset to fresh 3-member superset.
2. Mark Face Pull set 1 done first → no timer.
3. Mark Cable Row set 1 done → no timer.
4. Mark Lateral Raise set 1 done → **timer fires** (the last tap that brought min-done to 1).

- [ ] **Step 6: Commit**

```bash
git add js/data.js js/ui.js
git commit -m "$(cat <<'EOF'
ui+data: block-level +Add round; rest timer fires on last-of-round only

Adds the +Add round button at the block bottom — one tap adds a set
to every member via addRoundToBlockMembers (carry-forward applies per
member). Rest timer is now gated by shouldFireRestForBlockMember:
within a superset, the timer only fires on the done-tap that brings
min(completed-set-count) across members up by one. Out-of-order
member taps still resolve correctly because the gate checks the
state, not the order of taps.

Round indicator on the block header (Round N of M) updates on every
re-render via the existing buildDay / buildAdHocDay path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Drag-to-reorder — within block + block-as-unit at day level

Members can be reordered inside a block. The whole block can be reordered among other day exercises. Cross-group drags are disabled.

**Files:**
- Modify: `js/ui.js` — SortableJS attach hook (search for `Sortable.create` or `new Sortable`).

- [ ] **Step 1: Read the existing SortableJS setup**

```bash
grep -n "Sortable\|data-sort-zone" js/ui.js | head
```

The v2.2.5 setup has two zones (prescribed + extras) and one zone for ad-hoc. We add zones for blocks.

- [ ] **Step 2: Add per-block sort zones**

In `renderSupersetBlock` (Task 7), wrap the members list in a sort-zone container:

```js
// Within renderSupersetBlock, change the per-member emission to wrap
// members in a sort-zone div:
h += '<div class="superset-block" data-superset-group="' + escapeAttr(blockMeta.key) + '">';
h += '<div class="superset-block-header">' + /* existing header markup */ + '</div>';
h += '<div class="superset-members-zone" data-sort-zone="superset-' + escapeAttr(blockMeta.key) + '">';
for (var mi = 0; mi < members.length; mi++) {
  /* existing member emission */
}
h += '</div>';
if (!readOnly) h += '<button class="superset-add-round" ... >';
h += '</div>';
```

Each block has its own unique sort-zone so SortableJS won't accept drops from outside.

- [ ] **Step 3: Update the SortableJS attach pass**

Where the existing code calls `Sortable.create` for the prescribed/extras/ad-hoc zones, also iterate `[data-sort-zone^="superset-"]` and attach a Sortable to each. Use the same options as the existing zones (long-press 400ms, disabled inputs/buttons, no cross-zone drops):

```js
var supersetZones = document.querySelectorAll('[data-sort-zone^="superset-"]');
for (var z = 0; z < supersetZones.length; z++) {
  var zone = supersetZones[z];
  Sortable.create(zone, {
    delay: 400,
    delayOnTouchOnly: true,
    filter: 'input,button,textarea,select,.set-row,.rpe-row,.sub-row,.exercise-note-input',
    preventOnFilter: false,
    onEnd: function(evt) {
      // On reorder, mutate plan.data (member order within the block) +
      // workouts.superset_groups (exercise_orders ordering matches the new member order).
      // Then call buildDay(currentDay) or buildAdHocDay(currentDay) to re-render.
      // The existing pattern (set-remap two-phase shift via +10000 to dodge the
      // partial unique index) is NOT needed here because we don't mutate
      // sets.exercise_order — only the in-memory grouping. But if the
      // existing setup re-keys plan exercise indices, mirror that pattern.
      onMemberReordered(evt);
    }
  });
}
```

- [ ] **Step 4: Add `onMemberReordered`**

```js
async function onMemberReordered(evt) {
  // evt.from / evt.to / evt.oldIndex / evt.newIndex describe the move.
  // Use the data-superset-group attribute on the parent block to identify
  // which group was reordered. Then re-derive member exercise_orders
  // from the new DOM order.
  var blockEl = evt.from.closest ? evt.from.closest('.superset-block') : null;
  if (!blockEl) return;
  // Collect new member order from the DOM.
  var memberEls = blockEl.querySelectorAll('[data-member-ei]');
  var newMemberEis = [];
  for (var i = 0; i < memberEls.length; i++) {
    newMemberEis.push(parseInt(memberEls[i].getAttribute('data-member-ei'), 10));
  }
  // Apply the new order via a data-layer helper that reorders members
  // in plan.data + rewrites workouts.superset_groups.
  var di = currentDay;
  try {
    await applySupersetReorderMembers(di, blockEl.getAttribute('data-superset-group'), newMemberEis);
    if (isAdHocKey(di)) {
      buildAdHocDay(di);
    } else {
      buildDay(di);
    }
  } catch (err) {
    console.error('onMemberReordered error:', err);
    showToast("Couldn't reorder: " + (err.message || 'unknown'), null);
  }
}
```

- [ ] **Step 5: Add `applySupersetReorderMembers` to data.js**

```js
async function applySupersetReorderMembers(di, groupKey, newMemberEisInOrder) {
  // Within the block, reorder exercises[] to match the new ei order.
  // This is purely metadata — no sets are moved (members keep their
  // exercise_order values, which determine stable identity in the sets
  // table).
  if (isAdHocKey(di)) {
    var state = findAdHoc(di);
    if (!state) return;
    // Ad-hoc: just rewrite superset_groups exercise_orders ordering.
    // The DOM gave us the new order; persist it.
    var groups = [];
    var seenGroupKeys = {};
    var orderedKeys = Object.keys(state.exercises).sort(function(a, b) {
      return parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10);
    });
    for (var i = 0; i < orderedKeys.length; i++) {
      var ek = orderedKeys[i];
      var ex = state.exercises[ek];
      var ei = parseInt(ek.slice(3), 10);
      if (!ex.supersetGroup) continue;
      if (ex.supersetGroup !== groupKey) {
        if (!seenGroupKeys[ex.supersetGroup]) {
          seenGroupKeys[ex.supersetGroup] = true;
          // Rebuild this group's orders from its existing membership.
          var oth = [];
          for (var ek2 in state.exercises) {
            if (state.exercises[ek2].supersetGroup === ex.supersetGroup) {
              oth.push(parseInt(ek2.slice(3), 10));
            }
          }
          groups.push({orders: oth.sort(function(a,b){return a-b;}), rest: ex.supersetRest || 60});
        }
      } else if (!seenGroupKeys[groupKey]) {
        seenGroupKeys[groupKey] = true;
        groups.push({orders: newMemberEisInOrder, rest: ex.supersetRest || 60});
      }
    }
    var payload = groups.map(function(g) { return {exercise_orders: g.orders, rest: g.rest}; });
    var wr = await sb.from('workouts').update({superset_groups: payload}).eq('id', state.workoutId);
    if (wr.error) throw new Error(wr.error.message);
    _restateFromSupersetGroups(state, payload);
    return;
  }

  // Plan-day: reorder members within the block in plan.data.
  if (!plan || !plan.days || !plan.days[di]) throw new Error('Plan day not found');
  var dayPlan = plan.days[di];
  var resolved = _resolveFlatEi(dayPlan, [newMemberEisInOrder[0]]);
  if (!resolved || !resolved[0] || resolved[0].memberIdx < 0) return;
  var blockIdx = resolved[0].blockIdx;
  var block = JSON.parse(JSON.stringify(dayPlan.exercises[blockIdx]));

  // Map old ei → block.exercises[oldMemberIdx]. Since the block's
  // members occupy contiguous flat eis (Task 5 invariant), the offset
  // is the smallest member's old ei.
  var oldOrders = [];
  var flatI = 0;
  for (var ki = 0; ki < dayPlan.exercises.length; ki++) {
    if (ki === blockIdx) {
      for (var ci = 0; ci < block.exercises.length; ci++) { oldOrders.push(flatI); flatI++; }
      break;
    }
    var entry = dayPlan.exercises[ki];
    if (entry && entry.superset === true) flatI += entry.exercises.length;
    else flatI++;
  }
  var oldOrderToMemberIdx = {};
  for (var oi = 0; oi < oldOrders.length; oi++) oldOrderToMemberIdx[oldOrders[oi]] = oi;

  var newMembers = newMemberEisInOrder.map(function(newEi) {
    var srcMemberIdx = oldOrderToMemberIdx[newEi];
    return block.exercises[srcMemberIdx];
  });
  block.exercises = newMembers;

  var newDay = JSON.parse(JSON.stringify(dayPlan));
  newDay.exercises[blockIdx] = block;
  var newPlan = JSON.parse(JSON.stringify(plan));
  newPlan.days[di] = newDay;
  var pr = await sb.from('plans').update({data: newPlan}).eq('id', activePlanId);
  if (pr.error) throw new Error(pr.error.message);
  plan = newPlan;
  planCache[activePlanId] = plan;

  // Note: workouts.superset_groups doesn't need rewriting because
  // reordering members within a block doesn't change exercise_orders
  // (the contiguous range is unchanged; only plan.data's member order
  // changed). The next render reads supersetGroup from plan structure.
  // BUT: stateFromWorkout assigns badge order based on exercise_orders
  // ordering, so we DO need to rewrite superset_groups so the new
  // member order shows correct A1/A2/A3 labels in the renderer.
  var todayPlanState = todayPlanStates[di];
  if (todayPlanState && todayPlanState.workoutId) {
    var newGroups = supersetGroupsFromPlanDay(newDay);
    var wr2 = await sb.from('workouts').update({superset_groups: newGroups})
      .eq('id', todayPlanState.workoutId);
    if (wr2.error) throw new Error(wr2.error.message);
    _restateFromSupersetGroups(todayPlanState, newGroups);
  }
}
```

This is the trickiest helper. The plan-day path mutates `plan.data` block.exercises[] order. The ad-hoc path rewrites `workouts.superset_groups` exercise_orders ordering. Either way, the next render shows the new member order with correct A1/A2/A3 labels.

- [ ] **Step 6: Verify parse**

```bash
node --check js/ui.js && node --check js/data.js
```

- [ ] **Step 7: Browser smoke test**

1. Create a 3-member superset.
2. Long-press a member card. Lift. Drop in a different position within the block.
3. Verify reorder persists (re-render shows new order, badges A1/A2/A3 reflect new positions).
4. Try to drag a member out of the block (drop on a standalone). Verify the drop is rejected (member stays in the block).

For day-level block reorder: long-press the block HEADER (not a member card). Lift the whole block. Drop somewhere else among day exercises. The whole block moves together.

Actually — wait. The current SortableJS setup keys on `data-sort-zone="plan"` for the day-level zone. Members of a block have `data-member-ei` and live inside `data-sort-zone="superset-<key>"`. The block CONTAINER (`<div class="superset-block">`) sits inside the day-level zone alongside standalone exercise cards. So the day-level zone's existing draggable items are individual cards; the block is one item there.

For the long-press-the-header to work, the block container needs to be a draggable item in the day-level zone, with the block-header acting as a drag handle. The default SortableJS behavior (drag from anywhere in the item) works if we just register the block as a draggable in the day-level zone — long-press on member cards would trigger the block-level drag, but the per-block sort zone we registered above takes priority (long-press on a member starts the within-block drag).

This is a UX subtlety. For v1, the simpler model is: register a `handle` selector on the day-level Sortable so only the block header (and the regular card chrome of standalone cards) can initiate the day-level drag. SortableJS's `handle` option is the right knob.

```js
// In the day-level Sortable setup:
Sortable.create(planDayZone, {
  delay: 400,
  filter: 'input,button,textarea,select,.set-row,.rpe-row,.sub-row,.exercise-note-input,.superset-members-zone,.superset-add-round',
  // NEW: only allow drag-init from card-header or block-header
  handle: '.exercise-header,.superset-block-header',
  ...
});
```

Adapt the existing setup to add `handle`.

- [ ] **Step 8: Commit**

```bash
git add js/ui.js js/data.js
git commit -m "$(cat <<'EOF'
ui+data: drag-to-reorder superset members + block-as-unit at day level

Members can be reordered within a block via long-press → lift → drop
in a per-block sort zone. The block as a whole can be moved among
other day exercises via long-press on the block header (the day-level
Sortable now uses a handle selector so member cards do not
accidentally trigger the day-level drag). Cross-group drops are
disabled because each block has its own unique sort-zone id; SortableJS
refuses drops from outside zones.

applySupersetReorderMembers updates plan.data block.exercises ordering
(plan-day) or rewrites workouts.superset_groups exercise_orders
ordering (ad-hoc). The next render shows correct A1/A2/A3 labels for
the new member order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: System prompt — `## SUPERSETS` section

Teach Claude how to emit the block format and when to use it. Opportunistic rules: antagonist pairs, accessory finishers, time-constrained sessions. Avoid heavy-compound pairs and beginner cardio mixes.

**Files:**
- Modify: `system-prompt-plan.md` — add new `## SUPERSETS` section.

- [ ] **Step 1: Read the current prompt structure**

```bash
grep -n "^## " system-prompt-plan.md
```

Identify where `## DROP SETS` ends and `## CARDIO PRESCRIPTION` begins. Insert the new section between them.

- [ ] **Step 2: Insert the new section**

Add this between `## DROP SETS` and `## CARDIO PRESCRIPTION` in `system-prompt-plan.md`:

````markdown
## SUPERSETS

Supersets — two or more exercises performed back-to-back with rest only after the last partner — are an effective tool for antagonist pairing, accessory finishers, and time-constrained sessions. Giant sets (3+ exercises) follow the same format and rules. Use them OPPORTUNISTICALLY: prescribe at most 1-2 supersets per training day, and only when they fit the goal.

**Format**: superset blocks live as a single entry in the day's `exercises[]` array. Marked with `"superset": true`, a block-level `rest`, and a child `exercises[]` array of normal exercise objects (each with their own `name`, `sets`, optional `note`, and weight respecting weight_mode).

```json
{
  "superset": true,
  "rest": 60,
  "exercises": [
    {"name": "Cable Row", "sets": [{"weight": 120, "reps_target": 12, "repeat": 3}]},
    {"name": "Lateral Raise", "note": "Triple drop on last set: 20→15→10.", "sets": [
      {"weight": 20, "reps_target": 12, "repeat": 2},
      {"weight": 20, "reps_target": 10},
      {"weight": 15, "reps_target": 8, "set_type": "drop"},
      {"weight": 10, "reps_target": 6, "set_type": "drop"}
    ]}
  ]
}
```

- The block-level `rest` is the inter-round rest in seconds. Members do NOT have their own `rest` field — emit only at the block level. Members carrying `rest` will be rejected.
- The `repeat: N` shorthand works inside member sets exactly as in regular exercises.
- Drop sets inside a member's `sets` array are allowed and encouraged on isolation members (the chain is internal to the member; cascade-on-parent-done unchanged from the standalone case).
- Exactly one `superset` block per `exercises[]` entry — do NOT nest blocks.

**When to prescribe (opportunistic rules):**

- **Antagonist pairs are the natural fit.** Chest+back, biceps+triceps, quad+hamstring isolation. The opposing muscles allow each member to recover while the other works.
- **Accessory finishers on isolation movements.** Lateral raise + face pull. Calf raise + tibialis raise. Bicep curl + tricep pushdown. Use as the last 1-2 exercises of a session for high-volume metabolic stress.
- **Time-constrained sessions.** When `Target session duration` is short relative to the prescribed volume, use 1-2 supersets to compress accessory work.

**Avoid:**

- **Pairing two heavy compound lifts.** Bench + squat in a superset is a bad idea — fatigue compounds across systems and form degrades. Compounds belong in standalone slots with full rest.
- **Cardio inside supersets unless the user explicitly asked.** Mixing strength + cardio in one block disrupts both modalities; keep cardio standalone.
- **Beginner clients still establishing technique.** Supersets reduce form-checking time per set. Default to standalone for novices; the client profile's `experience_level` field is the signal.

**Cadence:**

- At most 1-2 supersets per training day. Don't spam them — most exercises should remain standalone.
- Hypertrophy / accumulation phases are the natural home. Cut and pre-cut benefit when duration is tight. Strength blocks should generally stay non-superset on the main lifts.

**Member count:**

- Default 2 members. Most supersets are pairs.
- Tri-sets (3 members) when there's a clear three-way grouping — push/pull/isolate, or three-angle accessory finishers.
- Avoid 4+ members except on explicit user request. Beyond 3 the workout becomes a circuit, which the app treats as a separate (unsupported in v1) format.
````

Adjust the example to match an exercise pair that exists in the user's library at the time of writing — pulling library names verbatim is required (per the existing AVAILABLE EXERCISES rule).

- [ ] **Step 3: No parse check needed (markdown)**

The system prompt is plain markdown. Verify with a render-check:

```bash
head -1 system-prompt-plan.md && wc -l system-prompt-plan.md
```

The Vercel function bundles `system-prompt-*.md` via `vercel.json` `includeFiles`. Hot-reload doesn't apply to prompt files in `vercel dev` — kill + restart required after editing. Pushed deploys pick up changes correctly.

- [ ] **Step 4: Generate a plan that prescribes a superset**

In the Generate flow, set Notes: `"Hypertrophy block, antagonist pairs welcome on accessories"`. Submit. Verify the response contains a `{superset: true, ...}` block somewhere in `days[].exercises[]`. Validator should accept it (it does, per Task 2).

If the plan response is rejected by the validator (422 error), re-read the validator code and the AI's emission to see what mismatched. Common gotchas: child carrying its own `rest`, missing `superset: true`, single-member block.

- [ ] **Step 5: Commit**

```bash
git add system-prompt-plan.md
git commit -m "$(cat <<'EOF'
prompt(plan): add SUPERSETS section to plan-mode system prompt

Teaches Claude the block JSON format and the opportunistic prescription
rules: antagonist pairs, accessory finishers, time-constrained sessions
get supersets; heavy-compound pairs and beginner cardio mixes do not.
At most 1-2 supersets per training day; default 2 members, tri-sets
when there is a clear three-way grouping. Drop sets inside members
are explicitly allowed.

Causes a one-time Anthropic prompt-cache invalidation on first call
after deploy (~35-45s); warm thereafter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Coach context — `_formatPlanForCoach` + `formatCurrentPlan` walk blocks

The coach prompts (chat + plan/analyze/refine via `formatCurrentPlan`) need to mention supersets in their inline plan rendering so the AI sees the grouping.

**Files:**
- Modify: `js/data.js` — `_formatPlanForCoach`.
- Modify: `api/generate-plan.js` — `formatCurrentPlan`.
- Modify: `js/data.js` — `getLiveContext` — emit `(superset)` tag on member lines.

- [ ] **Step 1: Read the existing helpers**

```bash
grep -n "_formatPlanForCoach\|formatCurrentPlan\|getLiveContext" js/data.js api/generate-plan.js | head
```

Both walk `plan.days[di].exercises[]` and emit per-exercise text lines.

- [ ] **Step 2: Update `_formatPlanForCoach` (js/data.js)**

In the per-exercise iteration, branch on `entry.superset === true`:

```js
// Within _formatPlanForCoach, in the day-exercises iteration:
var entry = day.exercises[ei];
if (entry && entry.superset === true && Array.isArray(entry.exercises)) {
  var memberStrs = entry.exercises.map(function(child) {
    var sets = Array.isArray(child.sets) ? child.sets : [];
    var first = sets[0] || {};
    var rt = first.reps_target || first.reps_range || '?';
    var w = first.weight != null ? first.weight : '';
    var ws = w !== '' ? ' @' + w : '';
    return child.name + ' ' + sets.length + '×' + rt + ws;
  });
  exStrs.push('⟷ ' + memberStrs.join(' / ') + ' (' + (entry.rest || 60) + 's rest)');
  continue;
}
// Existing per-exercise emission below:
// var first = sets[0] || {};  ...
```

(`exStrs` is the accumulator the existing function uses — match the actual variable name.)

- [ ] **Step 3: Update `formatCurrentPlan` (api/generate-plan.js)**

Same logic, server-side. Find `formatCurrentPlan` (line 615 per earlier grep) and add the same branch. The output format the AI consumes is plaintext like:

```
Day 1 — Pull: Pull-up 3×8, ⟷ Cable Row 3×12 @120 / Lateral Raise 3×12 @20 (60s rest), Tricep Pushdown 3×10
```

- [ ] **Step 4: Update `getLiveContext` (js/data.js)**

`getLiveContext` emits per-exercise prescribed-vs-actual lines for the live coach chat. Tag superset members:

```js
// In the per-exercise emission within getLiveContext, after building the
// existing line `prefix + name + presc + actuals`:
var ek = 'ex_' + ei;
var exState = state.exercises[ek];
if (exState && exState.supersetGroup) {
  line += ' (superset)';
}
```

- [ ] **Step 5: Verify parse**

```bash
node --check js/data.js && node --check api/generate-plan.js
```

- [ ] **Step 6: Browser smoke test**

1. Open a plan with at least one superset (use a recent AI generation from Task 13 or merge two cards manually).
2. Open Coach Chat. Send: `"What's the day's plan?"`.
3. Verify the response references the superset structure naturally — e.g., "today is Day 1 with a Cable Row + Lateral Raise superset for accessory volume."
4. Server-side: any plan/analyze/refine generation now has `formatCurrentPlan` emitting superset blocks correctly. Verify by running another Refine and reading the WHAT CHANGED banner — Claude should reference the superset by name if it's relevant.

- [ ] **Step 7: Commit**

```bash
git add js/data.js api/generate-plan.js
git commit -m "$(cat <<'EOF'
coach: walk superset blocks in plan-format helpers + live context tag

_formatPlanForCoach (js/data.js) and formatCurrentPlan
(api/generate-plan.js) now emit superset blocks inline as
"⟷ Member1 / Member2 / Member3 (Ns rest)" so Haiku and Sonnet see
the grouping in chat, plan-gen, analyze, and refine contexts.
getLiveContext tags member lines with "(superset)" so the live coach
context preserves the same signal mid-session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Final smoke test + APP_VERSION → v3.4.0

Walk the full smoke-test plan from the spec (24 cases). Bump version on success.

**Files:**
- Modify: `js/app.js` — `APP_VERSION`.

- [ ] **Step 1: Run the spec's full smoke test**

Open `/Users/sebastianvelez/workout-tracker/docs/superpowers/specs/2026-05-02-supersets-design.md`. Walk all 24 cases under `## Test plan (manual browser smoke test)`. For each, follow the steps and confirm the expected outcome. Group:

- **Plan-time** (1-3): AI prescribes 2-member, 3-member, validator rejects bad shape.
- **Mid-session** (4-15): merge, separate, dissolve, +Add round, asymmetric +Add set, rest timer last-of-round, out-of-order, drop-inside-superset, drag within block, drag block at day level, cross-group drag fails.
- **Swap** (16): per-member swap inside a block leaves block intact.
- **Ad-hoc** (17): build superset from scratch in a blank session.
- **History** (18-20): block-preserved, survives plan changes, survives plan deletion.
- **View Recent / Coach Chat** (21-22): tag rendering, coach references blocks.
- **Templates** (23-24): save/use template containing supersets.

If any case fails, stop and fix before continuing. Re-run that case until it passes.

- [ ] **Step 2: Bump APP_VERSION**

In `js/app.js`, change:

```js
var APP_VERSION = 'v3.3.0';
```

(or whatever the current value is — read the file first) to:

```js
var APP_VERSION = 'v3.4.0';
```

This is the next minor bump. Per project version conventions (memory: `feedback_versioning.md`), milestone bundles use the minor version; supersets is a milestone-grade feature.

- [ ] **Step 3: Final hard-reload sanity check**

Verify the bottom-right footer shows `v3.4.0`. Spot-check a few non-superset workflows (regular set log, regular swap, drop set on a standalone exercise) to confirm no regressions.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
v3.4.0 -- first-class supersets across plan, session, history, AI

Adds superset blocks (any N members) to the plan JSON shape and a new
workouts.superset_groups jsonb column for per-workout block persistence.
Mid-session pairing via the chain-link icon in the card header opens
a picker scoped to other-on-day items; merge collapses two flat entries
or appends to an existing block. Separate pops members; the block
dissolves at N=1. +Add round adds a set to every member; the rest
timer fires only on the last-of-round done-tap. Drag-to-reorder works
within a block and at the day level (block-as-unit). History detail
renders blocks read-only via the persistence column, surviving plan
changes and deactivation. AI prescribes opportunistically per a new
SUPERSETS section in system-prompt-plan.md (antagonist pairs,
accessory finishers, time-constrained sessions; avoids heavy-compound
pairs and beginner mixes). Drop sets inside superset members work
unchanged because the cascade walks the member local sets array.

Spec: docs/superpowers/specs/2026-05-02-supersets-design.md
Plan: docs/superpowers/plans/2026-05-04-supersets.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Hand off to user for push approval**

Per project workflow conventions, do NOT push. Surface the commit log:

```bash
git log --oneline origin/main..HEAD
```

Report the commits and ask whether to push.

---

## Self-review checklist

- [x] **Spec coverage:**
  - Surface 1 (Plan JSON shape) → Tasks 2 (validator), 3 (expandSetRepeats).
  - Surface 2 (Schema migration) → Task 1.
  - Surface 3 (In-memory state) → Task 4.
  - Surface 4 (Mid-session interactions): ⟷ icon + merge → Task 9; separate → Task 10; +Add round + rest timer → Task 11; drag → Task 12; render → Tasks 6 (CSS), 7 (renderer).
  - Surface 5 (AI prescription): system prompt → Task 13; validator → Task 2; expandSetRepeats → Task 3; Coach + formatCurrentPlan → Task 14.
  - Surface 6 (History rendering) → Task 8.
  - Surface 7 (Templates): not its own task — covered by the existing template flow because plans serialize plan.data; superset blocks survive the round trip naturally. Verified by spec test 23-24, run in Task 15.
  - Drop-sets-inside-superset (in-v1 callout) → covered by Task 11 rest-timer logic + Task 15 spec test 12.
- [x] **Placeholder scan:** No "TBD", "TODO", "implement later", "add appropriate error handling", "similar to Task N", or vague phrases. Every code step shows actual code; refactors are described concretely.
- [x] **Type / name consistency:**
  - `supersetGroup` (string key like `'g0'`) used consistently in state across Tasks 4, 7, 9, 10, 11, 12, 14.
  - `supersetRest` (number, seconds) used consistently in state.
  - `superset_groups` (snake_case, jsonb column) used consistently in DB queries and `supersetGroupsFromPlanDay`.
  - `applySupersetMerge` / `applySupersetSeparate` / `applySupersetReorderMembers` / `addRoundToBlockMembers` / `_resolveFlatEi` / `_restateFromSupersetGroups` named consistently and called from the right places.
  - `groupRunsForRender` / `renderSupersetBlock` / `renderPlanDayExerciseCard` / `renderAdHocExerciseCard` / `renderHistoryExerciseCard` named consistently across UI tasks.
  - `openSupersetPicker` / `onMergeIntoSuperset` / `onRemoveFromSuperset` / `onAddRoundToBlock` / `onMemberReordered` named consistently in UI tasks and click delegate.
  - `data-superset-group`, `data-add-round`, `data-member-ei`, `data-edit-superset-rest`, `data-target-ei` HTML attributes used consistently in render and click delegate.
  - `.superset-block`, `.superset-block-header`, `.superset-member`, `.superset-members-zone`, `.superset-add-round`, `.superset-badge`, `.ex-superset-btn`, `.ex-superset-btn.in-block` class names consistent across CSS (Task 6) and renderer (Tasks 7, 8).
- [x] **Workflow rules from project memory honored:** small focused commits per task; verify with `node --check`; bump APP_VERSION only at the end; manual browser smoke test before each commit; no auto-push.
- [x] **No automated tests written:** the project has no test framework. `node --check` for parsing + browser smoke tests + DevTools console probes. All steps reflect this.
