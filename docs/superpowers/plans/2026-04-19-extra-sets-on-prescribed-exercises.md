# Extra Sets on Prescribed Exercises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a "+ Add Set" button beneath every prescribed exercise on editable plan-day sessions. Added sets carry a per-set `isExtra: true` flag, render with a 3px accent left border and a ✕ delete button. Prescribed sets stay immutable from the UI.

**Architecture:** Four in-memory + one on-write change in `js/data.js` (addExtraSet, addExerciseToSession, stateFromWorkout, buildSetPayload, deleteSet). One small render extension in `js/ui.js` (`buildDay`: append extras + button after prescribed loop; `renderSetRow`: emit `.set-extra` class when `sl.isExtra`). CSS for `.set-row.set-extra`. Everything else composes from existing patterns — the `.add-set-btn` click delegate at `js/ui.js:1755` already dispatches to `addExtraSet(ei)`, so no new wiring.

**Tech Stack:** Single-file HTML + 5 JS modules under `js/`. No build step, no test runner — verification is manual browser smoke-testing.

**Reference spec:** [docs/superpowers/specs/2026-04-19-extra-sets-on-prescribed-exercises-design.md](../specs/2026-04-19-extra-sets-on-prescribed-exercises-design.md)

---

## Testing approach

No automated test framework in this project. Verification is a manual browser smoke-test at each task checkpoint plus the full spec checklist at Task 6. Every JS edit is syntax-checked with `node --check` before commit.

---

## File structure

**Modify:**
- `js/data.js` — `addExtraSet`, `addExerciseToSession`, `stateFromWorkout`, `buildSetPayload`, `deleteSet`.
- `js/ui.js` — `renderSetRow` (add `.set-extra` class), `buildDay` (render extras + "+ Add Set" button for prescribed exercises; include extras in progress totals).
- `index.html` — new CSS rule for `.set-row.set-extra`; bump `APP_VERSION` to `v2.0.17` in `js/app.js`.
- `HANDOFF.md` — bump live version, add v2.0.17 summary.
- `ROADMAP.md` — remove the now-closed "Extra sets on prescribed exercises" item.

**Do not create new files.** JS stays in the 5 existing modules; CSS in `index.html`.

---

## Task 1: Data-layer changes (isExtra flag + payload branching + delete guard)

**Files:**
- Modify: `js/data.js` at these sites: `stateFromWorkout` (lines 141-182), `buildSetPayload` (lines 576-?), `addExerciseToSession` (~line 808), `addExtraSet` (line 827), `deleteSet` (line 838).

### Step 1: `stateFromWorkout` — stamp per-set `isExtra`

- [ ] Open `js/data.js`. Find `stateFromWorkout` starting at line 141. Locate the set insertion block at lines 172-176:

```javascript
    state.exercises[ek].sets[s.set_order] = {
      setId: s.id, weight: s.weight, reps: s.reps, done: !!s.done,
      exerciseId: s.exercise_id,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
```

- [ ] Replace those 4 lines with this block (computes `isExtra` per set: ad-hoc workout OR extras-exercise OR set_order past the prescribed count):

```javascript
    var isExtraOnPlanExercise = false;
    if (!isAdHocWorkout && planLen && s.exercise_order < planLen) {
      var presc = pinnedPlan.days[row.day_index].exercises[s.exercise_order];
      var prescSetCount = (presc && presc.sets) ? presc.sets.length : 0;
      if (prescSetCount > 0 && s.set_order >= prescSetCount) {
        isExtraOnPlanExercise = true;
      }
    }
    var setIsExtra = isAdHocWorkout || isExtraOnPlan || isExtraOnPlanExercise;
    state.exercises[ek].sets[s.set_order] = {
      setId: s.id, weight: s.weight, reps: s.reps, done: !!s.done,
      exerciseId: s.exercise_id,
      startedAt: s.started_at, completedAt: s.completed_at,
    };
    if (setIsExtra) state.exercises[ek].sets[s.set_order].isExtra = true;
```

### Step 2: `addExtraSet` — always stamp `isExtra: true`

- [ ] In `js/data.js`, find `addExtraSet` at line 827:

```javascript
function addExtraSet(ei) {
  if (viewModeFor(currentDay) !== 'editable') return;
  if (!todayState || !todayState.exercises['ex_' + ei]) return;
  todayState.exercises['ex_' + ei].sets.push({});
  buildDay(currentDay);
}
```

- [ ] Change the push line to:

```javascript
  todayState.exercises['ex_' + ei].sets.push({ isExtra: true });
```

### Step 3: `addExerciseToSession` — stamp initial set

- [ ] In `js/data.js`, find `addExerciseToSession` at line 808. Locate the exercise object initialization — look for the line that reads `sets: [{}]`:

```javascript
    sets: [{}],
```

- [ ] Change it to:

```javascript
    sets: [{ isExtra: true }],
```

### Step 4: `buildSetPayload` — branch on per-set `isExtra`

- [ ] In `js/data.js`, find `buildSetPayload` at line 576. Locate the ad-hoc-or-extras branch (around the `if (todayState.isAdHoc || exState.isExtra)` check).

- [ ] Replace the if-else that selects prescription values with this version (extend the ad-hoc/extras-exercise branch to also catch per-set extras on prescribed exercises):

```javascript
  var slRef = exState.sets[si] || {};
  var isExtraSet = todayState.isAdHoc || exState.isExtra || slRef.isExtra;
  var exerciseId, prescribedWeight, prescribedReps;
  if (isExtraSet) {
    // No prescription for this set. Extras on prescribed exercises share the
    // prescribed exercise's exercise_id via the cache lookup; ad-hoc and
    // extras-exercise cases carry exerciseId on the in-memory state directly.
    if (todayState.isAdHoc || exState.isExtra) {
      exerciseId = exState.exerciseId;
    } else {
      exerciseId = exerciseIdCache[normName(plan.days[di].exercises[ei].name)];
    }
    prescribedWeight = null;
    prescribedReps = null;
  } else {
    var ex = plan.days[di].exercises[ei];
    var set = ex.sets[si];
    exerciseId = exerciseIdCache[normName(ex.name)];
    prescribedWeight = set.weight != null ? set.weight : null;
    prescribedReps = set.reps_target != null ? set.reps_target : null;
  }
```

### Step 5: `deleteSet` — relax the guard

- [ ] In `js/data.js`, find `deleteSet` at line 838. Locate lines 843-845 (three consecutive lines):

```javascript
  if (!exState.isExtra && !todayState.isAdHoc) return;  // safety: only user-added
  var sl = exState.sets[si];
  if (!sl) return;
```

- [ ] Replace those three lines with (reorders so `sl` is fetched before the guard, which now accepts per-set `isExtra` as a valid deletion path):

```javascript
  var sl = exState.sets[si];
  if (!sl) return;
  if (!sl.isExtra && !exState.isExtra && !todayState.isAdHoc) return;  // safety: only user-added
```

The rest of `deleteSet` continues using the existing `sl` variable.

### Step 6: Syntax check

- [ ] Run:

```bash
node --check js/data.js && echo OK
```

Expected: `OK` printed.

### Step 7: Commit

- [ ] Stage and commit:

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
Add per-set isExtra flag + payload/delete-guard branching

- stateFromWorkout stamps sl.isExtra = true on every hydrated set
  that is ad-hoc, extras-exercise, or beyond prescribed count.
- addExtraSet always pushes { isExtra: true }.
- addExerciseToSession stamps isExtra on the initial set.
- buildSetPayload branches on per-set isExtra so extras on prescribed
  exercises write with null prescribed_weight/prescribed_reps and
  reuse the prescribed exercise's exercise_id.
- deleteSet accepts per-set isExtra as a valid delete path so extras
  on prescribed exercises can be removed without touching prescribed.
No UI changes yet; wired up in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: CSS for `.set-extra`

**Files:**
- Modify: `index.html` (CSS block near `.set-row` rules ~line 207).

### Step 1: Add `.set-extra` rule

- [ ] Open `index.html`. Find `.set-row:first-child` at line 215:

```css
.set-row:first-child { border-top: none; }
```

- [ ] Insert this rule immediately after it (before the next `.set-row` variant — probably around line 216):

```css
.set-row.set-extra {
  border-left: 3px solid var(--accent);
  padding-left: calc(14px - 3px);
}
```

The `padding-left` tweak preserves the existing horizontal alignment after consuming 3px for the accent.

### Step 2: Browser smoke-check the CSS

- [ ] Hard-reload. No behavior change yet (no JS is emitting `set-extra` class).
- [ ] In DevTools console, run:

```javascript
var row = document.querySelector('.set-row');
if (row) row.classList.add('set-extra');
```

- [ ] The first set row on the current card should grow a 3px accent left border. Remove it:

```javascript
row.classList.remove('set-extra');
```

### Step 3: Commit

- [ ] Stage and commit:

```bash
git add index.html
git commit -m "$(cat <<'EOF'
Add .set-row.set-extra CSS rule (left accent border)

3px accent-colored left border for extra set rows. Padding adjusted
so the inner layout stays aligned with prescribed rows. Not yet
emitted from any render path; wiring lands next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `renderSetRow` emits `.set-extra` class when `sl.isExtra`

**Files:**
- Modify: `js/ui.js` (`renderSetRow` at line 61, specifically the `.set-row` opening tag at line 68).

### Step 1: Change the row class

- [ ] Open `js/ui.js`. Find line 68:

```javascript
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + '">';
```

- [ ] Replace with (adds `set-extra` when `sl.isExtra` is truthy — independent of deletable, which stays as-is):

```javascript
  var extraCls = sl && sl.isExtra ? ' set-extra' : '';
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + extraCls + '">';
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 3: Browser smoke-test

- [ ] Hard-reload.
- [ ] Open any ad-hoc session (or create a new blank session from the start modal). The exercise picker opens; pick any exercise. The first set row should now render with the 3px accent left border (because `addExerciseToSession` stamps `isExtra: true` on the initial set).
- [ ] Tap "+ Add Set" on that ad-hoc exercise. The new row should also have the accent.
- [ ] Switch to a plan-day exercise. Prescribed sets should NOT have the accent.
- [ ] Open a plan day that has a legacy extras-exercise already added (a "+ Add exercise" from before today). Its rows should also now have the accent after this reload (because `stateFromWorkout` stamps `isExtra` from the per-exercise `isExtra` flag).

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
renderSetRow emits .set-extra when sl.isExtra

Drives the 3px accent border for any extra set — ad-hoc, extras-exercise,
or (after the next task) extras appended to a prescribed exercise.
Delete-button rendering unchanged (driven by the deletable arg).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Render extras + "+ Add Set" on prescribed exercises

**Files:**
- Modify: `js/ui.js` (`buildDay` — prescribed-exercise loop at lines 257-294).

### Step 1: Update exercise-total computation

- [ ] In `js/ui.js`, find the prescribed-exercise loop starting at line 257. Locate lines 260-264 (the current `exState` init + totals computation):

```javascript
    var exState = (state && state.exercises[ek]) || { sets: [], rpe: null, note: '', sub: '' };
    ts += ex.sets.length;
    var dn = 0;
    for (var s = 0; s < exState.sets.length; s++) { if (exState.sets[s] && exState.sets[s].done) dn++; }
    cs += dn;
```

- [ ] Replace with (extends the per-exercise total to include extras so progress counts are accurate):

```javascript
    var exState = (state && state.exercises[ek]) || { sets: [], rpe: null, note: '', sub: '' };
    var exTotal = Math.max(ex.sets.length, exState.sets.length);
    ts += exTotal;
    var dn = 0;
    for (var s = 0; s < exState.sets.length; s++) { if (exState.sets[s] && exState.sets[s].done) dn++; }
    cs += dn;
```

### Step 2: Update the per-exercise status badge to use `exTotal`

- [ ] Still in the prescribed-exercise loop, find line 265-267:

```javascript
    var ad = dn === ex.sets.length, sd = dn > 0 && !ad;
    var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
    var stat = ad ? dn + '/' + ex.sets.length + ' ✓' : dn + '/' + ex.sets.length;
```

- [ ] Replace with:

```javascript
    var ad = dn === exTotal, sd = dn > 0 && !ad;
    var sc = ad ? 'complete' : sd ? 'partial' : 'pending';
    var stat = ad ? dn + '/' + exTotal + ' ✓' : dn + '/' + exTotal;
```

### Step 3: Render extras + "+ Add Set" after prescribed sets loop

- [ ] In `js/ui.js`, find the end of the prescribed-sets loop at line 282:

```javascript
    for (var si = 0; si < ex.sets.length; si++) {
      var set = ex.sets[si];
      var sl = exState.sets[si] || {};
      var pr = fmtP(set);
      h += renderSetRow(di, ei, si, sl, set, weightMode, dis, pr);
    }

    h += '<div class="rpe-row">'
```

- [ ] Insert the extras + button block between the loop's closing `}` and the `<div class="rpe-row">` line. The full surrounding context after insertion should look like:

```javascript
    for (var si = 0; si < ex.sets.length; si++) {
      var set = ex.sets[si];
      var sl = exState.sets[si] || {};
      var pr = fmtP(set);
      h += renderSetRow(di, ei, si, sl, set, weightMode, dis, pr);
    }

    // Extras on this prescribed exercise: sets past the plan-defined count.
    // sl.isExtra is set on these by addExtraSet / stateFromWorkout. Delete
    // button is rendered via the deletable flag; prescribed rows above stay
    // immutable.
    for (var siExtra = ex.sets.length; siExtra < exState.sets.length; siExtra++) {
      var slExtra = exState.sets[siExtra] || {};
      h += renderSetRow(di, ei, siExtra, slExtra, null, weightMode, dis, '—', !readOnly);
    }
    if (mode === 'editable') {
      h += '<button class="add-set-btn" data-add-set-ei="' + ei + '">+ Add Set</button>';
    }

    h += '<div class="rpe-row">'
```

### Step 4: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 5: Browser smoke-test — the main event

- [ ] Hard-reload.
- [ ] Open any editable plan-day session (Day N). Every prescribed exercise card now shows a "+ Add Set" button below the last prescribed row.
- [ ] Tap "+ Add Set" on an exercise that has 3 prescribed sets. A 4th row appears with the accent left border + ✕ delete button. Set label should read "S4".
- [ ] Enter weight/reps on the 4th row, tap Done. Row persists. Reload — still there, still accented, still deletable.
- [ ] Tap the ✕ on the 4th row. Confirm dialog → row disappears from UI and DB. Reload — still gone.
- [ ] Add two extras (S4 and S5). Tap Done on both. Tap ✕ on S4. Confirm. S5 should renumber to S4 in the DB (its `set_order` updated from 4 to 3); on reload, it appears as S4.
- [ ] Prescribed rows (S1-S3) NEVER show a ✕ and NEVER have the accent.
- [ ] Progress totals at the bottom of the session view update to include extras. Exercise status badge (e.g. "3/3 ✓") becomes "3/4" when you add an uncompleted extra, then "4/4 ✓" when you complete it.
- [ ] Historical session (past plan day) → no "+ Add Set" button, no delete buttons on any existing extras.

### Step 6: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
Render extras + Add Set button on prescribed exercises

Editable plan-day exercise cards now show a + Add Set button below
their prescribed rows. Added sets render with the accent border and
a delete button; prescribed sets stay untouched. Progress totals and
per-exercise status badges include extras so completion tracking
reflects the real set count the user chose to perform.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Bump `APP_VERSION` + full spec smoke test

**Files:**
- Modify: `js/app.js` (line 10).

### Step 1: Bump version

- [ ] Open `js/app.js`. Find line 10:

```javascript
var APP_VERSION = 'v2.0.16';
```

- [ ] Change to:

```javascript
var APP_VERSION = 'v2.0.17';
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/app.js && echo OK
```

Expected: `OK`.

### Step 3: Full spec smoke test

- [ ] Hard-reload. Footer shows `v2.0.17`.
- [ ] Work through the entire "Manual smoke test checklist" section in [docs/superpowers/specs/2026-04-19-extra-sets-on-prescribed-exercises-design.md](../specs/2026-04-19-extra-sets-on-prescribed-exercises-design.md): add/log, visual diff, delete, edit-after-completion, historical, hydrate reload, regression checks on auto-fill / RPE fanout / add-exercise flow / ad-hoc.
- [ ] If anything fails, STOP. Diagnose and fix with a follow-up commit before proceeding to Task 6.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
Bump APP_VERSION to v2.0.17

Marks the extra-sets-on-prescribed-exercises feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs update + push

**Files:**
- Modify: `HANDOFF.md` (current-version line + post-Session A follow-ups list).
- Modify: `ROADMAP.md` (remove closed item).
- Add: commit the plan file itself (`docs/superpowers/plans/2026-04-19-extra-sets-on-prescribed-exercises.md`).

### Step 1: HANDOFF.md update

- [ ] Open `HANDOFF.md`. Find the current-live-version line:

```markdown
Current live version: **`v2.0.16`** (visible in bottom-right footer). `origin/main` is the source of truth; working tree is clean.
```

- [ ] Change `v2.0.16` to `v2.0.17`.

- [ ] Find the end of the `v2.0.16` bullet in the post-Session A follow-ups section.

- [ ] Insert a new bullet immediately after it:

```markdown
- `v2.0.17` — extra sets on prescribed exercises. Editable plan-day exercise cards now render a "+ Add Set" button beneath the prescribed rows. Added sets carry a per-set `isExtra` flag stamped at `addExtraSet` / `addExerciseToSession` / `stateFromWorkout`, render with a 3px accent left border plus a ✕ delete button, and write to `sets` with null `prescribed_weight` / `prescribed_reps` while reusing the prescribed exercise's `exercise_id`. Prescribed sets stay immutable from the UI (no delete, no shift). Progress totals and per-exercise status badges include extras. No schema change. Design + smoke-test checklist in `docs/superpowers/specs/2026-04-19-extra-sets-on-prescribed-exercises-design.md`; implementation plan in `docs/superpowers/plans/2026-04-19-extra-sets-on-prescribed-exercises.md`.
```

### Step 2: ROADMAP.md — remove the closed item

- [ ] Open `ROADMAP.md`. Find the "Extra sets on prescribed exercises (add-only from plan)" bullet under the "UX improvements" section.

- [ ] Delete that entire bullet (multi-line).

### Step 3: Commit docs + plan file

- [ ] Stage and commit:

```bash
git add HANDOFF.md ROADMAP.md docs/superpowers/plans/2026-04-19-extra-sets-on-prescribed-exercises.md
git commit -m "$(cat <<'EOF'
Document v2.0.17 extra sets on prescribed exercises

- HANDOFF.md: bump current live version, add v2.0.17 summary.
- ROADMAP.md: remove closed UX improvement item.
- Plan file committed alongside the spec for future-session handoff.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Step 4: Push

- [ ] After explicit user approval to push:

```bash
git push origin main
```

- [ ] Verify the push output shows the expected range (spec commit + 5 implementation commits + docs commit).

---

## Non-goals for this plan

- Reordering or deleting prescribed sets.
- Changes to rest timer, session timer, exercise picker, history modal, hamburger menu, or start screen modal.
- Schema migration.
- Auto-prefilling extras from anywhere — they stay whatever the user types.
- kg/lbs unit toggle (separate spec, still tabled).
