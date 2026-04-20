# Flexible Session Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent auto-focus-on-hydrate default with an explicit bottom-sheet start modal that offers a rotation-based suggested day, a pick-from-plan-days list, and a blank-session path. Add a "Start another workout" hamburger item that reopens the same modal. Remove the now-redundant "+ New Session" button.

**Architecture:** Pure JS + HTML/CSS, no schema changes. One extra SELECT per hydrate (`workouts` → most recent completed `day_index`). New bottom-sheet modal follows the existing `.modal-overlay` pattern (same as Hamburger, History, Gym Profiles). Tap handlers reuse existing `focusTab()` and `createAdHocSession()` — zero new data-layer behavior beyond the suggested-day query.

**Tech Stack:** Single-file HTML + 5 JS modules under `js/`. No build step, no test runner — verification is manual browser smoke-testing. Supabase client for the one new query.

**Reference spec:** [docs/superpowers/specs/2026-04-19-flexible-session-start-design.md](../specs/2026-04-19-flexible-session-start-design.md)

---

## Testing approach

This project has no automated test framework. Verification is a browser smoke-test checklist. Each task ends with a focused manual test; the full spec checklist runs once at the end (Task 7). Every JS edit is syntax-checked with `node --check <file>` before commit to catch brace / paren errors before they reach the browser.

---

## File structure

**Modify:**
- `js/data.js` — add `suggestedDayIndex` state var and `loadSuggestedDayIndex()` query function.
- `js/auth.js` — add `suggestedDayIndex = null` to the `applySession` reset block.
- `js/app.js` — hydrate flow: call the new query + gate the modal auto-open; bump `APP_VERSION`.
- `js/ui.js` — add `openStartScreen()` / `closeStartScreen()` + path tap handlers; add hamburger item listener; remove the `btnNewSession` click listener.
- `index.html` — add start-screen modal markup + CSS; add "Start another workout" hamburger item; remove `#btnNewSession` DOM element and its CSS.

**Do not create new files.** The project deliberately keeps JS in the 5 existing modules; `index.html` owns all markup and CSS.

---

## Task 1: Suggested-day query + state var

**Files:**
- Modify: `js/data.js` (add var near other state vars ~line 55; add function near other loaders ~line 258)
- Modify: `js/auth.js` (line 125 reset block)

### Step 1: Add state var in `js/data.js`

- [ ] Open `js/data.js`. Find the block declaring `todayState` at lines 51-55:

```javascript
// todayState: pointer to whichever workout state is currently focused in the
// UI (updated by focusTab). Mutating handlers (toggleSet / logSet / logRPE /
// logNote / logSub / completeSession) operate on todayState so they work
// identically for plan-based and ad-hoc sessions.
var todayState = null;
```

- [ ] Insert these lines **immediately after** line 55 (after the `var todayState = null;` line):

```javascript

// suggestedDayIndex: rotation-based "next day to train" hint for the active
// plan, computed once per hydrate from the most recent completed workout.
// null means "no plan active OR no completed workouts yet" — the start modal
// treats both as "suggest Day 0" for a fresh plan.
var suggestedDayIndex = null;
```

### Step 2: Add `loadSuggestedDayIndex()` in `js/data.js`

- [ ] In `js/data.js`, find `loadRecentExercises()` at line 238 and `bumpRecent()` at line 259. Insert the new function **between** them (after the closing brace of `loadRecentExercises` at line 257, before the `bumpRecent` declaration at line 259).

- [ ] Insert these lines (place the new function immediately after `loadRecentExercises`'s closing brace, with one blank line separating):

```javascript

// Find the most recent completed workout for the active plan and compute the
// next-in-rotation day_index. Run once per hydrate. No-op when there is no
// active plan; leaves suggestedDayIndex at null (start modal treats that as
// "suggest Day 0" for a fresh plan).
async function loadSuggestedDayIndex() {
  if (!activePlanId || !plan || !plan.days || !plan.days.length) {
    suggestedDayIndex = null;
    return;
  }
  var res = await sb.from('workouts')
    .select('day_index')
    .eq('user_id', userId)
    .eq('plan_id', activePlanId)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1);
  if (res.error) {
    // Non-fatal — the modal will just default to Day 0 as the suggestion.
    console.error('loadSuggestedDayIndex error:', res.error);
    suggestedDayIndex = 0;
    return;
  }
  if (!res.data || !res.data.length || res.data[0].day_index == null) {
    suggestedDayIndex = 0;
    return;
  }
  suggestedDayIndex = (res.data[0].day_index + 1) % plan.days.length;
}
```

### Step 3: Reset the state var on sign-in

- [ ] Open `js/auth.js`. Find line 125:

```javascript
    todayState = null; todayPlanStates = {}; todayAdHocs = [];
```

- [ ] Change that line to (appending the `suggestedDayIndex` reset):

```javascript
    todayState = null; todayPlanStates = {}; todayAdHocs = [];
    suggestedDayIndex = null;
```

### Step 4: Syntax check

- [ ] Run:

```bash
node --check js/data.js && node --check js/auth.js
```

Expected: no output (exit code 0). Any syntax error halts and needs fixing before proceeding.

### Step 5: Commit

- [ ] Stage and commit:

```bash
git add js/data.js js/auth.js
git commit -m "Add loadSuggestedDayIndex + suggestedDayIndex state

Rotation-based next-day computation for the forthcoming start modal.
Queries the most recent completed workout for the active plan and
returns (day_index + 1) mod plan.days.length. Graceful fallbacks:
no plan → null, no completed workouts → 0, query error → 0.
Not yet called from hydrate; wired up in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Start-screen modal DOM + CSS

**Files:**
- Modify: `index.html` (CSS block ~before line 660; modal markup ~after line 1319)

### Step 1: Add modal CSS

- [ ] Open `index.html`. Find the end of the `.menu-row.danger` rule at line 672:

```css
.menu-row.danger { color: var(--danger); }

```

- [ ] Insert the following CSS **immediately after** the blank line that follows `.menu-row.danger` (so the new block sits directly before the next rule):

```css
/* Start screen modal (bottom-sheet; three paths: suggested day, pick day, blank) */
.start-modal {
  background: var(--surface);
  border-radius: 20px 20px 0 0;
  padding-bottom: calc(16px + var(--safe-bottom));
  width: 100%; max-width: 500px;
  display: flex; flex-direction: column;
  animation: slideUp 0.3s ease;
}
.start-header {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 14px 12px; border-bottom: 1px solid var(--border);
}
.start-title { font-size: 16px; font-weight: 700; flex: 1; text-align: center; }
.start-close {
  background: transparent; border: none; color: var(--text2);
  font-size: 22px; cursor: pointer; padding: 0 6px; line-height: 1;
  width: 32px; text-align: center;
  -webkit-tap-highlight-color: transparent;
}
.start-close.hidden { visibility: hidden; }
.start-body { display: flex; flex-direction: column; padding: 12px; gap: 10px; }
.start-card {
  display: block; width: 100%;
  padding: 16px;
  border: 2px solid var(--border);
  background: var(--surface2); color: var(--text);
  font-family: 'Outfit', sans-serif;
  font-size: 15px; font-weight: 600;
  text-align: left; cursor: pointer;
  border-radius: 12px;
  -webkit-tap-highlight-color: transparent;
}
.start-card:active { background: var(--surface3); }
.start-card.primary {
  border-color: var(--accent); background: var(--accent);
  color: var(--bg); font-weight: 700;
}
.start-card.primary:active { opacity: 0.85; }
.start-card-title { font-size: 16px; line-height: 1.2; }
.start-card-hint {
  font-size: 12px; font-weight: 500; margin-top: 4px;
  color: inherit; opacity: 0.75;
}
.start-card-badge {
  display: inline-block;
  font-size: 11px; font-weight: 600;
  padding: 2px 8px; margin-left: 8px;
  border-radius: 999px;
  background: var(--surface3); color: var(--text2);
  vertical-align: middle;
}
.start-card-badge.in-progress { background: var(--accent); color: var(--bg); }
.start-daylist { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.start-daylist.hidden { display: none; }
.start-day-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface2); color: var(--text);
  font-size: 14px; font-weight: 500;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.start-day-row:active { background: var(--surface3); }
.start-empty-hint {
  padding: 8px 4px 0;
  font-size: 13px; color: var(--text2);
  text-align: center;
}
.start-import-link {
  display: inline-block;
  margin-top: 8px;
  color: var(--accent);
  font-size: 14px; font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

```

### Step 2: Add modal markup

- [ ] In `index.html`, find the end of the `#menuOverlay` block at lines 1304-1319:

```html
<div class="modal-overlay" id="menuOverlay">
  <div class="menu-modal">
    ...
  </div>
</div>
```

- [ ] Insert this block **immediately after** line 1319 (the closing `</div>` of `#menuOverlay`, before the `#gymProfilesOverlay` block that starts at line 1321):

```html

<div class="modal-overlay" id="startScreenOverlay">
  <div class="start-modal">
    <div class="start-header">
      <div style="width:32px"></div>
      <div class="start-title">Start a workout</div>
      <button class="start-close" id="btnStartClose" type="button">×</button>
    </div>
    <div class="start-body">
      <button class="start-card primary" id="startPathSuggested" type="button">
        <div class="start-card-title" id="startPathSuggestedTitle">Start</div>
        <div class="start-card-hint" id="startPathSuggestedHint"></div>
      </button>
      <button class="start-card" id="startPathPickDay" type="button">
        <div class="start-card-title">Pick a different day</div>
      </button>
      <div class="start-daylist hidden" id="startPathPickDayList"></div>
      <button class="start-card" id="startPathBlank" type="button">
        <div class="start-card-title">Blank session</div>
      </button>
      <div class="start-empty-hint hidden" id="startPathEmptyHint">
        No active plan. Start a blank session, or
        <span class="start-import-link" id="startPathImportLink">import a plan</span>.
      </div>
    </div>
  </div>
</div>
```

### Step 3: Browser smoke-test the markup only

- [ ] Hard-reload the app in the browser. The modal should be **invisible** (no `show` class). No JS has been wired yet.
- [ ] In DevTools console, run:

```javascript
document.getElementById('startScreenOverlay').classList.add('show')
```

- [ ] The modal should appear as a bottom sheet with three cards: "Start" (filled accent), "Pick a different day" (outlined), "Blank session" (outlined). The ✕ button works visually only — no handlers yet.
- [ ] Hide it again:

```javascript
document.getElementById('startScreenOverlay').classList.remove('show')
```

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add index.html
git commit -m "Add start-screen modal DOM + CSS (not yet wired)

Bottom-sheet modal following the existing .modal-overlay pattern.
Three path cards + an empty-state hint for no-active-plan users.
No JS handlers yet; verified by manually adding .show in DevTools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `openStartScreen()` / `closeStartScreen()` + path handlers

**Files:**
- Modify: `js/ui.js` (add functions near other modal openers; add event listeners near other hamburger listeners around line 1380-1391)

### Step 1: Add `openStartScreen` / `closeStartScreen` functions

- [ ] Open `js/ui.js`. Find the `openExerciseHistory` function at line 640. Scroll up to find the last non-renderer function before it (this is where modal openers like `openHistory` live — the file is ordered loosely by feature). Search for `// ---- Per-exercise recent history modal ----` at line 639.

- [ ] Insert this block **immediately before** line 639 (the `// ---- Per-exercise recent history modal ----` comment), leaving a blank line between your new block and that comment:

```javascript
// ---- Start screen modal (flexible session start) ----
function openStartScreen() {
  var overlay = document.getElementById('startScreenOverlay');
  var suggestedBtn = document.getElementById('startPathSuggested');
  var pickDayBtn = document.getElementById('startPathPickDay');
  var pickDayList = document.getElementById('startPathPickDayList');
  var blankBtn = document.getElementById('startPathBlank');
  var emptyHint = document.getElementById('startPathEmptyHint');
  var closeBtn = document.getElementById('btnStartClose');

  // Collapse the day-picker list on every re-open (fresh state each time).
  pickDayList.classList.add('hidden');
  pickDayList.innerHTML = '';

  var hasPlan = !!(plan && plan.days && plan.days.length);
  if (hasPlan) {
    suggestedBtn.style.display = '';
    pickDayBtn.style.display = '';
    emptyHint.classList.add('hidden');
    var si = (suggestedDayIndex != null && suggestedDayIndex >= 0 && suggestedDayIndex < plan.days.length)
      ? suggestedDayIndex : 0;
    var dayName = plan.days[si].name || ('Day ' + (si + 1));
    document.getElementById('startPathSuggestedTitle').textContent = 'Start ' + dayName;
    // Hint: last completed day name + a relative date if we have it in memory.
    // Keep it terse — empty when no prior completion known to the client.
    document.getElementById('startPathSuggestedHint').textContent = '';
    suggestedBtn.setAttribute('data-di', String(si));
  } else {
    suggestedBtn.style.display = 'none';
    pickDayBtn.style.display = 'none';
    emptyHint.classList.remove('hidden');
  }

  // Close affordance: only allowed when there is a fallback state to land on.
  // No-plan + nothing-focused case hides close; user must pick a path.
  var hasFallback = hasPlan || (todayAdHocs && todayAdHocs.length);
  if (hasFallback) {
    closeBtn.classList.remove('hidden');
  } else {
    closeBtn.classList.add('hidden');
  }

  overlay.classList.add('show');
}

function closeStartScreen() {
  document.getElementById('startScreenOverlay').classList.remove('show');
}

function renderStartPathDayList() {
  var list = document.getElementById('startPathPickDayList');
  list.innerHTML = '';
  if (!plan || !plan.days) return;
  for (var i = 0; i < plan.days.length; i++) {
    var d = plan.days[i];
    var name = d.name || ('Day ' + (i + 1));
    var badge = '';
    var st = todayPlanStates[i];
    if (st && st.workoutId) {
      if (st.endedAt) {
        badge = '<span class="start-card-badge">completed today</span>';
      } else if (st.startedAt) {
        badge = '<span class="start-card-badge in-progress">in progress</span>';
      }
    }
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-day-row';
    row.setAttribute('data-di', String(i));
    row.innerHTML = '<span>' + escapeHtml(name) + '</span><span>' + badge + '</span>';
    list.appendChild(row);
  }
}
```

### Step 2: Add the event-listener wiring

- [ ] In `js/ui.js`, find the `menuSignOut` listener at lines 1388-1391:

```javascript
document.getElementById('menuSignOut').addEventListener('click', function() {
  closeMenu();
  sb.auth.signOut();
});
```

- [ ] Insert this block **immediately after** line 1391 (the closing `});` of the `menuSignOut` listener), before the `// Gym Profiles modal wiring.` comment at line 1393:

```javascript

// Start-screen modal wiring.
document.getElementById('btnStartClose').addEventListener('click', closeStartScreen);
document.getElementById('startScreenOverlay').addEventListener('click', function(e) {
  // Only close on overlay tap when close is allowed (close button not hidden).
  if (e.target !== this) return;
  if (document.getElementById('btnStartClose').classList.contains('hidden')) return;
  closeStartScreen();
});
document.getElementById('startPathSuggested').addEventListener('click', function() {
  var di = parseInt(this.getAttribute('data-di'), 10);
  if (isNaN(di)) return;
  closeStartScreen();
  focusTab(di);
  buildTabs();
  buildDay(di);
});
document.getElementById('startPathPickDay').addEventListener('click', function() {
  var list = document.getElementById('startPathPickDayList');
  if (list.classList.contains('hidden')) {
    renderStartPathDayList();
    list.classList.remove('hidden');
  } else {
    list.classList.add('hidden');
  }
});
document.getElementById('startPathPickDayList').addEventListener('click', function(e) {
  var row = e.target.closest('.start-day-row');
  if (!row) return;
  var di = parseInt(row.getAttribute('data-di'), 10);
  if (isNaN(di)) return;
  closeStartScreen();
  focusTab(di);
  buildTabs();
  buildDay(di);
});
document.getElementById('startPathBlank').addEventListener('click', function() {
  closeStartScreen();
  createAdHocSession();
});
document.getElementById('startPathImportLink').addEventListener('click', function() {
  closeStartScreen();
  document.getElementById('fileInput').click();
});
```

### Step 3: Syntax check

- [ ] Run:

```bash
node --check js/ui.js
```

Expected: no output.

### Step 4: Browser smoke-test the interactions

- [ ] Hard-reload the app (expect footer = `v2.0.15` still).
- [ ] In DevTools console, run `openStartScreen()`. The modal should appear and:
  - With a plan active: show the primary "Start [suggested day]" card with the suggested-index day name, then "Pick a different day", then "Blank session".
  - Tap **"Pick a different day"** → list expands with all plan days; tap a day → modal closes and the session view focuses that day (check `currentDay` in console).
  - Tap **"Blank session"** → modal closes, new ad-hoc workout is created (a new `ah_<uuid>` row appears in `todayAdHocs`, picker opens).
  - Re-open modal, tap **"Start [suggested]"** → modal closes, focuses suggested day.
  - Re-open modal, tap the **×** → modal closes with no state change.
- [ ] Verify `suggestedDayIndex` in the console is still whatever it was before the task (no new code has populated it yet — this is expected; defaults to 0 via `renderStartPathDayList` UX fallback).

### Step 5: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "Wire up start-screen modal: openStartScreen + path handlers

Three paths:
- Suggested day → focusTab(suggestedDayIndex) + buildDay
- Pick different day → expand in-place day list, tap → focusTab
- Blank session → createAdHocSession (existing flow)
No-plan state shows only blank session + 'import a plan' link and
hides the close button (user must pick a path).
Modal not yet auto-opened on hydrate; triggered manually for now.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Auto-open modal from hydrate

**Files:**
- Modify: `js/app.js` (hydrate function, lines 50-107)

### Step 1: Call `loadSuggestedDayIndex()` during hydrate

- [ ] Open `js/app.js`. Find line 52:

```javascript
    await loadLocations();
```

- [ ] Insert a new line **immediately after** line 52 (before the `var bounds = sessionBounds();` line at 54):

```javascript
    await loadSuggestedDayIndex();
```

### Step 1b: Open modal in the no-plan early-return branch

- [ ] In `js/app.js`, find the no-plan branch at lines 33-40:

```javascript
    if (!planRes.data) {
      plan = null; activePlanId = null;
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('summaryBar').style.display = 'none';
      document.getElementById('planTitle').textContent = 'Workout Tracker';
      document.getElementById('planWeek').textContent = 'No plan loaded';
      document.getElementById('dayPicker').innerHTML = '';
      return;
    }
```

- [ ] Change that block to (adding the `openStartScreen()` call before the early return — with no plan, `todayAdHocs` is empty and `todayPlanStates` is empty, so the modal shows the blank-session-only empty-state treatment from Task 3):

```javascript
    if (!planRes.data) {
      plan = null; activePlanId = null;
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('summaryBar').style.display = 'none';
      document.getElementById('planTitle').textContent = 'Workout Tracker';
      document.getElementById('planWeek').textContent = 'No plan loaded';
      document.getElementById('dayPicker').innerHTML = '';
      openStartScreen();
      return;
    }
```

### Step 2: Gate auto-open after the default-focus logic

- [ ] In `js/app.js`, find lines 88-102 (the default-focus block plus `buildTabs()` + `buildDay(currentDay)`):

```javascript
    // Default focus: today's plan workout if any, else plan day 0, else first ad-hoc.
    var planDayKeys = Object.keys(todayPlanStates).map(Number).sort(function(a, b) { return a - b; });
    if (planDayKeys.length) {
      currentDay = planDayKeys[0];
    } else if (plan) {
      currentDay = 0;
    } else if (todayAdHocs.length) {
      currentDay = 'ah_' + todayAdHocs[0].workoutId;
    } else {
      currentDay = 0;
    }
    focusTab(currentDay);

    buildTabs();
    buildDay(currentDay);
  } catch(err) {
```

- [ ] Replace those lines with this block (which keeps the same default-focus logic for the underlying render, then evaluates whether to auto-open the modal):

```javascript
    // Default focus: today's plan workout if any, else plan day 0, else first ad-hoc.
    var planDayKeys = Object.keys(todayPlanStates).map(Number).sort(function(a, b) { return a - b; });
    if (planDayKeys.length) {
      currentDay = planDayKeys[0];
    } else if (plan) {
      currentDay = 0;
    } else if (todayAdHocs.length) {
      currentDay = 'ah_' + todayAdHocs[0].workoutId;
    } else {
      currentDay = 0;
    }
    focusTab(currentDay);

    buildTabs();
    buildDay(currentDay);

    // Auto-open the start modal when there is no in-progress session today.
    // "In-progress" = started_at set AND ended_at null on any plan-day or
    // ad-hoc state. Completed sessions do not block the modal.
    var hasInProgress = false;
    for (var di in todayPlanStates) {
      var ps = todayPlanStates[di];
      if (ps && ps.workoutId && ps.startedAt && !ps.endedAt) { hasInProgress = true; break; }
    }
    if (!hasInProgress) {
      for (var j = 0; j < todayAdHocs.length; j++) {
        var as = todayAdHocs[j];
        if (as && as.workoutId && as.startedAt && !as.endedAt) { hasInProgress = true; break; }
      }
    }
    if (!hasInProgress) {
      openStartScreen();
    }
  } catch(err) {
```

### Step 3: Bump `APP_VERSION`

- [ ] In `js/app.js`, find line 10:

```javascript
var APP_VERSION = 'v2.0.15';
```

- [ ] Change to:

```javascript
var APP_VERSION = 'v2.0.16';
```

### Step 4: Syntax check

- [ ] Run:

```bash
node --check js/app.js
```

Expected: no output.

### Step 5: Browser smoke-test the auto-open behavior

- [ ] Hard-reload the app. Footer should show `v2.0.16`.
- [ ] **Case A — fresh state** (no in-progress session today): modal should open automatically on load. If the plan has completed workouts, the suggested day reflects rotation+1.
- [ ] **Case B — in-progress session exists.** Pick any plan day or ad-hoc, tap Done on one set to create a DB workout row (`started_at` set, `ended_at` null). Reload. Modal should **not** open; you land directly on the in-progress session.
- [ ] **Case C — completed today, nothing in progress.** Finish the in-progress session via "Complete Session" (`ended_at` set). Reload. Modal should open again; suggested day should advance by one (rotation+1 mod plan.days.length).
- [ ] **Case D — no active plan.** If you have a test account without a plan (or temporarily deactivate your active plan via the Supabase dashboard), the modal should open on load with only the "Blank session" card + "import a plan" link. Close button hidden; tap-outside disabled.

### Step 6: Commit

- [ ] Stage and commit:

```bash
git add js/app.js
git commit -m "Auto-open start modal on hydrate when no in-progress session (v2.0.16)

Hydrate now runs loadSuggestedDayIndex() once after loading locations,
then after default focus + buildTabs/buildDay, checks whether any
today-state has started_at set and ended_at null. If none, openStartScreen()
is called on top of the already-rendered session view. Completed
workouts don't block; picking up a real mid-workout reload still
lands directly on the session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Hamburger "Start another workout" item

**Files:**
- Modify: `index.html` (menu markup ~line 1311)
- Modify: `js/ui.js` (event listeners ~line 1391)

### Step 1: Add the menu row

- [ ] Open `index.html`. Find the `.menu-body` block at lines 1311-1317:

```html
    <div class="menu-body">
      <button class="menu-row" id="menuImport" type="button">Import Plan</button>
      <button class="menu-row" id="menuExport" type="button">Export Data</button>
      <button class="menu-row" id="menuHistory" type="button">History</button>
      <button class="menu-row" id="menuGymProfiles" type="button">Gym Profiles</button>
      <button class="menu-row danger" id="menuSignOut" type="button">Sign Out</button>
    </div>
```

- [ ] Change to (inserting the new `menuStartAnother` row as the **first** item so "Start another workout" is the primary action of the menu):

```html
    <div class="menu-body">
      <button class="menu-row" id="menuStartAnother" type="button">Start another workout</button>
      <button class="menu-row" id="menuImport" type="button">Import Plan</button>
      <button class="menu-row" id="menuExport" type="button">Export Data</button>
      <button class="menu-row" id="menuHistory" type="button">History</button>
      <button class="menu-row" id="menuGymProfiles" type="button">Gym Profiles</button>
      <button class="menu-row danger" id="menuSignOut" type="button">Sign Out</button>
    </div>
```

### Step 2: Add the listener

- [ ] In `js/ui.js`, find the `menuHistory` listener at line 1380:

```javascript
document.getElementById('menuHistory').addEventListener('click', function() {
  closeMenu();
  openHistory();
});
```

- [ ] Insert the new listener **immediately before** it (above the `menuHistory` listener, below the `menuExport` listener at line 1376-1379):

```javascript
document.getElementById('menuStartAnother').addEventListener('click', function() {
  closeMenu();
  openStartScreen();
});
```

### Step 3: Syntax check

- [ ] Run:

```bash
node --check js/ui.js
```

Expected: no output.

### Step 4: Browser smoke-test

- [ ] Hard-reload.
- [ ] Start a session (tap Done on any set to make it "in progress"). Modal should NOT auto-open on reload (Task 4 behavior preserved).
- [ ] Tap the hamburger (☰). The first row should be "Start another workout".
- [ ] Tap "Start another workout" → hamburger closes, start-screen modal opens over the current session. Pick any path — the original in-progress session's data is untouched in the DB.
- [ ] Verify the hamburger item is visible even in fresh / no-plan / post-completion states.

### Step 5: Commit

- [ ] Stage and commit:

```bash
git add index.html js/ui.js
git commit -m "Add 'Start another workout' hamburger item

Always-available entry point to the start modal. Reopens the same
modal used by hydrate's auto-open path. Placed at the top of the
hamburger so it reads as the primary session-level action.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Remove the "+ New Session" button

**Files:**
- Modify: `index.html` (DOM line 1132, CSS lines 107-121)
- Modify: `js/ui.js` (listener line 1557)

### Step 1: Remove the DOM element

- [ ] Open `index.html`. Find line 1132:

```html
      <button class="new-session-btn" id="btnNewSession" type="button" title="New ad-hoc session">+</button>
```

- [ ] Delete that line entirely. The `.day-picker-row` div now contains only the `<select class="day-picker" id="dayPicker">` — its flex layout still renders correctly with one child.

### Step 2: Remove the CSS

- [ ] In `index.html`, find the CSS block at lines 107-121:

```css
.new-session-btn {
  flex-shrink: 0;
  background: var(--surface2);
  border: 2px dashed var(--border);
  color: var(--text2);
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px; font-weight: 700;
  padding: 0 16px;
  border-radius: 10px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.new-session-btn:active {
  background: var(--surface3); color: var(--text);
}
```

- [ ] Delete lines 107-121 entirely, including the blank line after the `.new-session-btn:active` rule at line 122 (leave exactly one blank line before the `.day-tabs` rule).

### Step 3: Remove the event listener

- [ ] Open `js/ui.js`. Find line 1557:

```javascript
document.getElementById('btnNewSession').addEventListener('click', createAdHocSession);
```

- [ ] Delete that line entirely.

### Step 4: Syntax check

- [ ] Run:

```bash
node --check js/ui.js
```

Expected: no output.

### Step 5: Browser smoke-test

- [ ] Hard-reload. Visual check: the day-picker area should show only the `<select>` dropdown (no `+` button next to it).
- [ ] Open DevTools console:

```javascript
document.getElementById('btnNewSession')
```

Expected: `null` (element removed).

- [ ] "Blank session" path in the start modal should still create an ad-hoc session correctly (this confirms `createAdHocSession` is still reachable).
- [ ] Check the page load console for errors — removing the listener target cannot throw now that it's gone, but confirm no other code paths reference `btnNewSession`.

### Step 6: Commit

- [ ] Stage and commit:

```bash
git add index.html js/ui.js
git commit -m "Remove '+ New Session' button (redundant with Blank session path)

Path 3 of the start modal and the hamburger item both create ad-hoc
sessions via createAdHocSession(). The standalone + button next to
the day dropdown served the same purpose and is no longer needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full smoke test + docs + push

**Files:**
- Modify: `HANDOFF.md` (current live version + post-Session A follow-ups section)

### Step 1: Run the full spec smoke-test checklist

- [ ] Open [docs/superpowers/specs/2026-04-19-flexible-session-start-design.md](../specs/2026-04-19-flexible-session-start-design.md) and work through every checkbox in the "Manual smoke test checklist" section. Expected behavior for each is documented there.
- [ ] If any scenario fails, STOP, diagnose, fix in a follow-up commit before proceeding.

### Step 2: Update `HANDOFF.md`

- [ ] Open `HANDOFF.md`. Find the current-version line:

```markdown
Current live version: **`v2.0.15`** (visible in bottom-right footer). `origin/main` is the source of truth; working tree is clean.
```

- [ ] Change `v2.0.15` to `v2.0.16`.

- [ ] Find the end of the `v2.0.15` bullet in the post-Session A follow-ups section (the bullet beginning `- v2.0.15 — View Recent modal correctness.`).

- [ ] Insert a new bullet **immediately after** that line (as a new list item at the same indent level):

```markdown
- `v2.0.16` — flexible session start. Replaced the silent auto-focus-on-hydrate default with an explicit bottom-sheet start modal. Three paths: rotation-based suggested day (`(lastCompletedDayIndex + 1) mod plan.days.length`, one SELECT per hydrate), pick from plan days (in-place expanding list with in-progress / completed-today badges), blank (ad-hoc) session. Modal auto-opens on hydrate when no in-progress session exists; always-available "Start another workout" hamburger item reopens it. No-active-plan users see only the blank-session path + an "import a plan" link. Removed the now-redundant "+ New Session" standalone button. No schema changes. Design + smoke-test checklist in `docs/superpowers/specs/2026-04-19-flexible-session-start-design.md`; implementation plan in `docs/superpowers/plans/2026-04-19-flexible-session-start.md`.
```

### Step 3: Commit docs + plan file

- [ ] Stage the plan file (not yet tracked) and the HANDOFF update:

```bash
git add docs/superpowers/plans/2026-04-19-flexible-session-start.md HANDOFF.md
git commit -m "Document v2.0.16 flexible session start

- Plan file captures the step-by-step implementation record.
- HANDOFF.md bumps current live version and summarizes the feature
  for the next session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Step 4: Push

- [ ] After explicit user approval to push:

```bash
git push origin main
```

- [ ] Confirm in the output that the range being pushed includes the spec commit (`c122660`) plus Tasks 1-7 (8 commits total: spec + 6 implementation tasks + docs).

### Step 5: Post-deploy verification

- [ ] Hard-reload from the deployed URL (or local server) one final time.
- [ ] Footer shows `v2.0.16`.
- [ ] Modal auto-opens for a user with no in-progress session. All three paths work. The "+ New Session" button is gone. Hamburger has "Start another workout" at the top.

---

## Non-goals for this plan

- No changes to the `sets` write path, rest timer, session timer, or exercise picker.
- No Supabase migration.
- No changes to the existing tab dropdown or History modal.
- No kg/lbs work (separate spec — tabled for tomorrow).
