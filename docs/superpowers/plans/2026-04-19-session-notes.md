# Session Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible "Session notes" row between the session bar and the first exercise card on both plan-day and ad-hoc session views, save-on-blur to `workouts.notes`, auto-expand when notes exist or when the view is historical.

**Architecture:** Pure UI + wire-up in `index.html`. The `workouts.notes text` column already exists; no schema changes. A new `renderSessionNotes(di, state, readOnly)` helper emits the markup, called from both `buildDay` and `buildAdHocDay`. Save-on-blur uses the existing `workoutContainer` change-event delegate (same path `logNote` uses for per-exercise notes). Expand/collapse state is transient and lives on the state object (`notesExpanded`), not persisted.

**Tech Stack:** Single-file HTML/CSS/JS app + Supabase client. No build step, no test runner — verification is manual browser testing.

**Reference spec:** [docs/superpowers/specs/2026-04-19-session-notes-design.md](../specs/2026-04-19-session-notes-design.md)

---

## Testing approach

This project has no automated test framework. Verification is a browser smoke-test checklist run at the end of the task. Each implementation step is small enough that regressions are immediately visible; the full checklist runs before commit.

---

## Task 1: Add session notes support

**Files:**
- Modify: `index.html`

### Step 1: Add `.session-notes` CSS

- [ ] **Locate the `.exercise-note-input` CSS block around line 294.**

Run: Grep tool for `^\.exercise-note-input` in `index.html`.
Expected: one match around line 294.

- [ ] **Insert a new block immediately before `.exercise-note-input`.**

**Find this exact block (look for the preceding selector and the target block starting at 294):**

```css
.exercise-note-input {
```

**Insert the new CSS immediately above it:**

```css
/* Session-level notes (workout-wide, not per-exercise) */
.session-notes {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin: 10px 14px;
  overflow: hidden;
}
.session-notes-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.session-notes-header:active { background: var(--surface2); }
.session-notes-label {
  font-size: 12px; font-weight: 600;
  color: var(--text2);
  font-family: 'JetBrains Mono', monospace;
  text-transform: uppercase; letter-spacing: 0.5px;
  flex-shrink: 0;
}
.session-notes-preview {
  flex: 1; min-width: 0;
  font-size: 12px; color: var(--text3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-notes-chevron {
  font-size: 12px; color: var(--text3);
  transition: transform 0.15s ease;
  flex-shrink: 0;
}
.session-notes.expanded .session-notes-chevron { transform: rotate(180deg); }
.session-notes-body { display: none; padding: 0 12px 12px; }
.session-notes.expanded .session-notes-body { display: block; }
.session-notes-input {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: 'Outfit', sans-serif;
  font-size: 13px; line-height: 1.4;
  padding: 10px;
  min-height: 80px;
  resize: vertical;
  outline: none;
}
.session-notes-input:focus { border-color: var(--blue); }
.session-notes-input::placeholder { color: var(--text3); }
.session-notes-input:disabled { opacity: 0.8; cursor: default; }

```

### Step 2: Hydrate `notes` into state in `stateFromWorkout`

- [ ] **Locate `stateFromWorkout` at line 1580.**

- [ ] **Find the state object initialization block (lines 1581-1586):**

```javascript
function stateFromWorkout(row) {
  var state = {
    workoutId: row.id, planId: row.plan_id, dayIndex: row.day_index,
    startedAt: row.started_at, endedAt: row.ended_at,
    pausedMs: row.paused_ms || 0,
    exercises: {}
  };
```

- [ ] **Replace with:**

```javascript
function stateFromWorkout(row) {
  var state = {
    workoutId: row.id, planId: row.plan_id, dayIndex: row.day_index,
    startedAt: row.started_at, endedAt: row.ended_at,
    pausedMs: row.paused_ms || 0,
    notes: row.notes || '',
    notesExpanded: !!(row.notes && row.notes.trim()),
    exercises: {}
  };
```

The `notesExpanded: !!(row.notes && row.notes.trim())` implements the auto-expand-when-notes-exist rule from the spec.

### Step 3: Update `getOrInitToday` and `createAdHocSession` to seed notes fields

- [ ] **Locate `getOrInitToday` at line 2044.**

**Find this exact block (line 2048-2050):**

```javascript
  if (!todayPlanStates[di]) {
    todayPlanStates[di] = { workoutId: null, planId: null, dayIndex: di, exercises: {} };
  }
```

**Replace with:**

```javascript
  if (!todayPlanStates[di]) {
    todayPlanStates[di] = { workoutId: null, planId: null, dayIndex: di, notes: '', notesExpanded: false, exercises: {} };
  }
```

- [ ] **Locate `createAdHocSession` at line 2529. Find the ad-hoc state object construction at lines 2544-2549:**

```javascript
    var adState = {
      workoutId: res.data.id, planId: null, dayIndex: null,
      startedAt: now, endedAt: null,
      title: null, isAdHoc: true,
      exercises: {},
    };
```

**Replace with:**

```javascript
    var adState = {
      workoutId: res.data.id, planId: null, dayIndex: null,
      startedAt: now, endedAt: null,
      title: null, isAdHoc: true,
      notes: '', notesExpanded: false,
      exercises: {},
    };
```

### Step 4: Add `renderSessionNotes` helper

- [ ] **Locate the render helper region near `renderSetRow` at line 1990 (approximate).**

Run: Grep tool for `^function renderSetRow` in `index.html`.
Expected: one match.

- [ ] **Insert the new helper immediately before `renderSetRow`:**

```javascript
function renderSessionNotes(di, state, readOnly) {
  var notes = (state && state.notes) || '';
  var expanded = !!(state && state.notesExpanded);
  var preview = notes ? notes.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  var previewHtml = preview
    ? '<div class="session-notes-preview">' + escapeHtml(preview) + (notes.length > 40 ? '…' : '') + '</div>'
    : '<div class="session-notes-preview"></div>';
  var diAttr = 'data-di="' + escapeAttr(String(di)) + '"';
  var disabled = readOnly ? ' disabled readonly' : '';
  var h = '<div class="session-notes' + (expanded ? ' expanded' : '') + '" ' + diAttr + '>';
  h += '<div class="session-notes-header" ' + diAttr + '>';
  h += '<div class="session-notes-label">Session notes</div>';
  h += previewHtml;
  h += '<div class="session-notes-chevron">▾</div>';
  h += '</div>';
  h += '<div class="session-notes-body">';
  h += '<textarea class="session-notes-input" ' + diAttr + ' placeholder="How are you feeling today? Energy, soreness, sleep, stress..."' + disabled + '>' + escapeHtml(notes) + '</textarea>';
  h += '</div>';
  h += '</div>';
  return h;
}
```

### Step 5: Inject `renderSessionNotes` into `buildDay`

- [ ] **Locate `buildDay` at line 1755. Find the block that ends the session-bar rendering around lines 1787-1789:**

```javascript
  } else if (mode === 'historical' && state && state.startedAt && state.endedAt) {
    h += '<div class="session-bar done"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div></div>';
  }

  for (var ei = 0; ei < dayPlan.exercises.length; ei++) {
```

- [ ] **Insert the session-notes render between the closing brace of the if/else mode block and the `for` loop:**

```javascript
  } else if (mode === 'historical' && state && state.startedAt && state.endedAt) {
    h += '<div class="session-bar done"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div></div>';
  }

  h += renderSessionNotes(di, state, readOnly);

  for (var ei = 0; ei < dayPlan.exercises.length; ei++) {
```

### Step 6: Inject `renderSessionNotes` into `buildAdHocDay`

- [ ] **Locate `buildAdHocDay` at line 1895. Find the block that ends the session-bar rendering around lines 1920-1924:**

```javascript
  } else if (state.startedAt && state.endedAt) {
    h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div>' +
         '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
  }

  var ts = 0, cs = 0;
```

- [ ] **Insert the session-notes render between the closing brace and the `var ts = 0, cs = 0;` line:**

```javascript
  } else if (state.startedAt && state.endedAt) {
    h += '<div class="session-bar done resumable"><div class="session-duration">Session: ' + fmtDuration(sessionElapsedMs(state)) + '</div>' +
         '<button class="session-btn session-resume" id="btnResumeSession" type="button">Resume</button></div>';
  }

  h += renderSessionNotes(di, state, false);

  var ts = 0, cs = 0;
```

`readOnly` is hardcoded to `false` for ad-hoc since ad-hoc sessions are always editable today (per the comment at [index.html:1903](index.html#L1903) "historical ad-hoc out of scope").

### Step 7: Add `toggleNotes` and `persistNotes` functions

- [ ] **Locate `logNote` at line 2390.**

- [ ] **Insert the two new functions immediately before `logNote`:**

```javascript
function toggleNotes(di) {
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
  } else {
    state = todayPlanStates[di] || historicalCache[di];
    if (!state) {
      // No state yet on a plan-day tab (no sets logged, no history). Seed
      // a minimal today-state so notesExpanded has a place to live; the
      // workout row itself is still lazy-created on focus via persistNotes.
      state = getOrInitToday(di);
    }
  }
  if (!state) return;
  state.notesExpanded = !state.notesExpanded;
  buildDay(di);
}

async function persistNotes(di, value) {
  if (viewModeFor(di) !== 'editable') return;
  var state;
  if (isAdHocKey(di)) {
    state = findAdHoc(di);
    if (!state) return;
  } else {
    state = getOrInitToday(di);
    await ensureWorkout(di);
  }
  var next = value == null ? '' : String(value);
  if ((state.notes || '') === next) return; // dirty-check
  state.notes = next;
  try {
    var res = await sb.from('workouts').update({ notes: next }).eq('id', state.workoutId);
    if (res.error) throw res.error;
  } catch(err) {
    console.error('persistNotes error:', err);
    showToast("Couldn't save session notes", function() { persistNotes(di, next); });
  }
}

```

### Step 8: Wire the header tap handler

- [ ] **Locate the `workoutContainer` click delegate at line 1354. Find the `.ex-history-btn` branch at lines 1380-1384:**

```javascript
  // Per-exercise recent history — handled before header-expand because this
  // button lives inside .exercise-header.
  var histBtn = target.closest ? target.closest('.ex-history-btn') : null;
  if (histBtn) {
    openExerciseHistory(histBtn.getAttribute('data-exercise-name'));
    return;
  }
  // Expand card
  var header = target.closest ? target.closest('.exercise-header') : null;
```

- [ ] **Insert the session-notes-header branch between the `histBtn` block and the `.exercise-header` expand branch:**

```javascript
  // Per-exercise recent history — handled before header-expand because this
  // button lives inside .exercise-header.
  var histBtn = target.closest ? target.closest('.ex-history-btn') : null;
  if (histBtn) {
    openExerciseHistory(histBtn.getAttribute('data-exercise-name'));
    return;
  }
  // Session-notes header — toggle collapse/expand.
  var notesHeader = target.closest ? target.closest('.session-notes-header') : null;
  if (notesHeader) {
    var notesContainer = notesHeader.closest('.session-notes');
    var di = notesContainer ? notesContainer.getAttribute('data-di') : null;
    if (di != null) {
      var diVal = di.indexOf('ah_') === 0 ? di : parseInt(di, 10);
      toggleNotes(diVal);
    }
    return;
  }
  // Expand card
  var header = target.closest ? target.closest('.exercise-header') : null;
```

The `.indexOf('ah_') === 0` branch preserves the ad-hoc key shape (strings like `"ah_<uuid>"`); plan-day keys are numeric.

### Step 9: Wire the textarea change handler

- [ ] **Locate the `workoutContainer` change delegate at line 1457.**

- [ ] **Find the existing branches (set-input, sub-input, exercise-note-input, adhoc-title-input) ending around line 1472:**

```javascript
  if (t.classList.contains('exercise-note-input')) {
    logNote(currentDay, parseInt(t.getAttribute('data-ei')), t.value);
  }
  if (t.classList.contains('adhoc-title-input')) {
    updateAdHocTitle(t.getAttribute('data-workout-id'), t.value);
  }
});
```

- [ ] **Add a new branch before the closing `});`:**

```javascript
  if (t.classList.contains('exercise-note-input')) {
    logNote(currentDay, parseInt(t.getAttribute('data-ei')), t.value);
  }
  if (t.classList.contains('adhoc-title-input')) {
    updateAdHocTitle(t.getAttribute('data-workout-id'), t.value);
  }
  if (t.classList.contains('session-notes-input')) {
    var sdi = t.getAttribute('data-di');
    if (sdi != null) {
      var sdiVal = sdi.indexOf('ah_') === 0 ? sdi : parseInt(sdi, 10);
      persistNotes(sdiVal, t.value);
    }
  }
});
```

### Step 10: Bump `APP_VERSION`

- [ ] **Locate line 1122 and bump the version.**

**Find:**

```javascript
var APP_VERSION = 'v2.0.11';
```

**Replace with:**

```javascript
var APP_VERSION = 'v2.0.12';
```

### Step 11: Manual browser verification

- [ ] **Serve the app locally and hard-reload (Cmd+Shift+R).**

Run: `python3 -m http.server 8000` in the project root, then open `http://localhost:8000`.

- [ ] **Sign in, navigate to a plan-day tab. Verify the session-notes row appears.**

Expected:
- A single row reading "SESSION NOTES" (uppercase mono label) with a ▾ chevron on the right, sitting between the session bar (or Start Session button) and the first exercise card.
- Row is in collapsed state.
- Version `v2.0.12` in the bottom-right.
- No console errors.

- [ ] **Tap the session-notes header.**

Expected: row expands, chevron rotates to ▴, a textarea appears below with the placeholder *"How are you feeling today? Energy, soreness, sleep, stress..."*

- [ ] **Type something, tap elsewhere on the page to blur.**

Expected: no visible indicator, but in Supabase Table Editor the `workouts` row for today's plan-day session now has `notes = <your text>`. If no workout row existed before, one was force-created by the blur handler.

- [ ] **Hard-reload (Cmd+Shift+R) and return to the same day tab.**

Expected: session-notes row appears in **expanded** state (because notes exist), with the preview text in the header dimmed (first 40 chars) and the full text in the textarea.

- [ ] **Collapse the row by tapping the header, verify the preview text still shows the dimmed first-40 chars on the collapsed header.**

Expected: chevron rotates back to ▾, textarea hidden, preview visible.

- [ ] **Edit the note (change some text), blur, hard-reload.**

Expected: updated text persists. Unchanged identical-value blurs don't trigger a write (verify by checking DevTools Network tab — no `PATCH /workouts` request when the value hasn't changed).

- [ ] **Navigate to a plan-day tab with no workout row yet (one you haven't touched today).**

Expected: session-notes row is visible (collapsed), version-footer still shows `v2.0.12`. Tap header to expand, focus textarea, type something, blur.

Expected after blur: new `workouts` row created lazily (verify in Table Editor) with the `notes` value populated.

- [ ] **Navigate to a non-today day-picker entry that has historical data.**

Expected: session-notes row auto-expands if the historical workout has notes; textarea is read-only (cannot type; tap produces no cursor). Collapse/expand toggle still works (it's a UI-only state change).

- [ ] **Create a new ad-hoc session via the hamburger menu → ☰ doesn't trigger ad-hoc; use the "+ New Session" button. Verify the session-notes row appears on ad-hoc sessions too.**

Expected: identical collapsed-with-chevron UI sits between the session bar and the first exercise card (or between the session bar and the "Add Exercise" button if no exercises yet). Expand, type, blur, reload — same persistence behavior as plan-day.

- [ ] **On a read-only historical day, verify the textarea cannot be focused/edited.**

Expected: tapping the disabled textarea does nothing. No cursor, no keyboard on mobile.

### Step 12: Commit

- [ ] **Stage and commit with a focused message.**

```bash
git add index.html
git commit -m "$(cat <<'MSGEOF'
Add session-level notes to plan-day and ad-hoc session views

Collapsible Session Notes row between the session bar and the first
exercise card. Save-on-blur to workouts.notes (column already exists
from the init migration). Auto-expands when notes exist or when the
view is historical, collapsed by default otherwise.

Focus on the textarea triggers the existing ensureWorkout lazy-create
path, so pre-workout context (soreness, sleep) can be logged before
the first set-done. Plan-day and ad-hoc use the same render helper and
save path. Historical read-only views render the textarea disabled.

Feeds the future v2 AI planner alongside set data for subjective
recovery signals.

Bumps APP_VERSION to v2.0.12.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
MSGEOF
)"
```

- [ ] **Confirm working tree is clean and the new commit is ahead of origin/main.**

Run: `git status && git log --oneline -3`

---

## Self-review

Spec coverage check:

| Spec requirement | Task step |
|---|---|
| Collapsible row between session bar and first exercise card | Step 5 (buildDay inject), Step 6 (buildAdHocDay inject) |
| Collapsed header with label, chevron, preview text | Step 1 (CSS), Step 4 (render helper) |
| Expanded textarea with placeholder | Step 4 (render helper) |
| Always visible from the start (no gating on workout existing) | Step 5 / Step 6 always render it |
| Lazy-create workout on focus-then-blur | Step 7 (`persistNotes` calls `ensureWorkout`) |
| Auto-expand when notes exist or historical | Step 2 (`notesExpanded: !!(row.notes ...)`) |
| Auto-expand for Resume with prior notes | Same as above — `stateFromWorkout` populates `notesExpanded` from row |
| Save on blur via dirty-check | Step 7 (`(state.notes || '') === next` short-circuit) |
| Failure surfaces via `showToast` with retry | Step 7 (`showToast("Couldn't save session notes", retry)`) |
| Historical read-only rendering | Step 4 (`disabled readonly` attrs when readOnly), Step 5 (passes `readOnly = mode !== 'editable'`) |
| Plan-day + ad-hoc parity | Steps 5 & 6 both call `renderSessionNotes` |
| No character limit | Textarea has no `maxlength` attribute in Step 4 |
| `APP_VERSION` bumped to v2.0.12 | Step 10 |
| Single focused commit | Step 12 |

**Deliberately out of scope:** the History browser Detail modal (`renderHistoryDetail` at line 3040) is a different read surface using a different card structure, and the spec only addresses day-picker historical views. Not touching it in this feature; can be a follow-up if you want notes visible there too.
