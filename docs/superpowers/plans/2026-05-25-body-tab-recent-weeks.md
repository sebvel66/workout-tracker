# Body Tab: Recent Weeks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Recent weeks" section on the Body tab — per-muscle weekly volume as color-coded pill rows with primary/fractional and 4/8/12-week toggles — and remove the standalone Volume Trends modal.

**Architecture:** One-pass data-layer extension in [`fetchVolumeTrends`](../../../js/data.js) (compute both primary and fractional totals in the same query); new render block in [`renderBodyView`](../../../js/ui.js); reuse existing `muscleVolumeBand` / `muscleBandStatus` / `muscleBandStatusCssClass` and `pv-*` CSS classes for coloring; remove the dead Volume Trends modal entry points (markup, CSS, JS, hamburger entry, Log-view card).

**Tech Stack:** Vanilla JS (no build, no test harness — manual verification), Supabase (PostgREST), DOM.

> **Note on TDD:** This project has no automated test harness (vanilla `<script>` includes, no test runner in `package.json`). Steps therefore use explicit **manual verification** in place of automated red/green. Keep commits frequent and per-task.

**Spec:** [docs/superpowers/specs/2026-05-25-body-tab-recent-weeks-design.md](../specs/2026-05-25-body-tab-recent-weeks-design.md)

---

### Task 1: Data — extend `fetchVolumeTrends` to compute both modes in one pass

**Files:**
- Modify: [js/data.js:959-1035](../../../js/data.js#L959-L1035)

**What:** Today's `fetchVolumeTrends` only emits Schoenfeld fractional counts. We need both primary-only and fractional so the new view's mode toggle can re-color without a re-fetch. Same query; extra accumulator.

- [ ] **Step 1: Replace the accumulation loop and return shape**

In [js/data.js](../../../js/data.js), find the `fetchVolumeTrends` function (starts ~line 959). Replace its body from the `var byMuscle = {};` line through the `return { weeks: weeks, ... };` line with:

```js
  // byMuscle (fractional) + byMusclePrimary (primary-only) populated in
  // the same pass. Same counting rules used everywhere else:
  //   primary    — each completed set = 1.0 to ex.muscle_group
  //   fractional — each completed set = 1.0 to ex.muscle_group + 0.5 to
  //                each entry in ex.secondary_muscles
  // Cardio + mobility filtered.
  var byMuscle = {};
  var byMusclePrimary = {};
  var rows = res.data || [];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var ws2 = weekStartForLocalDate(new Date(row.performed_on + 'T00:00:00'));
    var widx = weekIdxByStart[ws2];
    if (widx == null) continue;
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
      var sec = Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : [];
      for (var k = 0; k < sec.length; k++) {
        var mg = sec[k];
        if (!mg || mg === primary || mg === 'cardio' || mg === 'mobility') continue;
        _vtAdd(byMuscle, mg, widx, weeksBack, 0.5);
      }
    }
  }

  // Totals + averages for both modes. Muscle ordering is driven by the
  // fractional total (matches the existing modal + every existing caller).
  var totals = {};
  var averages = {};
  var totalsPrimary = {};
  var averagesPrimary = {};
  var muscles = Object.keys(byMuscle);
  for (var mi = 0; mi < muscles.length; mi++) {
    var mname = muscles[mi];
    var arr = byMuscle[mname];
    var sum = 0;
    for (var aj = 0; aj < arr.length; aj++) sum += arr[aj] || 0;
    totals[mname] = Math.round(sum * 10) / 10;
    averages[mname] = Math.round((sum / weeksBack) * 10) / 10;
    var arrP = byMusclePrimary[mname];
    if (arrP) {
      var sumP = 0;
      for (var ap = 0; ap < arrP.length; ap++) sumP += arrP[ap] || 0;
      totalsPrimary[mname] = Math.round(sumP * 10) / 10;
      averagesPrimary[mname] = Math.round((sumP / weeksBack) * 10) / 10;
    } else {
      totalsPrimary[mname] = 0;
      averagesPrimary[mname] = 0;
    }
  }
  muscles.sort(function(a, b) { return totals[b] - totals[a]; });

  return {
    weeks: weeks,
    muscles: muscles,
    byMuscle: byMuscle,
    byMusclePrimary: byMusclePrimary,
    totals: totals,
    totalsPrimary: totalsPrimary,
    averages: averages,
    averagesPrimary: averagesPrimary,
  };
}
```

Also update the JSDoc-style header comment (~lines 951-958) to document the new fields:

```js
// Returns:
//   {
//     weeks:    [{ weekStart, label }, ...]   // chronological, length = weeksBack
//     muscles:  [muscle_group, ...]            // sorted by fractional total desc
//     byMuscle:        { mg: [n, ...] }        // fractional, one entry per week
//     byMusclePrimary: { mg: [n, ...] }        // primary-only, one entry per week
//     totals / averages:                fractional totals/avgs per muscle
//     totalsPrimary / averagesPrimary:  primary-only totals/avgs per muscle
//   }
```

- [ ] **Step 2: Manual verification — back-compat path**

In the browser at sebvel.app (or local dev), sign in, open DevTools Console, and run:

```js
fetchVolumeTrends(userId, 8).then(d => console.log({
  weeks: d.weeks.length,
  muscles: d.muscles.slice(0, 3),
  hasPrimary: !!d.byMusclePrimary,
  chest_frac: d.byMuscle.chest,
  chest_prim: d.byMusclePrimary.chest,
}));
```

Expected: 8 weeks, top muscles by fractional total, `hasPrimary: true`, chest_frac numbers ≥ chest_prim numbers (fractional includes secondary contribution).

- [ ] **Step 3: Manual verification — existing coach-context formatter still works**

Trigger the coach chat (open the Coach FAB, ask any question that pulls the volume block — e.g., "summarize my recent volume"). Confirm the WEEKLY VOLUME TREND block still renders in the coach context with the same numbers as before. The formatter at [js/data.js:4828](../../../js/data.js#L4828) (`_formatVolumeTrendForCoach`) only reads `weeks`/`muscles`/`byMuscle`/`averages` — unchanged.

- [ ] **Step 4: Commit**

```bash
git add js/data.js
git commit -m "feat(volume-trends): extend fetchVolumeTrends with primary-mode totals"
```

---

### Task 2: UI — render "Recent weeks" section (skeleton + pills + sparkline + avg)

**Files:**
- Modify: [js/ui.js:2733-2820](../../../js/ui.js#L2733-L2820) (`renderBodyView` adds a third section)
- Modify: [js/ui.js:2592-2704](../../../js/ui.js#L2592-L2704) (`_vtSparklineSvg` stays — we'll keep it accessible for the new code path; the removal of the rest of the Volume Trends module happens in Task 5)
- Modify: [index.html:1916-2008](../../../index.html#L1916-L2008) (add `.body-rw-*` CSS)

**What:** Add the new section under "Planned (this week)". No controls, no expand yet — just pill rows + sparkline + avg, defaulting to 8 weeks fractional. Loads async via a slot, like the other Body sections.

- [ ] **Step 1: Add `bodyRecentWeeksState` and helper module**

In [js/ui.js](../../../js/ui.js), insert immediately above `var volumeTrendsState = ...` (currently ~line 2598):

```js
// Body tab "Recent weeks" — historical per-muscle weekly volume on the
// Body tab (v3.6.32+). Replaces the old hamburger Volume Trends modal.
// Shares fetchVolumeTrends data with the now-gone modal. State persists
// window + mode in localStorage so the choice sticks across visits.
var bodyRecentWeeksState = {
  weeks: 8,                 // 4 | 8 | 12
  mode: 'fractional',       // 'primary' | 'fractional'
  data: null,               // last fetchVolumeTrends result
  expandedMuscle: null,     // null | muscle_group (used in Task 4)
  inFlight: false,
};

(function hydrateBodyRecentWeeksState() {
  try {
    var w = parseInt(localStorage.getItem('bodyRecentWeeks.weeks'), 10);
    if (w === 4 || w === 8 || w === 12) bodyRecentWeeksState.weeks = w;
    var m = localStorage.getItem('bodyRecentWeeks.mode');
    if (m === 'primary' || m === 'fractional') bodyRecentWeeksState.mode = m;
  } catch (_) {}
})();
```

- [ ] **Step 2: Wire the section into `renderBodyView`**

In `renderBodyView` ([js/ui.js:2733](../../../js/ui.js#L2733)), find the existing Section 2 ("Planned (this week)") block that ends with `h += '</div>';` after `bodyViewPlannedSlot`. Immediately after that closing `</div>`, before `body.innerHTML = h;`, insert:

```js
  // Section 3: Recent weeks (v3.6.32) — per-muscle weekly volume across
  // the selected window, color-coded against MEV/MAV/MRV bands in the
  // selected mode. Loaded async like the other two sections.
  h += '<div class="body-view-section">';
  h += '<div class="body-view-section-label">Recent weeks</div>';
  h += '<div id="bodyViewRecentWeeksSlot"><div class="body-view-section-empty">Loading…</div></div>';
  h += '</div>';
```

Then, in the same function after the existing async `try { var summary = await fetchWeekSummary(...); ... }` block completes (after the catch), append:

```js
  // Fire the Recent weeks fetch in parallel — it doesn't depend on the
  // week summary. Errors render inline; don't bubble.
  loadAndRenderBodyRecentWeeks();
```

- [ ] **Step 3: Implement the fetch + render orchestrator**

Add these functions in [js/ui.js](../../../js/ui.js) immediately after the existing `renderBodyView` function (right before `// Volume trends dashboard` / wherever you placed the state block — keep them grouped together near the Body view code):

```js
async function loadAndRenderBodyRecentWeeks() {
  var slot = document.getElementById('bodyViewRecentWeeksSlot');
  if (!slot) return;
  if (!userId) {
    slot.innerHTML = '<div class="body-view-section-empty">Sign in to see recent weeks.</div>';
    return;
  }
  if (bodyRecentWeeksState.inFlight) return;
  bodyRecentWeeksState.inFlight = true;
  try {
    var data = await fetchVolumeTrends(userId, bodyRecentWeeksState.weeks);
    bodyRecentWeeksState.data = data;
    renderBodyRecentWeeks();
  } catch (err) {
    console.error('loadAndRenderBodyRecentWeeks error:', err);
    slot.innerHTML = '<div class="body-view-section-empty">Couldn\'t load: ' +
      escapeHtml(err.message || 'unknown error') + '</div>';
  } finally {
    bodyRecentWeeksState.inFlight = false;
  }
}

// Pure-render: takes whatever is in bodyRecentWeeksState.data and paints
// the slot. Used by both the initial fetch and (in Task 3) the mode
// toggle, which re-paints without re-fetching.
function renderBodyRecentWeeks() {
  var slot = document.getElementById('bodyViewRecentWeeksSlot');
  if (!slot) return;
  var data = bodyRecentWeeksState.data;
  if (!data) { slot.innerHTML = '<div class="body-view-section-empty">Loading…</div>'; return; }
  if (!data.muscles || !data.muscles.length) {
    slot.innerHTML = '<div class="body-view-section-empty">No completed sets in the last ' +
      bodyRecentWeeksState.weeks + ' weeks.</div>';
    return;
  }
  var mode = bodyRecentWeeksState.mode;
  var byMuscle = mode === 'primary' ? data.byMusclePrimary : data.byMuscle;
  var averages = mode === 'primary' ? data.averagesPrimary : data.averages;
  var rowsHtml = '';
  for (var mi = 0; mi < data.muscles.length; mi++) {
    var m = data.muscles[mi];
    var arr = byMuscle[m] || [];
    rowsHtml += _bodyRwRowHtml(m, arr, averages[m]);
  }
  slot.innerHTML = rowsHtml;
}

function _bodyRwRowHtml(muscle, weeklyValues, avg) {
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
    pills += '<span class="body-rw-pill ' + cls + '" title="' + escapeAttr(title) + '">' + label + '</span>';
  }
  var avgLabel = (avg == null) ? '—' : ((avg === Math.floor(avg)) ? String(avg) : avg.toFixed(1));
  return '<div class="body-rw-row" data-muscle="' + escapeAttr(muscle) + '">' +
    '<div class="body-rw-muscle">' + escapeHtml(muscle) + '</div>' +
    '<div class="body-rw-pills">' + pills + '</div>' +
    '<div class="body-rw-spark">' + _vtSparklineSvg(weeklyValues) + '</div>' +
    '<div class="body-rw-avg">' + avgLabel + '</div>' +
    '</div>';
}
```

- [ ] **Step 4: Add CSS for the new section**

In [index.html](../../../index.html), find the existing `.body-view-section` rules (search for `.body-view-section`). Append these new rules immediately after that block (or wherever the Body view CSS naturally ends):

```css
/* Body tab "Recent weeks" section (v3.6.32). Per-muscle row: label,
 * horizontally laid-out weekly pills, sparkline, weekly average. Pills
 * reuse the pv-* classes from Body chips so coloring stays consistent
 * across surfaces. Drops the sparkline on narrow viewports. */
.body-rw-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0 10px;
}
.body-rw-controls .body-rw-group {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.body-rw-controls button {
  padding: 6px 10px;
  background: var(--surface2);
  color: var(--text);
  border: 0;
  border-right: 1px solid var(--border);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  cursor: pointer;
}
.body-rw-controls button:last-child { border-right: 0; }
.body-rw-controls button.active {
  background: var(--accent);
  color: var(--bg);
}
.body-rw-row {
  display: grid;
  grid-template-columns: 80px 1fr 60px 40px;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
.body-rw-row:last-child { border-bottom: 0; }
.body-rw-muscle {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.body-rw-pills {
  display: flex;
  gap: 3px;
  overflow-x: auto;
}
.body-rw-pill {
  flex: 0 0 auto;
  min-width: 26px;
  padding: 3px 6px;
  text-align: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  border-radius: 4px;
  white-space: nowrap;
}
.body-rw-spark { color: var(--text2); }
.body-rw-spark .vt-spark { width: 56px; height: 22px; display: block; }
.body-rw-avg {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  text-align: right;
}
/* Narrow viewports: drop the sparkline so pills + avg still fit. */
@media (max-width: 420px) {
  .body-rw-row { grid-template-columns: 70px 1fr 40px; }
  .body-rw-spark { display: none; }
}
```

- [ ] **Step 5: Manual verification — section renders**

Reload the app, navigate to the Body tab. Expected:
1. Below "Planned (this week)" there's a new "Recent weeks" section.
2. One row per muscle that's had completed sets in the last 8 weeks.
3. Each row shows: muscle name on the left, 8 colored pills (one per week, leftmost = oldest, rightmost = current week), small sparkline, weekly-average number.
4. Pill colors should match the per-(muscle, fractional) MEV/MAV/MRV bands — verify by tapping the "What do MEV / MAV / MRV mean?" panel and cross-checking a couple muscles against the ranges table.
5. Hover (desktop) or long-press (mobile) a pill — the `title` should show `MEV X · MAV Y-Z · MRV W (fractional)`.
6. On a narrow viewport (DevTools mobile mode, width 360px), the sparkline disappears; pills + avg still fit.

- [ ] **Step 6: Commit**

```bash
git add js/ui.js index.html
git commit -m "feat(body-tab): add Recent weeks section (pills + sparkline + avg)"
```

---

### Task 3: UI — controls (mode toggle + window toggle) with persistence

**Files:**
- Modify: [js/ui.js](../../../js/ui.js) (extend `renderBodyRecentWeeks` to emit controls; add event handler)

**What:** Render the segmented toggles above the rows. Mode toggle re-paints from cached data (no fetch). Window toggle re-fetches. Both persist to localStorage.

- [ ] **Step 1: Emit controls at the top of `renderBodyRecentWeeks`**

In the `renderBodyRecentWeeks` function added in Task 2, replace the body so it emits controls before the rows. Replace the entire function with:

```js
function renderBodyRecentWeeks() {
  var slot = document.getElementById('bodyViewRecentWeeksSlot');
  if (!slot) return;
  var data = bodyRecentWeeksState.data;
  var html = _bodyRwControlsHtml();
  if (!data) { slot.innerHTML = html + '<div class="body-view-section-empty">Loading…</div>'; return; }
  if (!data.muscles || !data.muscles.length) {
    slot.innerHTML = html + '<div class="body-view-section-empty">No completed sets in the last ' +
      bodyRecentWeeksState.weeks + ' weeks.</div>';
    return;
  }
  var mode = bodyRecentWeeksState.mode;
  var byMuscle = mode === 'primary' ? data.byMusclePrimary : data.byMuscle;
  var averages = mode === 'primary' ? data.averagesPrimary : data.averages;
  for (var mi = 0; mi < data.muscles.length; mi++) {
    var m = data.muscles[mi];
    var arr = byMuscle[m] || [];
    html += _bodyRwRowHtml(m, arr, averages[m]);
  }
  slot.innerHTML = html;
}

function _bodyRwControlsHtml() {
  var mode = bodyRecentWeeksState.mode;
  var weeks = bodyRecentWeeksState.weeks;
  function modeBtn(val, label) {
    var active = val === mode ? ' active' : '';
    return '<button type="button" class="' + (active ? 'active' : '') +
      '" data-rw-mode="' + val + '">' + label + '</button>';
  }
  function weekBtn(val) {
    var active = val === weeks ? ' active' : '';
    return '<button type="button" class="' + (active ? 'active' : '') +
      '" data-rw-weeks="' + val + '">' + val + 'w</button>';
  }
  return '<div class="body-rw-controls">' +
    '<div class="body-rw-group">' + modeBtn('primary', 'Primary') + modeBtn('fractional', 'Fractional') + '</div>' +
    '<div class="body-rw-group">' + weekBtn(4) + weekBtn(8) + weekBtn(12) + '</div>' +
    '</div>';
}
```

- [ ] **Step 2: Wire the click handler**

In [js/ui.js](../../../js/ui.js), find the existing bottom-tab click delegation block (around line 8719: `// Bottom tab navigation` / `document.querySelector('.bottom-tab-bar').addEventListener(...)`). Add immediately after that block (or wherever the body view event wiring sits naturally):

```js
// Recent weeks controls — mode toggle re-paints from cache, window
// toggle re-fetches. Both persist to localStorage.
document.getElementById('bodyView').addEventListener('click', function(e) {
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
    renderBodyRecentWeeks(); // immediately re-render to show "Loading…"
    loadAndRenderBodyRecentWeeks();
  }
});
```

- [ ] **Step 3: Manual verification**

Reload, go to Body tab → Recent weeks. Expected:
1. Two segmented controls visible: `[Primary | Fractional]` and `[4w | 8w | 12w]`. Fractional + 8w active by default.
2. Tap **Primary** → pills re-color instantly (no spinner, no fetch). Numbers change (smaller; integers only). Sparkline reshape reflects the primary trend.
3. Tap **Fractional** → reverts.
4. Tap **4w** → spinner briefly, then 4 pills per row. Tap **12w** → 12 pills per row. Note: on narrow viewports, 12w may horizontally scroll within the pills strip (intentional per spec).
5. Reload the page. The active mode and weeks should match what you last selected.
6. Sign out, sign back in. Selection persists (localStorage survives sign-out unless the app clears it).

- [ ] **Step 4: Commit**

```bash
git add js/ui.js
git commit -m "feat(body-tab): Recent weeks controls — mode + window toggles"
```

---

### Task 4: UI — tap-to-expand row detail

**Files:**
- Modify: [js/ui.js](../../../js/ui.js) (extend `_bodyRwRowHtml`, add expand handler)
- Modify: [index.html](../../../index.html) (CSS for `.body-rw-expand`)

**What:** Tap a muscle row → inline detail panel showing both primary and fractional weekly numbers + the per-mode band readouts. Tap again to collapse. Tapping a different row collapses the current and expands the new.

- [ ] **Step 1: Make rows tappable + render the expanded panel**

In [js/ui.js](../../../js/ui.js), replace the existing `_bodyRwRowHtml` function (from Task 2) with this version that adds an `is-expanded` class and an inline detail block:

```js
function _bodyRwRowHtml(muscle, weeklyValues, avg) {
  var expanded = bodyRecentWeeksState.expandedMuscle === muscle;
  var band = muscleVolumeBand(muscle, bodyRecentWeeksState.mode);
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
    pills += '<span class="body-rw-pill ' + cls + '" title="' + escapeAttr(title) + '">' + label + '</span>';
  }
  var avgLabel = (avg == null) ? '—' : ((avg === Math.floor(avg)) ? String(avg) : avg.toFixed(1));
  var rowHtml = '<button type="button" class="body-rw-row' + (expanded ? ' is-expanded' : '') +
    '" data-rw-muscle="' + escapeAttr(muscle) + '">' +
    '<div class="body-rw-muscle">' + escapeHtml(muscle) + '</div>' +
    '<div class="body-rw-pills">' + pills + '</div>' +
    '<div class="body-rw-spark">' + _vtSparklineSvg(weeklyValues) + '</div>' +
    '<div class="body-rw-avg">' + avgLabel + '</div>' +
    '</button>';
  if (expanded) rowHtml += _bodyRwExpandHtml(muscle);
  return rowHtml;
}

// Inline detail panel for an expanded muscle row — shows BOTH primary
// and fractional weekly numbers plus the per-mode band readout. Lets
// the user compare counts side-by-side without flipping the section's
// global mode toggle.
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
  return '<div class="body-rw-expand">' +
    strip(primArr, 'primary') +
    strip(fracArr, 'fractional') +
    '</div>';
}
```

- [ ] **Step 2: Add expand/collapse handler**

In [js/ui.js](../../../js/ui.js), extend the existing `document.getElementById('bodyView').addEventListener('click', …)` block from Task 3 by adding row-toggle handling at the end of the function body (still inside the same listener):

```js
  var rowBtn = e.target.closest && e.target.closest('[data-rw-muscle]');
  if (rowBtn) {
    var m2 = rowBtn.getAttribute('data-rw-muscle');
    bodyRecentWeeksState.expandedMuscle =
      (bodyRecentWeeksState.expandedMuscle === m2) ? null : m2;
    renderBodyRecentWeeks();
    return;
  }
```

This goes inside the existing click handler, after the mode-toggle / weeks-toggle branches.

- [ ] **Step 3: CSS for the expand panel**

In [index.html](../../../index.html), append to the `body-rw-*` CSS block added in Task 2:

```css
.body-rw-row {
  /* override default <button> styles since rows are now buttons */
  width: 100%;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  text-align: left;
  padding: 6px 0;
}
.body-rw-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.body-rw-row.is-expanded { background: var(--surface2); }
.body-rw-expand {
  padding: 8px 0 12px 80px;  /* indent under the muscle label */
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.body-rw-exp-line {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 8px;
  align-items: center;
}
.body-rw-exp-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.body-rw-exp-band {
  grid-column: 2 / 3;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
}
@media (max-width: 420px) {
  .body-rw-expand { padding-left: 70px; }
}
```

Note: the existing `.body-rw-row` rule from Task 2 will be replaced effectively by the rule above (since we changed the element from `<div>` to `<button>`). If both rules coexist, the later one wins by source order — verify the new `.body-rw-row` declaration comes AFTER the Task 2 one. If unsure, edit the Task 2 rule in place and merge fields.

- [ ] **Step 4: Manual verification**

Reload, Body tab → Recent weeks. Expected:
1. Tap any muscle row → row gets a slightly highlighted background and an inline panel opens below it showing two strips: `PRIMARY [pills…] MEV X · MAV Y-Z · MRV W` and `FRACTIONAL [pills…] MEV X · MAV Y-Z · MRV W`.
2. The pills in the expanded panel are colored per their OWN mode (primary pills against primary band; fractional pills against fractional band) — verify by picking a muscle like shoulders where the two modes differ.
3. Tap the same row again → it collapses.
4. Tap a different row → previous collapses, new one opens.
5. Toggle the section mode (Primary ↔ Fractional) while a row is expanded → expanded row re-renders and stays open; top-row pills re-color; expanded panel still shows both strips.
6. Toggle window (4w → 12w) → expanded muscle persists in state but the section reloads; once data lands, the muscle should re-expand naturally if it's still in the muscle list. (If it's not, no expand renders — acceptable.)
7. Keyboard: Tab to a row → focus ring shows. Enter/Space toggles expand. Screen reader announces "button".

- [ ] **Step 5: Commit**

```bash
git add js/ui.js index.html
git commit -m "feat(body-tab): Recent weeks tap-to-expand per-muscle detail"
```

---

### Task 5: Remove Volume Trends modal — markup, CSS, JS, hamburger entry, log-view card

**Files:**
- Modify: [index.html:1918-2008](../../../index.html#L1918-L2008) (delete `.vt-*` CSS block)
- Modify: [index.html:3731-3740](../../../index.html#L3731-L3740) (delete `#volumeTrendsOverlay` markup)
- Modify: [index.html:3876](../../../index.html#L3876) (delete `#menuVolumeTrends` button)
- Modify: [js/ui.js:2592-2704](../../../js/ui.js#L2592-L2704) (delete `volumeTrendsState`, `openVolumeTrends`, `closeVolumeTrends`, `loadAndRenderVolumeTrends`, `renderVolumeTrendsControls`, `renderVolumeTrends`)
- Modify: [js/ui.js:2952-2968](../../../js/ui.js#L2952-L2968) (`renderLogView` — drop the "Volume trends" card)
- Modify: [js/ui.js:8245-8248](../../../js/ui.js#L8245-L8248) (delete `menuVolumeTrends` click handler)
- Modify: [js/ui.js:8731](../../../js/ui.js#L8731) (drop the `trends` branch in `logViewBody` handler)
- Modify: [js/ui.js:8734-8744](../../../js/ui.js#L8734-L8744) (delete `btnVolumeTrendsClose`, `volumeTrendsOverlay`, and `volumeTrendsBody` handlers)

**What:** Pure removal. The data layer (`fetchVolumeTrends` + `_vtAdd` + `_vtWeekLabel`) and `_vtSparklineSvg` STAY — they're consumed by both the new Recent weeks section and the coach-context formatter.

- [ ] **Step 1: Confirm `_vtSparklineSvg` still has callers**

```bash
grep -n "_vtSparklineSvg\|_vtAdd\|_vtWeekLabel\|fetchVolumeTrends" js/ui.js js/data.js
```

Expected output should still show callers from the new Recent weeks code path and `_formatVolumeTrendForCoach`. If any of those four utilities have ZERO callers after the deletions in subsequent steps, also delete them in this same task — but leave them if anything still calls them. (Most likely: all four remain.)

- [ ] **Step 2: Delete the Volume Trends modal JS in ui.js**

In [js/ui.js](../../../js/ui.js), delete the entire block from the comment `// Volume trends dashboard (v3.5.4)...` through the end of the `_vtSparklineSvg` function — **except** keep `_vtSparklineSvg` intact (it has new callers). So:

- Delete `volumeTrendsState` variable.
- Delete `openVolumeTrends` function.
- Delete `closeVolumeTrends` function.
- Delete `loadAndRenderVolumeTrends` function.
- Delete `renderVolumeTrendsControls` function.
- Delete `renderVolumeTrends` function.
- **KEEP** `_vtSparklineSvg`.

If the comment block at the top documents the modal, replace it with a short comment noting the helper survived because the Body view's Recent weeks section uses it:

```js
// Inline-SVG sparkline. Per-row scaling — each muscle uses its own
// y-axis max so the trend reads regardless of absolute volume. Used by
// the Body tab's "Recent weeks" section (Volume Trends modal removed
// in v3.6.32). ~30 lines of polyline + dots; no chart library.
function _vtSparklineSvg(values) {
```

- [ ] **Step 3: Drop the Volume trends launchpad card in `renderLogView`**

In [js/ui.js](../../../js/ui.js), find `renderLogView` (~line 2955). Replace its body with the History-card-only version:

```js
function renderLogView() {
  var body = document.getElementById('logViewBody');
  if (!body) return;
  var h = '';
  h += '<button class="log-card" type="button" data-log-card="history">';
  h += '<div class="log-card-title">History</div>';
  h += '<div class="log-card-desc">Week-by-week sessions. Tap a workout to see set-level detail or edit retroactively.</div>';
  h += '</button>';
  // Volume trends moved to the Body tab in v3.6.32 — "Recent weeks" section.
  body.innerHTML = h;
}
```

- [ ] **Step 4: Remove the hamburger menu entry**

In [index.html](../../../index.html), find:

```html
<button class="menu-row" id="menuVolumeTrends" type="button">Volume trends</button>
```

Delete that line entirely.

- [ ] **Step 5: Remove the modal markup**

In [index.html](../../../index.html), delete the entire `<div class="modal-overlay" id="volumeTrendsOverlay"> … </div>` block (the 10-line block starting at the line containing `id="volumeTrendsOverlay"`).

- [ ] **Step 6: Remove the .vt-* CSS**

In [index.html](../../../index.html), delete the CSS block starting at the comment `/* Volume trends dashboard (v3.5.4)...` through (and including) the closing `}` of `.vt-loading`. **EXCEPT** keep the `.vt-spark` rule alive — `_vtSparklineSvg` emits the `vt-spark` class. Replace the deleted block with a one-line rule that preserves only what the surviving sparkline needs:

```css
/* Inline-SVG sparkline used by Body tab "Recent weeks" (v3.6.32+). */
.vt-spark { display: block; height: 24px; width: 80px; }
```

- [ ] **Step 7: Remove the event handlers**

In [js/ui.js](../../../js/ui.js), delete:

1. The `document.getElementById('menuVolumeTrends').addEventListener(...)` block (~lines 8245-8248).
2. The `else if (which === 'trends') openVolumeTrends();` line inside the `logViewBody` click handler (so only the `if (which === 'history') openHistory();` branch remains).
3. `document.getElementById('btnVolumeTrendsClose').addEventListener('click', closeVolumeTrends);` (one line).
4. The `document.getElementById('volumeTrendsOverlay').addEventListener(...)` block.
5. The `document.getElementById('volumeTrendsBody').addEventListener(...)` block.

- [ ] **Step 8: Sanity grep for dead references**

```bash
grep -n "volumeTrends\|openVolumeTrends\|closeVolumeTrends\|menuVolumeTrends\|btnVolumeTrendsClose" js/ui.js js/data.js index.html
```

Expected: zero matches. If anything remains, delete it.

- [ ] **Step 9: Manual verification**

1. Reload. Open hamburger menu → "Volume trends" entry is GONE.
2. Bottom tab → Log → only the "History" card renders.
3. Bottom tab → Body → Recent weeks section still works (renders rows, toggles work, expand works).
4. Open browser DevTools console → no errors.
5. Quick lint: check the Coach FAB chat — ask "what's my recent volume?" — the volume-trend block should still appear in the model's response (the data-layer path is unaffected).

- [ ] **Step 10: Commit**

```bash
git add js/ui.js index.html
git commit -m "refactor(body-tab): remove Volume Trends modal (moved into Recent weeks)"
```

---

### Task 6: Version bump + final smoke test + push

**Files:**
- Modify: [js/app.js:10](../../../js/app.js#L10) (`APP_VERSION`)

- [ ] **Step 1: Bump APP_VERSION**

In [js/app.js](../../../js/app.js), replace `var APP_VERSION = 'v3.6.32';` with `var APP_VERSION = 'v3.6.33';` (or whatever the current minor patch is — check `js/app.js` first; the v3.6.32 from the prior analyze-truncation fix may or may not have shipped depending on session timing).

If `v3.6.32` is current, bump to `v3.6.33`. If something newer is current, bump by 1.

- [ ] **Step 2: End-to-end smoke checklist**

Reload at sebvel.app. Walk through:

1. **Body tab loads** — "This week so far" chips render, "Planned (this week)" chips render, "Recent weeks" section renders below.
2. **Pill colors match Body chips** — pick a muscle where the current week is in MAV (green chip in "This week so far"); confirm the rightmost pill in its Recent weeks row is also green.
3. **Mode toggle** — switch to Primary; pills re-color instantly (no fetch latency); numbers are smaller (no secondary contribution). Switch back.
4. **Window toggle** — switch to 4w; spinner briefly, then 4 pills/row. Switch to 12w; 12 pills/row, sparkline still visible on wide viewport (or auto-hidden on phone width).
5. **Expand** — tap a row, see both strips with band readouts. Tap another row, previous collapses. Tap same row, collapses.
6. **Persistence** — pick Primary + 12w, reload page, confirm those stayed selected.
7. **Hamburger** — confirm no "Volume trends" entry.
8. **Log tab** — confirm only "History" card.
9. **Coach chat** — open Coach FAB, ask "summarize recent volume" — expect the volume trend block in the response context (data-layer path unaffected).
10. **DevTools console** — zero errors during any of the above.

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "v3.6.33 -- Body tab Recent weeks (replaces hamburger Volume Trends)"
```

- [ ] **Step 4: Push (only after explicit user approval — per workflow conventions)**

Confirm with the user before:

```bash
git push
```

---

## Self-review notes

- Spec coverage check: every spec section maps to at least one task — data layer (Task 1), section render + pills + sparkline + avg (Task 2), controls + persistence (Task 3), tap-to-expand (Task 4), removals (Task 5), version + smoke (Task 6).
- Type / function name consistency: `fetchVolumeTrends` return shape additions (`byMusclePrimary`, `totalsPrimary`, `averagesPrimary`) are referenced by exactly those names in Tasks 2-4. State property names (`weeks`, `mode`, `data`, `expandedMuscle`, `inFlight`) consistent. CSS class names (`body-rw-row`, `body-rw-pill`, `body-rw-pills`, `body-rw-muscle`, `body-rw-spark`, `body-rw-avg`, `body-rw-controls`, `body-rw-group`, `body-rw-expand`, `body-rw-exp-line`, `body-rw-exp-label`, `body-rw-exp-band`) all used in both HTML emission and CSS rules.
- Responsive: 12w on narrow viewports relies on inner-strip horizontal scroll (`.body-rw-pills` has `overflow-x: auto`). Sparkline drops at ≤420px. Acceptable per spec.
- One known gotcha: Task 4 changes `.body-rw-row` from `<div>` to `<button>` — the Task 2 CSS rule may need updating in place rather than overlayed. Step 3 of Task 4 calls this out explicitly.
