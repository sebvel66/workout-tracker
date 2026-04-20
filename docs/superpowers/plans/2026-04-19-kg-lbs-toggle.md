# Kg / Lbs Weight Unit Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hamburger-menu toggle that flips weight display + input between lbs and kg. All stored `sets.weight` values remain lbs; conversion happens only at the display / input boundary via helpers in `js/data.js`.

**Architecture:** Pure utility helpers in `js/data.js` handle all conversion. `renderSetRow` switches the input label (`LBS` ↔ `KG`), value, and placeholder based on `getWeightUnit()`. `fmtP` appends the current unit to prescribed text. `openExerciseHistory` uses `displayWeight` for historical weights. New hamburger item toggles the preference (stored in `localStorage['weightUnit']`) and re-renders the current day.

**Tech Stack:** Single-file HTML + 5 JS modules under `js/`. No build step, no test runner — verification is manual browser smoke-testing.

**Reference spec:** [docs/superpowers/specs/2026-04-19-kg-lbs-toggle-design.md](../specs/2026-04-19-kg-lbs-toggle-design.md)

---

## Testing approach

No automated test framework in this project. Each task ends with a focused browser smoke-test at a known state. The full spec checklist runs once at Task 6. `node --check` validates syntax on every JS file edit before commit.

---

## File structure

**Modify:**
- `js/data.js` — add constants and helpers; update `logSet` to convert weight input when in kg mode.
- `js/ui.js` — `renderSetRow` unit-aware label/value/placeholder; `fmtP` appends unit; `openExerciseHistory` uses `displayWeight`; hamburger item + `openMenu` label refresh + click handler.
- `index.html` — new `<button class="menu-row" id="menuWeightUnit">` in the hamburger body; bump `APP_VERSION` in `js/app.js` to `v2.0.18`.
- `HANDOFF.md` — bump live version, add `v2.0.18` summary.
- `ROADMAP.md` — remove closed "Lbs / kg unit toggle" item.

**Do not create new files.** No migration. No new Supabase table. No CSS beyond inheriting `.menu-row`.

---

## Task 1: Add conversion helpers + update logSet

**Files:**
- Modify: `js/data.js` — insert helpers near other pure utilities; update `logSet`.

### Step 1: Add helpers to `js/data.js`

- [ ] Open `js/data.js`. Find `bumpRecent(exerciseRow)` (around line 286 now; located just below `loadSuggestedDayIndex`). Insert this block **immediately before** the `function bumpRecent` line (or any stable anchor just below `loadSuggestedDayIndex` — the surrounding context is pure helpers):

```javascript
// ---- Weight unit conversion (kg / lbs) ----
// Canonical storage for sets.weight is always lbs. Conversion happens at the
// display/input boundary based on the user's localStorage preference. See
// docs/superpowers/specs/2026-04-19-kg-lbs-toggle-design.md.
var LBS_PER_KG = 2.20462;

function getWeightUnit() {
  var v = localStorage.getItem('weightUnit');
  return v === 'kg' ? 'kg' : 'lbs';
}

function setWeightUnit(unit) {
  localStorage.setItem('weightUnit', unit === 'kg' ? 'kg' : 'lbs');
}

function lbsToKg(lbs) {
  if (lbs == null) return null;
  return Math.round((lbs / LBS_PER_KG) * 10) / 10;
}

function kgToLbs(kg) {
  if (kg == null) return null;
  return Math.round(kg * LBS_PER_KG * 100) / 100;
}

// Render a canonical lbs value as a display string in the requested unit.
// lbs: up to 2 decimal places, trailing zeros stripped ("90", "88.18").
// kg: 1 decimal place ("40.0", "39.9").
function displayWeight(lbsValue, unit) {
  if (lbsValue == null || lbsValue === '') return '';
  if (unit === 'kg') {
    var kg = lbsToKg(lbsValue);
    return kg.toFixed(1);
  }
  var n = Math.round(lbsValue * 100) / 100;
  if (n === Math.floor(n)) return String(Math.floor(n));
  return String(n).replace(/\.?0+$/, '');
}

// Parse a raw input string in the given unit and return the canonical
// lbs value (number) or null for empty/invalid input.
function parseWeightInput(rawStr, unit) {
  if (rawStr === '' || rawStr == null) return null;
  var parsed = parseFloat(rawStr);
  if (isNaN(parsed)) return null;
  if (unit === 'kg') return kgToLbs(parsed);
  return Math.round(parsed * 100) / 100;
}

// Normalize a prescribed-set object's weight to canonical lbs, regardless of
// the plan JSON's declared unit. Plans that omit `unit` or use 'lbs' pass
// through; 'kg' converts. Used by fmtP and placeholder rendering.
function normalizePrescribedLbs(prescribedSet) {
  if (!prescribedSet || prescribedSet.weight == null) return null;
  if (prescribedSet.unit === 'kg') return kgToLbs(prescribedSet.weight);
  return prescribedSet.weight;
}
```

### Step 2: Update `logSet` to convert weight input

- [ ] In `js/data.js`, find `logSet` (around line 651 now — search for `async function logSet`). Locate the line:

```javascript
  var parsed = val === '' ? null : parseFloat(val);
  sl[field] = (parsed == null || isNaN(parsed)) ? null : parsed;
```

- [ ] Replace those two lines with this block (keeps reps path unchanged; weight path routes through `parseWeightInput` which handles the kg → lbs conversion):

```javascript
  var parsed;
  if (val === '' || val == null) {
    parsed = null;
  } else if (field === 'weight') {
    parsed = parseWeightInput(val, getWeightUnit());
  } else {
    parsed = parseFloat(val);
    if (isNaN(parsed)) parsed = null;
  }
  sl[field] = parsed;
```

### Step 3: Syntax check

- [ ] Run:

```bash
node --check js/data.js && echo OK
```

Expected: `OK` printed.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
Add weight-unit conversion helpers + unit-aware logSet

- LBS_PER_KG constant.
- getWeightUnit / setWeightUnit wrap localStorage['weightUnit'].
- lbsToKg / kgToLbs / displayWeight / parseWeightInput / normalizePrescribedLbs
  handle all conversion and formatting. Display precision is 1dp for kg,
  up to 2dp (trailing zeros stripped) for lbs.
- logSet now routes weight input through parseWeightInput so kg-mode
  entries are converted to lbs before persistence. Reps path unchanged.
No UI changes yet; toggle and renderer updates land in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: renderSetRow — unit-aware label, value, placeholder

**Files:**
- Modify: `js/ui.js` — `renderSetRow` at lines 61-89.

### Step 1: Update label, value, and placeholder

- [ ] Open `js/ui.js`. Find `renderSetRow` at line 61. Locate lines 62-76 (the weight-related lines inside the function):

```javascript
  var weightCls = prescribedSet ? inputCls(sl.weight, prescribedSet.weight) : '';
  var repsCls = prescribedSet ? inputCls(sl.reps, prescribedSet.reps_target) : '';
  var weightPlaceholder = prescribedSet && prescribedSet.weight ? prescribedSet.weight : '—';
  var repsPlaceholder = prescribedSet && prescribedSet.reps_target ? prescribedSet.reps_target : '—';

  var out = '';
  var extraCls = sl && sl.isExtra ? ' set-extra' : '';
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + extraCls + '">';
  out += '<div class="set-label">S' + (si+1) + '</div>';
  out += '<div class="set-prescribed">' + (prText || '—') + '</div>';
  out += '<div class="set-actual">';
  if (weightMode !== 'none') {
    var lbl = weightMode === 'bodyweight' ? 'ADD WT' : 'LBS';
    out += '<div class="input-group"><label class="input-label">' + lbl + '</label>';
    out += '<input type="number" inputmode="decimal" class="set-input ' + weightCls + '" value="' + (sl.weight != null ? sl.weight : '') + '" placeholder="' + weightPlaceholder + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="weight" onfocus="this.select()"' + disabledAttr + '>';
```

- [ ] Replace those 15 lines (62 through 76) with this version (computes `currentUnit` once at the top, uses it for label + value + placeholder; `inputCls` comparison still uses raw lbs for both sides so the "under/over/miss" coloring stays correct):

```javascript
  var currentUnit = getWeightUnit();
  var prescribedLbs = normalizePrescribedLbs(prescribedSet);
  var weightCls = prescribedLbs != null ? inputCls(sl.weight, prescribedLbs) : '';
  var repsCls = prescribedSet ? inputCls(sl.reps, prescribedSet.reps_target) : '';
  var weightPlaceholder = prescribedLbs != null ? displayWeight(prescribedLbs, currentUnit) : '—';
  var repsPlaceholder = prescribedSet && prescribedSet.reps_target ? prescribedSet.reps_target : '—';

  var out = '';
  var extraCls = sl && sl.isExtra ? ' set-extra' : '';
  out += '<div class="set-row' + (deletable ? ' deletable' : '') + extraCls + '">';
  out += '<div class="set-label">S' + (si+1) + '</div>';
  out += '<div class="set-prescribed">' + (prText || '—') + '</div>';
  out += '<div class="set-actual">';
  if (weightMode !== 'none') {
    var lbl;
    if (weightMode === 'bodyweight') {
      lbl = 'ADD WT';
    } else {
      lbl = currentUnit === 'kg' ? 'KG' : 'LBS';
    }
    out += '<div class="input-group"><label class="input-label">' + lbl + '</label>';
    out += '<input type="number" inputmode="decimal" class="set-input ' + weightCls + '" value="' + displayWeight(sl.weight, currentUnit) + '" placeholder="' + weightPlaceholder + '" data-di="' + di + '" data-ei="' + ei + '" data-si="' + si + '" data-field="weight" onfocus="this.select()"' + disabledAttr + '>';
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 3: Browser smoke-test

- [ ] Hard-reload the app. The default unit is still lbs — no visible change (inputs show `LBS` label, values rendered as before).
- [ ] In DevTools console, toggle the unit manually:

```javascript
setWeightUnit('kg'); buildDay(currentDay);
```

- [ ] All weight input labels should now read `KG`. Placeholders (the grey prescribed hint in each weight input) should show kg values (e.g., `40.8` for a 90-lb prescribed set). Values you've previously entered render in kg with 1dp.
- [ ] Toggle back:

```javascript
setWeightUnit('lbs'); buildDay(currentDay);
```

Labels go back to `LBS`; values render in lbs.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
renderSetRow — unit-aware label, value, placeholder

Input label flips between LBS and KG based on getWeightUnit().
Bodyweight mode still reads ADD WT. Values and placeholders route
through displayWeight / normalizePrescribedLbs so kg mode renders
cleanly at 1dp and lbs mode keeps 2dp trailing-zero-stripped format.
inputCls still compares against canonical lbs for the under/over
coloring to stay correct.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: fmtP — unit-aware prescribed hint

**Files:**
- Modify: `js/ui.js` — `fmtP` at lines 91-99.

### Step 1: Update fmtP

- [ ] In `js/ui.js`, find `fmtP` at line 91:

```javascript
function fmtP(s) {
  var p = [];
  if (s.weight) p.push(s.weight + (s.unit || 'lbs'));
  // Prefer reps_range (e.g. "8-12") since it carries more information, and
  // fall back to reps_target (the specific number) when no range is present.
  if (s.reps_range) p.push('x' + s.reps_range);
  else if (s.reps_target) p.push('x' + s.reps_target);
  return p.join(' ') || '—';
}
```

- [ ] Replace with (routes weight through `normalizePrescribedLbs` + `displayWeight` + current-unit suffix):

```javascript
function fmtP(s) {
  var p = [];
  var lbsP = normalizePrescribedLbs(s);
  if (lbsP != null) {
    var u = getWeightUnit();
    p.push(displayWeight(lbsP, u) + u);
  }
  // Prefer reps_range (e.g. "8-12") since it carries more information, and
  // fall back to reps_target (the specific number) when no range is present.
  if (s.reps_range) p.push('x' + s.reps_range);
  else if (s.reps_target) p.push('x' + s.reps_target);
  return p.join(' ') || '—';
}
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 3: Browser smoke-test

- [ ] Hard-reload.
- [ ] On a plan-day exercise with prescribed weights, the prescribed column on each set row (under the `PRESCRIBED` header) now reads e.g. `90lbs x10` in lbs mode, `40.8kg x10` in kg mode.
- [ ] Toggle via console (`setWeightUnit('kg'); buildDay(currentDay);`) and verify prescribed column updates.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
fmtP — unit-aware prescribed hint

Prescribed-column text in each set row routes weight through
normalizePrescribedLbs + displayWeight and appends the current unit.
Reps range/target unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: openExerciseHistory — unit-aware set strings

**Files:**
- Modify: `js/ui.js` — `openExerciseHistory` set-string loop at lines 820-824.

### Step 1: Update set-string rendering

- [ ] In `js/ui.js`, find the set-string map at lines 820-825 inside `openExerciseHistory`:

```javascript
      sess.sets.sort(function(a, b) { return a.set_order - b.set_order; });
      var setStrs = sess.sets.map(function(s) {
        var w = s.weight != null ? s.weight : '—';
        var r = s.reps != null ? s.reps : '—';
        return w + ' × ' + r;
      });
```

- [ ] Replace with (displays weight in current unit; no unit suffix per-set, matching the spec's decision to keep set strings compact):

```javascript
      sess.sets.sort(function(a, b) { return a.set_order - b.set_order; });
      var recentUnit = getWeightUnit();
      var setStrs = sess.sets.map(function(s) {
        var w = s.weight != null ? displayWeight(s.weight, recentUnit) : '—';
        var r = s.reps != null ? s.reps : '—';
        return w + ' × ' + r;
      });
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 3: Browser smoke-test

- [ ] Hard-reload.
- [ ] Open an exercise's View Recent modal (tap "view recent" on any exercise card). In lbs mode, weights render as stored. Toggle the unit (`setWeightUnit('kg'); buildDay(currentDay); openExerciseHistory('<ExerciseName>');` or reopen the modal) and verify the set strings display kg values at 1dp.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
openExerciseHistory — display weights in current unit

Per-exercise View Recent modal set strings (e.g. 90 × 12) now render
weight through displayWeight in the current preference. No unit suffix
per-set — the user knows their selected unit and adding lbs/kg to
every row adds noise without disambiguating.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Hamburger menu item + toggle handler

**Files:**
- Modify: `index.html` — menu body ~line 1311.
- Modify: `js/ui.js` — `openMenu` at line 468; new click listener near other `menu*` listeners.

### Step 1: Add DOM item

- [ ] Open `index.html`. Find the menu body (contains `menuImport`, `menuExport`, etc.):

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

- [ ] Replace with (inserts the new `menuWeightUnit` row between `menuGymProfiles` and `menuSignOut`):

```html
    <div class="menu-body">
      <button class="menu-row" id="menuStartAnother" type="button">Start another workout</button>
      <button class="menu-row" id="menuImport" type="button">Import Plan</button>
      <button class="menu-row" id="menuExport" type="button">Export Data</button>
      <button class="menu-row" id="menuHistory" type="button">History</button>
      <button class="menu-row" id="menuGymProfiles" type="button">Gym Profiles</button>
      <button class="menu-row" id="menuWeightUnit" type="button">Weight unit (lbs)</button>
      <button class="menu-row danger" id="menuSignOut" type="button">Sign Out</button>
    </div>
```

### Step 2: Update `openMenu` to refresh the label

- [ ] Open `js/ui.js`. Find `openMenu` at line 468:

```javascript
function openMenu() {
  document.getElementById('menuOverlay').classList.add('show');
}
```

- [ ] Replace with (syncs the row's label with the current preference at open time):

```javascript
function openMenu() {
  var row = document.getElementById('menuWeightUnit');
  if (row) {
    row.textContent = 'Weight unit (' + getWeightUnit() + ')';
  }
  document.getElementById('menuOverlay').classList.add('show');
}
```

### Step 3: Add click listener

- [ ] In `js/ui.js`, find the `menuGymProfiles` click listener (around line 1480 in the current file):

```javascript
document.getElementById('menuGymProfiles').addEventListener('click', function() {
  closeMenu();
  openGymProfiles();
});
```

- [ ] Insert this block **immediately after** the `menuGymProfiles` listener's closing `});` (before the `menuSignOut` listener that follows):

```javascript
document.getElementById('menuWeightUnit').addEventListener('click', function() {
  setWeightUnit(getWeightUnit() === 'lbs' ? 'kg' : 'lbs');
  closeMenu();
  buildDay(currentDay);
});
```

### Step 4: Syntax check

- [ ] Run:

```bash
node --check js/ui.js && echo OK
```

Expected: `OK`.

### Step 5: Browser smoke-test — the main event

- [ ] Hard-reload.
- [ ] Tap the ☰ hamburger. Between "Gym Profiles" and "Sign Out" there's a new row: **Weight unit (lbs)**.
- [ ] Tap it → hamburger closes; all visible weight inputs flip to `KG` labels; values + placeholders render as kg; prescribed column reads in kg.
- [ ] Re-open hamburger → row now reads **Weight unit (kg)**.
- [ ] Tap again → flips back to lbs.
- [ ] Enter a value (e.g., `40`) in kg mode, tap Done. Reload. Footer still on v2.0.17 (bump lands in Task 6). Value should display as `40.0 kg`. Toggle to lbs — displays as `88.18`. Toggle back — `40.0`.

### Step 6: Commit

- [ ] Stage and commit:

```bash
git add index.html js/ui.js
git commit -m "$(cat <<'EOF'
Add Weight unit hamburger toggle

New menu row between Gym Profiles and Sign Out. Label shows the
current preference at open time (syncs via openMenu). Tap flips
the localStorage preference and re-renders the session view. No
schema change, no cross-device sync — preference is device-local.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Bump APP_VERSION + full smoke test

**Files:**
- Modify: `js/app.js` (line 10).

### Step 1: Bump version

- [ ] Open `js/app.js`. Find:

```javascript
var APP_VERSION = 'v2.0.17';
```

- [ ] Change to:

```javascript
var APP_VERSION = 'v2.0.18';
```

### Step 2: Syntax check

- [ ] Run:

```bash
node --check js/app.js && echo OK
```

Expected: `OK`.

### Step 3: Full spec smoke-test

- [ ] Hard-reload. Footer shows `v2.0.18`.
- [ ] Work through every checkbox in "Manual smoke test checklist" of [docs/superpowers/specs/2026-04-19-kg-lbs-toggle-design.md](../specs/2026-04-19-kg-lbs-toggle-design.md): toggle behavior, input+persistence (including the 40 kg → 88.18 lbs round-trip), placeholders, secondary surfaces (fmtP prescribed, History modal, View Recent modal), edge cases (bodyweight, no-weight, mid-session toggle, historical Fitbod Import), regressions (RPE fanout, add-set/add-exercise, export unchanged).
- [ ] If anything fails, STOP. Diagnose and fix with a follow-up commit before proceeding to Task 7.

### Step 4: Commit

- [ ] Stage and commit:

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
Bump APP_VERSION to v2.0.18

Marks the kg/lbs weight unit toggle feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Docs update + push

**Files:**
- Modify: `HANDOFF.md` — current-version line + post-Session A follow-ups list.
- Modify: `ROADMAP.md` — remove closed item.
- Add: the plan file itself (`docs/superpowers/plans/2026-04-19-kg-lbs-toggle.md`).

### Step 1: HANDOFF.md update

- [ ] Open `HANDOFF.md`. Find:

```markdown
Current live version: **`v2.0.17`** (visible in bottom-right footer). `origin/main` is the source of truth; working tree is clean.
```

- [ ] Change `v2.0.17` to `v2.0.18`.

- [ ] Find the end of the `v2.0.17` bullet in the post-Session A follow-ups section.

- [ ] Insert this bullet immediately after it:

```markdown
- `v2.0.18` — kg / lbs weight unit toggle. New hamburger item "Weight unit (lbs|kg)" flips display + input between the two units. Conversion helpers in `js/data.js` (`LBS_PER_KG`, `getWeightUnit`, `setWeightUnit`, `lbsToKg`, `kgToLbs`, `displayWeight`, `parseWeightInput`, `normalizePrescribedLbs`); input label in `renderSetRow` flips between `LBS`/`KG`; `fmtP` appends current unit to prescribed hints; `openExerciseHistory` uses `displayWeight` for historical set strings. `sets.weight` remains canonical lbs — no schema change, no migration. Preference persisted in `localStorage['weightUnit']` (device-local; cross-device sync via `user_settings` table deferred). Shipped for an upcoming Europe trip. Design + smoke-test checklist in `docs/superpowers/specs/2026-04-19-kg-lbs-toggle-design.md`; implementation plan in `docs/superpowers/plans/2026-04-19-kg-lbs-toggle.md`.
```

### Step 2: ROADMAP.md — remove the closed item

- [ ] Open `ROADMAP.md`. Find the "Lbs / kg unit toggle (near-term — international travel)" bullet under UX improvements.

- [ ] Delete that entire bullet (multi-line).

### Step 3: Commit docs + plan file

- [ ] Stage and commit:

```bash
git add HANDOFF.md ROADMAP.md docs/superpowers/plans/2026-04-19-kg-lbs-toggle.md
git commit -m "$(cat <<'EOF'
Document v2.0.18 kg/lbs weight unit toggle

- HANDOFF.md: bump current live version, add v2.0.18 summary.
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

- [ ] Verify the push output includes the expected range (spec commit + 6 implementation commits + docs commit).

---

## Non-goals for this plan

- Cross-device preference sync (tabled; localStorage is device-local).
- Plate-math calculator / plate visualization.
- Unit selector on the export modal — export stays lbs.
- Mixed-unit sessions.
- Migrating plan JSON to store prescribed values in both units.
