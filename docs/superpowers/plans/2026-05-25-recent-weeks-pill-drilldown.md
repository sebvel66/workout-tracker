# Recent Weeks Pill Drilldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-zero pills in the Body tab's Recent weeks section tappable; drill into completed exercises (any week) and planned-remaining exercises (current week only).

**Architecture:** Extend `fetchVolumeTrends` to carry per-(muscle, week) exercise breakdowns plus current-week done-plan-day indices, all in the same single query. Pills become `<button>`; row root switches from `<button>` to `<div role="button">` to satisfy HTML's no-interactive-children-inside-button rule. Drilldown panel renders inline below the existing two-strip row-expand. Planned-remaining for the current week computes on demand from the in-memory `plan` global + the new done-plan-day data.

**Tech Stack:** Vanilla JS (no build, no test harness — manual verification), Supabase (PostgREST), DOM.

> **Note on TDD:** Project has no automated test harness — steps use explicit **manual verification** in place of red/green TDD. Keep commits frequent and per-task.

**Spec:** [docs/superpowers/specs/2026-05-25-recent-weeks-pill-drilldown-design.md](../specs/2026-05-25-recent-weeks-pill-drilldown-design.md)

---

### Task 1: Data — extend `fetchVolumeTrends` with per-week exercise breakdown + done-plan-day tracking

**Files:**
- Modify: [js/data.js:959-1057](../../../js/data.js#L959-L1057)

**What:** Single-pass extension. Add `name` and `day_index` to the embed/select. Build two new structures alongside the existing accumulators:

1. `byMuscleWeekExercises[muscle][weekIdx] = { exercises: [{ name, sets, role }] }`
2. `donePlanDaysCurrentWeek = Set<int>` — day_index values for `activePlanId` workouts in the latest (current) week.

- [ ] **Step 1: Update the PostgREST select**

In [js/data.js](../../../js/data.js), find the existing select inside `fetchVolumeTrends` (currently around line 979):

```js
  var res = await sb.from('workouts')
    .select('plan_id, performed_on, sets(done, exercise_order, exercises!exercise_id(muscle_group, secondary_muscles))')
    .eq('user_id', userId)
    .gte('performed_on', earliestWeekStart)
    .lte('performed_on', endDate);
```

Replace it with:

```js
  var res = await sb.from('workouts')
    .select('plan_id, day_index, performed_on, sets(done, exercise_order, exercises!exercise_id(name, muscle_group, secondary_muscles))')
    .eq('user_id', userId)
    .gte('performed_on', earliestWeekStart)
    .lte('performed_on', endDate);
```

Two additions: `day_index` at the workout level, `name` inside the exercises embed.

- [ ] **Step 2: Build the per-(muscle, weekIdx) exercise breakdown + done-plan-days during the existing accumulation loop**

The current loop body (~line 994 to ~line 1016) iterates `rows`/`sets`. Replace the entire loop with this version that also populates the new structures:

```js
  var byMuscle = {};
  var byMusclePrimary = {};
  // exercisesByMuscleWeek[muscle][weekIdx] = Map(exerciseName -> { sets, role })
  // Built as a Map keyed by name so multiple workouts using the same exercise
  // in the same week aggregate. Finalized to arrays after the loop.
  var exercisesByMuscleWeek = {};
  // Day indices of the active plan that have been done in the latest week
  // (weekIdx === weeksBack - 1). Used to compute "planned remaining" for
  // the current week's pill drilldown.
  var donePlanDaysCurrentWeek = {};   // dayIndex -> true
  var currentWeekIdx = weeksBack - 1;
  var rows = res.data || [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var ws2 = weekStartForLocalDate(new Date(row.performed_on + 'T00:00:00'));
    var widx = weekIdxByStart[ws2];
    if (widx == null) continue;
    // Current-week, active-plan, real plan day (not ad-hoc) → record the
    // day_index so the planned-remaining computation can skip it.
    if (widx === currentWeekIdx && row.plan_id && row.plan_id === activePlanId
        && row.day_index != null) {
      donePlanDaysCurrentWeek[row.day_index] = true;
    }
    var sets = row.sets || [];
    for (var si = 0; si < sets.length; si++) {
      var s = sets[si];
      if (!s || !s.done) continue;
      var ex = s.exercises;
      if (!ex) continue;
      var primary = ex.muscle_group;
      if (!primary || primary === 'cardio' || primary === 'mobility') continue;
      _vtAdd(byMuscle, primary, widx, weeksBack, 1);
      _vtAdd(byMusclePrimary, primary, widx, weeksBack, 1);
      // Per-(muscle, week) primary exercise contribution.
      _vtAddExercise(exercisesByMuscleWeek, primary, widx, weeksBack, ex.name, 'primary');
      var sec = Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [];
      for (var k = 0; k < sec.length; k++) {
        var mg = sec[k];
        if (!mg || mg === primary || mg === 'cardio' || mg === 'mobility') continue;
        _vtAdd(byMuscle, mg, widx, weeksBack, 0.5);
        _vtAddExercise(exercisesByMuscleWeek, mg, widx, weeksBack, ex.name, 'secondary');
      }
    }
  }
```

Note: this references a new helper `_vtAddExercise` — added in Step 4 below.

Also note: this uses the module-level `activePlanId` global (defined at the top of `data.js`). It's already accessible inside `fetchVolumeTrends`.

- [ ] **Step 3: Finalize the per-cell exercise breakdown (Map → array, sort)**

After the loop, before the existing totals/averages computation (~line 1018), add:

```js
  // Finalize per-(muscle, weekIdx) exercise breakdowns: Map -> array,
  // sorted with primary contributions first (each block desc by sets),
  // then secondary (also desc by sets).
  var byMuscleWeekExercises = {};
  var emKeys = Object.keys(exercisesByMuscleWeek);
  for (var emi = 0; emi < emKeys.length; emi++) {
    var emK = emKeys[emi];
    var weeksArr = exercisesByMuscleWeek[emK];
    var outWeeks = [];
    for (var wj = 0; wj < weeksArr.length; wj++) {
      var cell = weeksArr[wj];   // Map or null
      if (!cell) { outWeeks.push({ exercises: [] }); continue; }
      var list = [];
      cell.forEach(function(v, name) {
        list.push({ name: name, sets: v.sets, role: v.role });
      });
      list.sort(function(a, b) {
        if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
        return b.sets - a.sets;
      });
      outWeeks.push({ exercises: list });
    }
    byMuscleWeekExercises[emK] = outWeeks;
  }
```

- [ ] **Step 4: Add the `_vtAddExercise` helper**

Immediately after the existing `_vtAdd` helper (~line 1059), add:

```js
// Per-(muscle, weekIdx) exercise breakdown accumulator. Uses Map so
// repeated workouts using the same exercise in the same week aggregate
// their done-set count. Promotes role from 'secondary' to 'primary' if
// the muscle ever appears as the primary contribution for this exercise
// in this cell (rare — same exercise typically has a single primary
// muscle, but resolveLibraryRow is the source of truth and could
// change between rows).
function _vtAddExercise(by, muscle, widx, weeksBack, name, role) {
  if (!name) return;
  if (!by[muscle]) {
    by[muscle] = [];
    for (var i = 0; i < weeksBack; i++) by[muscle].push(null);
  }
  if (!by[muscle][widx]) by[muscle][widx] = new Map();
  var cell = by[muscle][widx];
  var entry = cell.get(name);
  if (!entry) {
    cell.set(name, { sets: 1, role: role });
  } else {
    entry.sets += 1;
    // Primary takes precedence if it ever wins.
    if (role === 'primary' && entry.role !== 'primary') entry.role = 'primary';
  }
}
```

- [ ] **Step 5: Update the return statement**

The existing return (~line 1047) currently emits 8 fields. Replace it with:

```js
  return {
    weeks: weeks,
    muscles: muscles,
    byMuscle: byMuscle,
    byMusclePrimary: byMusclePrimary,
    byMuscleWeekExercises: byMuscleWeekExercises,
    donePlanDaysCurrentWeek: donePlanDaysCurrentWeek,
    totals: totals,
    totalsPrimary: totalsPrimary,
    averages: averages,
    averagesPrimary: averagesPrimary,
  };
}
```

- [ ] **Step 6: Update the JSDoc comment**

Find the existing JSDoc block (~line 951-960). Replace with:

```js
// Returns:
//   {
//     weeks:    [{ weekStart, label }, ...]   // chronological, length = weeksBack
//     muscles:  [muscle_group, ...]            // sorted by fractional total desc
//     byMuscle:        { mg: [n, ...] }        // fractional, one entry per week
//     byMusclePrimary: { mg: [n, ...] }        // primary-only, one entry per week
//     byMuscleWeekExercises: { mg: [{ exercises: [{ name, sets, role }] }, ...] }
//                                                // per-(muscle, weekIdx) breakdown for pill drilldown
//     donePlanDaysCurrentWeek: { dayIndex: true }
//                                                // active-plan day indices done in the latest week
//     totals / averages:                fractional totals/avgs per muscle
//     totalsPrimary / averagesPrimary:  primary-only totals/avgs per muscle
//   }
```

- [ ] **Step 7: Syntax + sanity checks**

```bash
node --check /Users/sebastianvelez/workout-tracker/js/data.js
```
Expected: no output.

```bash
grep -n "byMuscleWeekExercises\|donePlanDaysCurrentWeek\|_vtAddExercise" /Users/sebastianvelez/workout-tracker/js/data.js
```
Expected: hits in the function body, return, JSDoc, and helper definition.

- [ ] **Step 8: Commit**

```bash
git -C /Users/sebastianvelez/workout-tracker add js/data.js
git -C /Users/sebastianvelez/workout-tracker commit -m "feat(volume-trends): add per-(muscle, week) exercise breakdown + current-week done-plan-days

Extends fetchVolumeTrends to carry byMuscleWeekExercises and
donePlanDaysCurrentWeek alongside its existing accumulators. Adds
'name' and 'day_index' to the embedded select. Used by the upcoming
Recent weeks pill drilldown to surface contributing exercises +
planned-remaining for the current week.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: UI — pills become buttons; row becomes `<div role="button">`; click + keydown wiring; state field

**Files:**
- Modify: [js/ui.js](../../../js/ui.js) (`bodyRecentWeeksState`, `_bodyRwRowHtml`, click handler, new keydown handler)
- Modify: [index.html](../../../index.html) (new `.body-rw-pill` button reset + `.is-selected` rule)

**What:** Structural refactor so pills can be tappable without nesting interactive elements. Add the `selectedPill` state field. Wire pill click + row keydown. Window/collapse paths clear `selectedPill`.

- [ ] **Step 1: Add `selectedPill` to `bodyRecentWeeksState`**

In [js/ui.js](../../../js/ui.js), find `var bodyRecentWeeksState = { ... };` (~line 2596). Add a `selectedPill: null` field. The state declaration becomes:

```js
var bodyRecentWeeksState = {
  weeks: 8,                 // 4 | 8 | 12
  mode: 'fractional',       // 'primary' | 'fractional'
  data: null,               // last fetchVolumeTrends result
  expandedMuscle: null,     // null | muscle_group
  selectedPill: null,       // null | { muscle, weekIdx } — pill drilldown (v3.7.0)
  inFlight: false,
};
```

- [ ] **Step 2: Switch the row element from `<button>` to `<div role="button">`; rewrite pill emission**

Find `_bodyRwRowHtml` (~line 2923). Replace the entire function with:

```js
function _bodyRwRowHtml(muscle, weeklyValues, avg) {
  var expanded = bodyRecentWeeksState.expandedMuscle === muscle;
  var sel = bodyRecentWeeksState.selectedPill;
  var selectedWeekIdx = (sel && sel.muscle === muscle) ? sel.weekIdx : -1;
  var band = muscleVolumeBand(muscle, bodyRecentWeeksState.mode);
  // Fall back to the other mode's band so we don't render a grey strip
  // when one mode is unconfigured (same fallback policy as _dualChipRowsHtml).
  var bandSource = bodyRecentWeeksState.mode;
  if (!band) {
    var other = bodyRecentWeeksState.mode === 'primary' ? 'fractional' : 'primary';
    var fb = muscleVolumeBand(muscle, other);
    if (fb) { band = fb; bandSource = other + ' (fallback)'; }
  }
  var pills = '';
  for (var wi = 0; wi < weeklyValues.length; wi++) {
    var v = weeklyValues[wi] || 0;
    var label = (v === Math.floor(v)) ? String(v) : v.toFixed(1);
    var cls;
    var title;
    if (v === 0) {
      cls = 'pv-empty';
      title = '0 sets';
    } else if (!band) {
      cls = 'pv-empty';
      title = 'No band for ' + muscle;
    } else {
      cls = muscleBandStatusCssClass(muscleBandStatus(v, band));
      title = 'MEV ' + band.mev + ' · MAV ' + band.mavLow + '-' + band.mavHigh +
              ' · MRV ' + band.mrv + ' (' + bandSource + ')';
    }
    if (v === 0) {
      // Non-interactive: zero pills have nothing to drill into.
      pills += '<span class="body-rw-pill ' + cls + '" title="' + escapeAttr(title) + '">' + label + '</span>';
    } else {
      var selCls = (wi === selectedWeekIdx) ? ' is-selected' : '';
      pills += '<button type="button" class="body-rw-pill ' + cls + selCls +
        '" data-rw-pill="' + wi + '" data-rw-pill-muscle="' + escapeAttr(muscle) +
        '" title="' + escapeAttr(title) + '">' + label + '</button>';
    }
  }
  var avgLabel = (avg == null) ? '—' : ((avg === Math.floor(avg)) ? String(avg) : avg.toFixed(1));
  var rowHtml = '<div class="body-rw-row' + (expanded ? ' is-expanded' : '') +
    '" data-rw-muscle="' + escapeAttr(muscle) + '" role="button" tabindex="0">' +
    '<div class="body-rw-muscle">' + escapeHtml(muscle) + '</div>' +
    '<div class="body-rw-pills">' + pills + '</div>' +
    '<div class="body-rw-spark">' + _vtSparklineSvg(weeklyValues) + '</div>' +
    '<div class="body-rw-avg">' + avgLabel + '</div>' +
    '</div>';
  if (expanded) rowHtml += _bodyRwExpandHtml(muscle);
  return rowHtml;
}
```

Key changes from the existing function:
- Row root: `<button>` → `<div role="button" tabindex="0">`
- Pills: non-zero → `<button>` with `data-rw-pill` + `data-rw-pill-muscle`; zero stays `<span>`
- Selected pill gets `is-selected` class

- [ ] **Step 3: Extend the `#bodyView` click handler with the pill branch + clear-on-collapse**

Find the existing handler (around line 8810). Replace its function body with:

```js
document.getElementById('bodyView').addEventListener('click', function(e) {
  // Pill branch first — pills live INSIDE the row, so stopPropagation
  // prevents the row's collapse/expand from firing on the same click.
  var pillBtn = e.target.closest && e.target.closest('[data-rw-pill]');
  if (pillBtn) {
    e.stopPropagation();
    var pillMuscle = pillBtn.getAttribute('data-rw-pill-muscle');
    var pillWeek = parseInt(pillBtn.getAttribute('data-rw-pill'), 10);
    if (!pillMuscle || !Number.isFinite(pillWeek)) return;
    var cur = bodyRecentWeeksState.selectedPill;
    var same = cur && cur.muscle === pillMuscle && cur.weekIdx === pillWeek;
    if (same) {
      bodyRecentWeeksState.selectedPill = null;
    } else {
      bodyRecentWeeksState.selectedPill = { muscle: pillMuscle, weekIdx: pillWeek };
      bodyRecentWeeksState.expandedMuscle = pillMuscle;  // auto-expand
    }
    renderBodyRecentWeeks();
    return;
  }
  var modeBtn = e.target.closest && e.target.closest('[data-rw-mode]');
  if (modeBtn) {
    var m = modeBtn.getAttribute('data-rw-mode');
    if (m !== 'primary' && m !== 'fractional') return;
    if (m === bodyRecentWeeksState.mode) return;
    bodyRecentWeeksState.mode = m;
    try { localStorage.setItem('bodyRecentWeeks.mode', m); } catch (_) {}
    renderBodyRecentWeeks();
    return;
  }
  var wBtn = e.target.closest && e.target.closest('[data-rw-weeks]');
  if (wBtn) {
    var w = parseInt(wBtn.getAttribute('data-rw-weeks'), 10);
    if (!(w === 4 || w === 8 || w === 12)) return;
    if (w === bodyRecentWeeksState.weeks) return;
    bodyRecentWeeksState.weeks = w;
    try { localStorage.setItem('bodyRecentWeeks.weeks', String(w)); } catch (_) {}
    bodyRecentWeeksState.data = null;
    bodyRecentWeeksState.selectedPill = null;  // weekIdx is invalidated by window change
    renderBodyRecentWeeks(); // immediately re-render to show "Loading…"
    loadAndRenderBodyRecentWeeks();
    return;
  }
  var rowBtn = e.target.closest && e.target.closest('[data-rw-muscle]');
  if (rowBtn) {
    var m2 = rowBtn.getAttribute('data-rw-muscle');
    var wasExpanded = bodyRecentWeeksState.expandedMuscle === m2;
    bodyRecentWeeksState.expandedMuscle = wasExpanded ? null : m2;
    // Collapsing OR switching to a different row clears the pill drill.
    var s = bodyRecentWeeksState.selectedPill;
    if (s && s.muscle !== bodyRecentWeeksState.expandedMuscle) {
      bodyRecentWeeksState.selectedPill = null;
    }
    renderBodyRecentWeeks();
    return;
  }
});
```

Key changes: new pill branch first; window-toggle clears `selectedPill`; row-toggle clears `selectedPill` when the row collapses or switches.

- [ ] **Step 4: Add a keydown handler for Enter/Space on the row**

Immediately after the click handler (right after the `})` that closes the click listener), add:

```js
// Row is a <div role="button"> — supply Enter/Space activation
// manually (native <button> would do this for free).
document.getElementById('bodyView').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var rowEl = e.target.closest && e.target.closest('[data-rw-muscle]');
  if (!rowEl || e.target !== rowEl) return;  // ignore key events on inner buttons
  e.preventDefault();
  rowEl.click();
});
```

- [ ] **Step 5: CSS — pill button reset + `is-selected` ring**

In [index.html](../../../index.html), find the existing `.body-rw-pill` rule (around line 2070). Append immediately AFTER its closing `}`:

```css
button.body-rw-pill { cursor: pointer; border: 0; font: inherit; line-height: inherit; color: inherit; }
.body-rw-pill.is-selected { outline: 2px solid var(--accent); outline-offset: 1px; }
```

Note: `font: inherit; line-height: inherit; color: inherit;` neutralizes default `<button>` typography so button pills look identical to span pills. The existing `.body-rw-pill` rule sets `font-family`/`font-size` explicitly, so font inheritance is mostly defensive.

- [ ] **Step 6: Syntax + sanity checks**

```bash
node --check /Users/sebastianvelez/workout-tracker/js/ui.js
```
Expected: no output.

```bash
grep -n "selectedPill\|data-rw-pill\|role=\"button\"" /Users/sebastianvelez/workout-tracker/js/ui.js
```
Expected: hits in state declaration, `_bodyRwRowHtml`, click handler.

- [ ] **Step 7: Manual verification**

Reload the app, navigate to Body tab → Recent weeks. Expected:
1. Section still renders. All rows look identical to before (no visual regression from the row-element swap).
2. Tapping a non-zero pill: row auto-expands (if collapsed), pill gets a visible outline ring.
3. Tapping the same pill again: ring goes away, row stays expanded.
4. Tapping a different pill in the same row: ring moves to the new pill.
5. Tapping the muscle name area (or anywhere on the row outside a pill): row toggles expand. Collapsing also clears the selected pill (no ring next time the row is expanded).
6. Tapping a pill in row A while row B has an expanded selection: row B collapses (its expandedMuscle is no longer matched), row A expands with the new pill selected.
7. Keyboard: Tab to a row → focus ring on the row. Enter/Space toggles expand. Tab into pills → each pill is keyboard-focusable; Enter/Space tap the pill.
8. Toggling window (4w/8w/12w): selectedPill clears (no ring).
9. Toggling mode (Primary/Fractional): selectedPill persists, ring stays in the same week column.
10. Drilldown panel below the two-strip view: not yet populated (that's Task 3) — for now the expand panel still shows just the two strips, which is fine.

- [ ] **Step 8: Commit**

```bash
git -C /Users/sebastianvelez/workout-tracker add js/ui.js index.html
git -C /Users/sebastianvelez/workout-tracker commit -m "feat(body-tab): make Recent weeks pills tappable (structural)

Non-zero pills become <button> with data-rw-pill + data-rw-pill-muscle;
zero pills stay non-interactive <span>. Row root switches from <button>
to <div role=button> tabindex=0 so nesting buttons inside the row is
valid HTML. Adds keydown handler for Enter/Space on the row. New
bodyRecentWeeksState.selectedPill field tracks the active drill;
window/collapse paths clear it. Drilldown panel content lands in the
next commit — for now selection just toggles the visible ring.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Render COMPLETED drilldown panel

**Files:**
- Modify: [js/ui.js](../../../js/ui.js) (extend `_bodyRwExpandHtml`, add `_bodyRwDrilldownHtml`)
- Modify: [index.html](../../../index.html) (new `.body-rw-drilldown*` CSS)

**What:** When `selectedPill.muscle === muscle`, append a drilldown panel below the existing two-strip view. The panel shows COMPLETED exercises for the selected week. PLANNED REMAINING lands in Task 4.

- [ ] **Step 1: Add `_bodyRwDrilldownHtml` helper**

In [js/ui.js](../../../js/ui.js), immediately after the `_bodyRwExpandHtml` function (which currently ends around line 2996), add:

```js
// Pill drilldown panel (v3.7.0). Shows COMPLETED exercises that
// contributed to the pill's count for the selected week. PLANNED
// REMAINING (current week only) is appended by Task 4.
function _bodyRwDrilldownHtml(muscle, weekIdx) {
  var data = bodyRecentWeeksState.data;
  if (!data) return '';
  var mode = bodyRecentWeeksState.mode;
  var weekLabel = (data.weeks && data.weeks[weekIdx]) ? data.weeks[weekIdx].label : '';
  var weekExercises = (data.byMuscleWeekExercises && data.byMuscleWeekExercises[muscle])
    ? data.byMuscleWeekExercises[muscle][weekIdx]
    : null;
  var exercises = (weekExercises && weekExercises.exercises) ? weekExercises.exercises : [];
  // Filter by mode: primary mode shows only primary contributions;
  // fractional shows both. Contribution math reflects the active mode.
  var filtered = [];
  for (var i = 0; i < exercises.length; i++) {
    var ex = exercises[i];
    if (mode === 'primary' && ex.role !== 'primary') continue;
    filtered.push(ex);
  }
  var total = 0;
  var lines = '';
  for (var j = 0; j < filtered.length; j++) {
    var e = filtered[j];
    var perSet = (mode === 'primary' || e.role === 'primary') ? 1.0 : 0.5;
    var contribution = e.sets * perSet;
    total += contribution;
    var contribLabel = (contribution === Math.floor(contribution))
      ? '+' + contribution
      : '+' + contribution.toFixed(1);
    var secondaryTag = (mode === 'fractional' && e.role === 'secondary')
      ? '<span class="secondary-tag">(secondary)</span>' : '';
    lines += '<div class="body-rw-drill-line">' +
      '<div>' + escapeHtml(e.name) + secondaryTag + '</div>' +
      '<div>' + e.sets + ' sets</div>' +
      '<div>' + contribLabel + '</div>' +
      '</div>';
  }
  var totalLabel = (total === Math.floor(total)) ? String(total) : total.toFixed(1);
  var html = '<div class="body-rw-drilldown">';
  html += '<div class="body-rw-drill-section-label">COMPLETED' +
    (weekLabel ? ' · week of ' + escapeHtml(weekLabel) : '') + '</div>';
  if (filtered.length === 0) {
    html += '<div class="body-rw-drill-line"><div>No completed contributions in this mode.</div><div></div><div></div></div>';
  } else {
    html += lines;
    html += '<div class="body-rw-drill-total">' + totalLabel + ' total</div>';
  }
  html += '</div>';
  return html;
}
```

- [ ] **Step 2: Wire `_bodyRwDrilldownHtml` into `_bodyRwExpandHtml`**

Find `_bodyRwExpandHtml` (currently ends ~line 2996 with `</div>'`). Modify the return statement so that when a pill is selected for THIS muscle, the drilldown is appended:

```js
function _bodyRwExpandHtml(muscle) {
  var data = bodyRecentWeeksState.data;
  if (!data) return '';
  var primArr = (data.byMusclePrimary && data.byMusclePrimary[muscle]) || [];
  var fracArr = (data.byMuscle && data.byMuscle[muscle]) || [];
  function strip(values, mode) {
    var band = muscleVolumeBand(muscle, mode);
    var pills = '';
    for (var i = 0; i < values.length; i++) {
      var v = values[i] || 0;
      var label = (v === Math.floor(v)) ? String(v) : v.toFixed(1);
      var cls;
      if (v === 0) cls = 'pv-empty';
      else if (!band) cls = 'pv-empty';
      else cls = muscleBandStatusCssClass(muscleBandStatus(v, band));
      pills += '<span class="body-rw-pill ' + cls + '">' + label + '</span>';
    }
    var bandTxt = band
      ? ('MEV ' + band.mev + ' · MAV ' + band.mavLow + '-' + band.mavHigh + ' · MRV ' + band.mrv)
      : 'no band';
    return '<div class="body-rw-exp-line">' +
      '<div class="body-rw-exp-label">' + mode + '</div>' +
      '<div class="body-rw-pills">' + pills + '</div>' +
      '<div class="body-rw-exp-band">' + escapeHtml(bandTxt) + '</div>' +
      '</div>';
  }
  var html = '<div class="body-rw-expand">' +
    strip(primArr, 'primary') +
    strip(fracArr, 'fractional') +
    '</div>';
  // Pill drilldown (v3.7.0): appended below the two-strip panel when
  // a pill in THIS muscle's row is selected.
  var sel = bodyRecentWeeksState.selectedPill;
  if (sel && sel.muscle === muscle) {
    html += _bodyRwDrilldownHtml(muscle, sel.weekIdx);
  }
  return html;
}
```

The only change from the existing function: the new `if (sel && sel.muscle === muscle) { html += _bodyRwDrilldownHtml(muscle, sel.weekIdx); }` block before the return.

- [ ] **Step 3: CSS — drilldown panel + lines + total**

In [index.html](../../../index.html), find the existing `.body-rw-exp-band` rule and the `@media (max-width: 420px) { .body-rw-expand ... }` block that follows it (around lines 2110-2125). Immediately AFTER the `@media` block's closing `}`, append:

```css
.body-rw-drilldown {
  padding: 8px 0 12px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.body-rw-drill-section-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding-top: 4px;
}
.body-rw-drill-line {
  display: grid;
  grid-template-columns: 1fr auto 60px;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text);
  align-items: baseline;
}
.body-rw-drill-line .secondary-tag {
  color: var(--text2);
  font-size: 10px;
  margin-left: 4px;
}
.body-rw-drill-total {
  border-top: 1px solid var(--border);
  padding-top: 4px;
  margin-top: 2px;
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
}
```

- [ ] **Step 4: Syntax + sanity checks**

```bash
node --check /Users/sebastianvelez/workout-tracker/js/ui.js
```
Expected: no output.

```bash
grep -n "_bodyRwDrilldownHtml\|body-rw-drill" /Users/sebastianvelez/workout-tracker/js/ui.js /Users/sebastianvelez/workout-tracker/index.html
```
Expected: hits in the helper definition, `_bodyRwExpandHtml` call site, and CSS rules.

- [ ] **Step 5: Manual verification**

Reload app → Body tab. Expected:
1. Tap any non-zero pill on a past week (e.g., week of "5/3"). Below the two-strip panel, a drilldown appears with a `COMPLETED · week of 5/3` header and a list of exercises (name | N sets | +X.X). At the bottom, a total line that matches the tapped pill's number.
2. Switch mode (Primary ↔ Fractional). The drilldown re-renders. In Primary mode, secondary exercises disappear and contributions become integers (1.0 per set). In Fractional mode, secondary entries reappear with `(secondary)` tags and 0.5×sets contribution.
3. Tap a different pill in the same row → drilldown swaps to the new week.
4. Tap the same pill again → drilldown disappears, two-strip panel stays.
5. Collapse the row → drilldown disappears (panel closes entirely).
6. If a muscle has zero primary contribution but non-zero fractional (e.g., shoulders showing 1.5 from secondary contribution): tap the pill in Fractional mode → drilldown lists secondary contributors. Switch to Primary mode → drilldown shows "No completed contributions in this mode." (with empty total).

- [ ] **Step 6: Commit**

```bash
git -C /Users/sebastianvelez/workout-tracker add js/ui.js index.html
git -C /Users/sebastianvelez/workout-tracker commit -m "feat(body-tab): render COMPLETED drilldown panel for selected pill

When a pill is selected, append a drilldown below the two-strip
panel showing exercise name + sets + per-exercise contribution under
the active mode. Total footer matches the pill value so the math is
verifiable at a glance. Secondary contributions tagged in fractional
mode. PLANNED REMAINING for the current week lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: PLANNED REMAINING for current week

**Files:**
- Modify: [js/ui.js](../../../js/ui.js) (extend `_bodyRwDrilldownHtml`, add `_bodyRwPlannedRemainingForMuscle` helper)

**What:** When the selected pill is the rightmost (current week), append a PLANNED REMAINING section below COMPLETED. Source: in-memory `plan` global + `donePlanDaysCurrentWeek` from the data.

- [ ] **Step 1: Add `_bodyRwPlannedRemainingForMuscle` helper**

In [js/ui.js](../../../js/ui.js), immediately BEFORE `_bodyRwDrilldownHtml` (added in Task 3), insert:

```js
// PLANNED REMAINING for the current week (v3.7.0). Iterates the
// active plan's days NOT yet done this week, filters each day's
// exercises by muscle match against the active mode. Superset-aware
// (mirrors _accumulatePlanDayFrac walking logic).
function _bodyRwPlannedRemainingForMuscle(muscle, mode) {
  if (!plan || !Array.isArray(plan.days)) return [];
  var done = (bodyRecentWeeksState.data && bodyRecentWeeksState.data.donePlanDaysCurrentWeek) || {};
  var out = [];
  for (var di = 0; di < plan.days.length; di++) {
    if (done[di]) continue;
    var day = plan.days[di];
    var entries = (day && Array.isArray(day.exercises)) ? day.exercises : [];
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      var leaves = (e && e.superset === true && Array.isArray(e.exercises)) ? e.exercises : [e];
      for (var li = 0; li < leaves.length; li++) {
        var leaf = leaves[li];
        if (!leaf || !leaf.name) continue;
        var setsCount = Array.isArray(leaf.sets) ? leaf.sets.length : 0;
        if (!setsCount) continue;
        var meta = (typeof resolveLibraryRow === 'function')
          ? resolveLibraryRow(leaf.name) : null;
        if (!meta) continue;
        var role = null;
        if (meta.muscle_group === muscle) role = 'primary';
        else if (mode === 'fractional' && Array.isArray(meta.secondary_muscles) && meta.secondary_muscles.indexOf(muscle) !== -1) role = 'secondary';
        if (!role) continue;
        out.push({ name: leaf.name, sets: setsCount, role: role });
      }
    }
  }
  // Sort primary first (desc by sets), then secondary (desc by sets).
  out.sort(function(a, b) {
    if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
    return b.sets - a.sets;
  });
  return out;
}
```

Note: `plan` is the in-memory active-plan blob global (declared at the top of `data.js`/`ui.js` scope chain). `resolveLibraryRow` is the existing exercise-library lookup helper.

- [ ] **Step 2: Extend `_bodyRwDrilldownHtml` to append PLANNED REMAINING when current week**

In the `_bodyRwDrilldownHtml` function (from Task 3), find the closing `html += '</div>';` line (right before `return html`). Replace the final segment of the function (from `html += '</div>';` through `return html;`) with:

```js
  // PLANNED REMAINING (current week only).
  var currentWeekIdx = data.weeks ? data.weeks.length - 1 : -1;
  if (weekIdx === currentWeekIdx) {
    var planned = _bodyRwPlannedRemainingForMuscle(muscle, mode);
    if (planned.length > 0) {
      html += '<div class="body-rw-drill-section-label">PLANNED REMAINING</div>';
      for (var p = 0; p < planned.length; p++) {
        var pe = planned[p];
        var perSetP = (mode === 'primary' || pe.role === 'primary') ? 1.0 : 0.5;
        var contribP = pe.sets * perSetP;
        var contribPLabel = (contribP === Math.floor(contribP))
          ? '+' + contribP
          : '+' + contribP.toFixed(1);
        var tagP = (mode === 'fractional' && pe.role === 'secondary')
          ? '<span class="secondary-tag">(secondary)</span>' : '';
        html += '<div class="body-rw-drill-line">' +
          '<div>' + escapeHtml(pe.name) + tagP + '</div>' +
          '<div>' + pe.sets + ' sets prescribed</div>' +
          '<div>' + contribPLabel + '</div>' +
          '</div>';
      }
    }
  }
  html += '</div>';
  return html;
}
```

The function structure becomes: open `.body-rw-drilldown`, render COMPLETED, conditionally render PLANNED REMAINING, close `.body-rw-drilldown`. The closing `</div>` was previously the last line; now it's after the planned-remaining block.

- [ ] **Step 3: Syntax + sanity checks**

```bash
node --check /Users/sebastianvelez/workout-tracker/js/ui.js
```
Expected: no output.

```bash
grep -n "_bodyRwPlannedRemainingForMuscle\|PLANNED REMAINING" /Users/sebastianvelez/workout-tracker/js/ui.js
```
Expected: helper definition + call site + section label string.

- [ ] **Step 4: Manual verification**

Reload app → Body tab → Recent weeks. Pre-conditions: be signed in with an active plan that has remaining days this week.

1. Tap the rightmost (current-week) pill for a muscle with both completed sets this week AND remaining plan days that include exercises for that muscle (e.g., chest if today is a chest day that hasn't been done).
2. COMPLETED list appears as before.
3. Below it: `PLANNED REMAINING` section with the planned exercises from the not-yet-done days. Each line: `Exercise Name · N sets prescribed · +X.X`.
4. Switch mode to Primary → planned-remaining list filters to primary contributors only; contribution numbers become integers.
5. Switch mode to Fractional → secondary contributors reappear with `(secondary)` tag and 0.5×sets contribution.
6. Tap a past-week pill → NO PLANNED REMAINING section (past weeks only show COMPLETED).
7. If you complete a workout day (e.g., do today's chest day and mark it complete), the next time you re-enter the Body tab and tap the chest pill, that day's exercises should no longer appear under PLANNED REMAINING (because the day moved into the done set). Note: this requires a re-fetch of fetchVolumeTrends — re-entry triggers it only if window/data have changed, OR if you toggle the window and back. Acceptable for v3.7.0; could be tightened in a follow-up.
8. If no remaining days have exercises for this muscle → PLANNED REMAINING section is OMITTED entirely (no empty header).

- [ ] **Step 5: Commit**

```bash
git -C /Users/sebastianvelez/workout-tracker add js/ui.js
git -C /Users/sebastianvelez/workout-tracker commit -m "feat(body-tab): PLANNED REMAINING section in current-week pill drilldown

For the current (rightmost) week, append exercises from the active
plan's not-yet-done days that target the muscle in the active mode.
Superset-aware. Section is suppressed when there are no remaining
contributors so we don't render an empty header. Past-week pills
remain unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: APP_VERSION bump + smoke test + final commit

**Files:**
- Modify: [js/app.js:10](../../../js/app.js#L10) (`APP_VERSION`)

- [ ] **Step 1: Bump APP_VERSION**

In [js/app.js](../../../js/app.js), replace:

```js
var APP_VERSION = 'v3.6.34';
```

with:

```js
var APP_VERSION = 'v3.7.0';
```

(If `v3.6.34` is no longer current — e.g., another minor patch landed between brainstorming and implementation — replace whatever the current value is with `v3.7.0`.)

- [ ] **Step 2: End-to-end smoke checklist**

Reload at sebvel.app (or local dev). Walk through:

1. **Body tab loads** — chips render, Recent weeks renders.
2. **Pill tap (past week)** — drilldown appears below the two-strip panel. COMPLETED list + total. No PLANNED REMAINING.
3. **Pill tap (current week)** — both COMPLETED and PLANNED REMAINING appear.
4. **Mode toggle while pill selected** — drilldown re-renders correctly; primary mode hides secondaries; fractional shows them.
5. **Pill swap** — tap another pill in the same row, drilldown swaps.
6. **Pill toggle off** — tap selected pill again, drilldown closes, two-strip panel stays.
7. **Row collapse** — tap row label/area, row closes, selectedPill cleared (re-expand shows no ring).
8. **Window toggle** — switching 4w→12w clears the selected pill.
9. **Keyboard** — Tab to a row, Enter expands. Tab into pills, Enter selects a pill.
10. **Zero pills not tappable** — visually distinct (faded `pv-empty`), no cursor pointer, no ring on click.
11. **DevTools console** — no errors during any of the above.
12. **No regressions** — Body chips, "Planned (this week)" projections, Coach FAB chat all still work.

- [ ] **Step 3: Commit**

```bash
git -C /Users/sebastianvelez/workout-tracker add js/app.js
git -C /Users/sebastianvelez/workout-tracker commit -m "v3.7.0 -- Recent weeks pill drilldown (completed + planned remaining)

Minor bump marking the Body tab's Recent weeks reaching full
drilldown-capable form. Tap a non-zero pill to see contributing
exercises (any week) and planned-remaining exercises (current week
only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Push (only after explicit user approval)**

Wait for the user's explicit go-ahead before running `git push`.

---

## Self-review notes

- **Spec coverage:**
  - Data layer extension (byMuscleWeekExercises + donePlanDaysCurrentWeek) → Task 1
  - Pills become buttons, row → div role=button → Task 2
  - selectedPill state field, click + keydown wiring, clear-on-collapse/window-change → Task 2
  - COMPLETED drilldown render (with mode filtering, secondary tag, total footer) → Task 3
  - PLANNED REMAINING for current week (with empty-section suppression) → Task 4
  - APP_VERSION → v3.7.0 → Task 5
  - CSS for `.is-selected`, `.body-rw-drilldown*` → split across Tasks 2 and 3
- **Type / name consistency:** State property `selectedPill`, fields `muscle`/`weekIdx`. Data fields `byMuscleWeekExercises` (Map per cell, finalized to array of `{ name, sets, role }`) and `donePlanDaysCurrentWeek` (object as set). Helper names `_bodyRwDrilldownHtml` and `_bodyRwPlannedRemainingForMuscle`. CSS classes `.body-rw-drilldown`, `.body-rw-drill-section-label`, `.body-rw-drill-line`, `.body-rw-drill-total`, `.secondary-tag`. All used consistently across Tasks 2-4.
- **Known limitation:** Once the user completes a plan day mid-session, the planned-remaining list will still show that day's exercises until the next data fetch (cache-on-re-entry from v3.6.33 means switching tabs doesn't auto-refetch). User can force a refresh by toggling the window value. Documented as acceptable for v3.7.0 in Task 4's verification notes.
