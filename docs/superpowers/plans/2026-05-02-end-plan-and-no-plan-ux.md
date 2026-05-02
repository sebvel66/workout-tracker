# End plan + no-plan UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "End plan" button to the Plans modal that drops the user into a fully-usable no-plan state, plus refresh the empty-state tracker view, day-picker dropdown, and start-screen overlay so the no-plan state is a first-class experience.

**Architecture:** Pure UI + frontend data-layer changes. No DB schema migrations. End is just `UPDATE plans SET is_active = false`; the partial unique index on `(user_id) WHERE is_active = true` already supports the zero-active state. New helpers go in `js/data.js` (`endActivePlan`, `fetchRecentWorkouts`); UI wiring in `js/ui.js`; static empty-state HTML moves into a `renderEmptyState()` JS function. Hydration cache is cleared on End so warm-boot drops to the empty state. Coach context is refreshed via the existing `refreshCoachForNewSession()` (which already handles `plan == null`).

**Tech Stack:** Plain JS (no build step), Supabase JS client (`sb`), `confirm()` + custom `showToast` for prompts. No automated test framework — verification is manual browser smoke testing per the project's existing convention.

**Spec:** [docs/superpowers/specs/2026-05-02-end-plan-and-no-plan-ux-design.md](../specs/2026-05-02-end-plan-and-no-plan-ux-design.md)

**Version target:** This milestone bumps the app to **`v3.0.0`** (major version — no-plan state becomes a first-class experience). The version bump is the final step of the plan.

**Workflow rules (from project conventions):**
- Test in browser before committing every task. Hard-reload after each JS edit.
- Small focused commits per task.
- Bump `APP_VERSION` only on the final task (one user-visible release covers the whole feature).
- **Never push.** Commits stay local until the user explicitly approves a push.

---

## File map

| File | Change |
|---|---|
| `js/data.js` | Add `endActivePlan()` (~line 2580, after `activateExistingPlan`); add `fetchRecentWorkouts(userId, days, limit)` helper near `fetchWeekSummary` (~line 582). |
| `js/ui.js` | `renderPlans()` (~3054) — add End-plan button on active row + delegate handler; new `onEndPlan(planId)` handler near `onActivatePlan` (~3095); replace static empty-state markup with new `renderEmptyState()` function; new `recentWorkoutsCache` state var; `buildTabs()` (~376) — toggle the dropdown wrapper visibility; `openStartScreen()` (~1184) — refresh `emptyHint` copy. |
| `index.html` | Replace the static `#emptyState` content (~2389) with an empty container that JS populates. Add CSS for new empty-state classes. |
| `js/app.js` | Bump `APP_VERSION` from `v2.5.12` → `v3.0.0` (last task). |

No migration. No server-side changes.

---

### Task 1: Add `endActivePlan()` to `js/data.js`

Pure data-layer helper. Flips `is_active = false` on the active plan, clears in-memory plan state, refreshes coach context, clears the hydration snapshot. UI wiring comes in Task 3.

**Files:**
- Modify: `js/data.js` — insert new function after `activateExistingPlan` (line 2579).

- [ ] **Step 1: Add the new function**

Insert this directly after the closing `}` of `activateExistingPlan` (around line 2579, just before the `// ---- Templates ----` comment block):

```js
// Deactivate the currently-active plan without replacing it. Used by the
// Plans modal "End plan" action. Unlike savePlanAsActive / activateExistingPlan
// this leaves the user in a no-plan state — DB plan row stays intact (is_active
// flipped to false), all attached workouts/sets/coach history preserved. The
// user can re-activate via the Plans modal at any time.
//
// Mirrors the structure of activateExistingPlan but in reverse: DB write
// first, then in-memory state cleared, then UI re-rendered into empty-state.
async function endActivePlan() {
  if (!userId) throw new Error('Not signed in');
  if (!activePlanId) throw new Error('No active plan to end');

  var r = await sb.from('plans').update({ is_active: false })
    .eq('user_id', userId).eq('is_active', true);
  if (r.error) throw new Error(r.error.message);

  // Clear plan-anchored in-memory state. planCache is intentionally retained
  // — other plans may still be browsable via the Plans modal.
  activePlanId = null;
  plan = null;
  todayState = null;
  todayPlanStates = {};
  historicalCache = {};
  daysWithHistory = {};
  exerciseIdCache = {};
  currentDay = 0;
  suggestedDayIndex = null;

  // Coach context is plan-anchored; rebuild against the now-empty plan slot
  // so chat doesn't keep referencing the ended plan. buildCoachContext
  // (data.js:2801) handles plan == null cleanly — _formatPlanForCoach
  // returns '' when plan is null/empty, so the plan block just drops out.
  if (typeof refreshCoachForNewSession === 'function') {
    refreshCoachForNewSession();
  }

  // Drop the hydration snapshot. saveHydrationSnapshot's existing guard
  // (`if (!activePlanId || !plan) return;`) means we can't save a no-plan
  // snapshot directly — clearing is the right move. paintFromCache will
  // skip on next boot and hydrate runs from scratch into the empty state.
  if (typeof clearHydrationSnapshot === 'function') {
    clearHydrationSnapshot();
  }

  // UI side effects: tracker drops to empty state. Caller is responsible
  // for re-rendering (renderEmptyState in ui.js). We only handle the
  // direct DOM toggles here that are already done by savePlanAsActive's
  // mirror — keeps the data-layer / UI-layer split clean.
  var emptyEl = document.getElementById('emptyState');
  if (emptyEl) emptyEl.style.display = 'block';
  var summaryEl = document.getElementById('summaryBar');
  if (summaryEl) summaryEl.style.display = 'none';
  var titleEl = document.getElementById('planTitle');
  if (titleEl) titleEl.textContent = 'No active plan';
  var weekEl = document.getElementById('planWeek');
  if (weekEl) weekEl.textContent = '';
  var container = document.getElementById('workoutContainer');
  if (container) container.innerHTML = '';
}
```

- [ ] **Step 2: Smoke test (read-only)**

This task adds a function but doesn't call it. Verify the file still parses:

```bash
node --check js/data.js
```

Expected: no output (parse OK).

- [ ] **Step 3: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
data: add endActivePlan helper for no-plan state transition

Flips is_active=false on the user's active plan, clears in-memory
plan-anchored state, refreshes coach context, and clears the hydration
snapshot. Mirror of activateExistingPlan in reverse. UI wiring lands
in a follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `fetchRecentWorkouts(userId, days, limit)` to `js/data.js`

Helper for the Recent workouts list on the empty state. Returns last N days of workouts (any kind — plan-based or ad-hoc) with set counts and a friendly display label.

**Files:**
- Modify: `js/data.js` — add helper near `fetchWeekSummary` (~line 582).

- [ ] **Step 1: Add the helper function**

Insert this immediately after `fetchWeekSummary` ends (locate the closing brace of that function around line 700-ish — search for `async function fetchWeekSummary` and find its matching close brace, then insert the new function right after).

A simpler insertion point: just before `async function fetchWeekSummary` (around line 580), so it groups with related week/workout helpers. Use the smaller diff. Search for the line `async function fetchWeekSummary(userId, weekStartDate, weekEndDate) {` and insert the following block immediately ABOVE it:

```js
// Fetch recent workouts for the empty-state Recent list. Returns up to
// `limit` workouts within the last `days` calendar days, most recent
// first, with embedded plan metadata + location name + set count.
//
// Used only by the no-plan empty state, so we don't need full set rows
// or summary stats — just enough to render a clickable row that opens
// in the History detail modal.
async function fetchRecentWorkouts(userId, days, limit) {
  if (!userId) return [];
  days = days || 7;
  limit = limit || 10;

  // Cutoff at local midnight `days` days ago. performed_at is a timestamptz;
  // compare against an ISO timestamp.
  var cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  var cutoffIso = new Date(cutoffMs).toISOString();

  try {
    var r = await sb.from('workouts')
      .select('id, performed_at, day_index, title, plan_id, location_id, ' +
              'plans(title, data), locations(name)')
      .eq('user_id', userId)
      .gte('performed_at', cutoffIso)
      .order('performed_at', { ascending: false })
      .limit(limit);
    if (r.error) throw r.error;
    var workouts = r.data || [];
    if (!workouts.length) return [];

    // Set counts via a separate query so we don't depend on PostgREST
    // aggregate embeds (which require a relationship hint and are noisier
    // to debug). Cheap — workouts.length is at most `limit`.
    var workoutIds = workouts.map(function(w) { return w.id; });
    var sr = await sb.from('sets')
      .select('workout_id')
      .eq('user_id', userId)
      .in('workout_id', workoutIds)
      .eq('done', true);
    var counts = {};
    if (!sr.error && sr.data) {
      for (var i = 0; i < sr.data.length; i++) {
        var wid = sr.data[i].workout_id;
        counts[wid] = (counts[wid] || 0) + 1;
      }
    }

    return workouts.map(function(w) {
      var planTitle = (w.plans && w.plans.title) || null;
      var planDays = (w.plans && w.plans.data && w.plans.data.days) || null;
      var dayName = null;
      if (w.day_index != null && Array.isArray(planDays) && planDays[w.day_index]) {
        dayName = planDays[w.day_index].name || ('Day ' + (w.day_index + 1));
      }
      return {
        id: w.id,
        performed_at: w.performed_at,
        plan_id: w.plan_id,
        plan_title: planTitle,
        day_index: w.day_index,
        day_name: dayName,
        title: w.title,
        location_name: w.locations ? w.locations.name : null,
        set_count: counts[w.id] || 0,
      };
    });
  } catch (err) {
    console.error('fetchRecentWorkouts error:', err);
    return [];
  }
}
```

- [ ] **Step 2: Verify file still parses**

```bash
node --check js/data.js
```

Expected: no output.

- [ ] **Step 3: Smoke test the query in DevTools**

Hard-reload the app at `localhost:3000` (or wherever `vercel dev` runs). Open the console and execute:

```js
fetchRecentWorkouts(userId, 7, 10).then(console.log)
```

Expected: an array of up to 10 workout objects with the shape `{id, performed_at, plan_title, day_name, title, location_name, set_count, ...}`. Empty array is OK if you've trained nothing in 7 days. Verify `set_count` is non-zero for at least one workout you know has logged sets.

- [ ] **Step 4: Commit**

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
data: add fetchRecentWorkouts helper for no-plan empty state

Returns up to N workouts within the last D days (any plan_id, including
null for ad-hoc), enriched with plan title, day name, location name, and
done-set count. Powers the Recent workouts list on the empty state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire End-plan button into the Plans modal

Add the button to `renderPlans()`, the click delegate, and the `onEndPlan` handler. After this task, ending a plan from the Plans modal works — but the empty state still shows the stale v1 copy (refresh comes in Task 4).

**Files:**
- Modify: `js/ui.js` — `renderPlans()` around line 3054, click delegate around line 3970, `onEndPlan` handler near `onActivatePlan` (~3095).

- [ ] **Step 1: Add the End-plan button to active rows in `renderPlans()`**

Locate the row-actions block in `renderPlans()` (around line 3080-3088). The current structure:

```js
h += '<div class="plans-row-actions">';
h += '<button type="button" class="plans-btn view" data-view-plan-id="' + escapeAttr(p.id) + '">View</button>';
h += '<button type="button" class="plans-btn rename" data-rename-plan-id="' + escapeAttr(p.id) + '">Rename</button>';
h += '<button type="button" class="plans-btn activate" data-plan-id="' + escapeAttr(p.id) + '"' +
     (p.is_active ? ' disabled' : '') + '>Activate</button>';
h += '<button type="button" class="plans-btn template" data-plan-id="' + escapeAttr(p.id) + '">Template</button>';
h += '<button type="button" class="plans-btn delete" data-plan-id="' + escapeAttr(p.id) + '"' +
     (p.workout_count > 0 ? ' disabled title="Has logged workouts"' : '') + '>Delete</button>';
h += '</div>';
```

Insert a new `<button>` for End plan, conditionally shown only on the active row. The button goes between Rename and Activate (so the in-context plan-management buttons stay grouped and Delete stays at the destructive end):

```js
h += '<div class="plans-row-actions">';
h += '<button type="button" class="plans-btn view" data-view-plan-id="' + escapeAttr(p.id) + '">View</button>';
h += '<button type="button" class="plans-btn rename" data-rename-plan-id="' + escapeAttr(p.id) + '">Rename</button>';
if (p.is_active) {
  h += '<button type="button" class="plans-btn end" data-end-plan-id="' + escapeAttr(p.id) + '">End plan</button>';
}
h += '<button type="button" class="plans-btn activate" data-plan-id="' + escapeAttr(p.id) + '"' +
     (p.is_active ? ' disabled' : '') + '>Activate</button>';
h += '<button type="button" class="plans-btn template" data-plan-id="' + escapeAttr(p.id) + '">Template</button>';
h += '<button type="button" class="plans-btn delete" data-plan-id="' + escapeAttr(p.id) + '"' +
     (p.workout_count > 0 ? ' disabled title="Has logged workouts"' : '') + '>Delete</button>';
h += '</div>';
```

- [ ] **Step 2: Add the click delegate branch**

Find the click delegate that dispatches `data-plan-id` clicks for Activate / Template / Delete. It's around line 3960-3990 — search for `data-plan-id` in `js/ui.js` to locate the delegate. The current shape looks like:

```js
document.getElementById('plansBody').addEventListener('click', function(e) {
  var activateBtn = e.target.closest('[data-plan-id]');
  // ... existing dispatch ...
});
```

Locate the dispatch block and add a new branch for `data-end-plan-id` BEFORE the existing `data-plan-id` checks (since the click target attribute is different). Find the line that does `var renameBtn = e.target.closest('[data-rename-plan-id]');` (or similar) and add this immediately above it (or in the same parallel block):

```js
var endBtn = e.target.closest('[data-end-plan-id]');
if (endBtn) {
  onEndPlan(endBtn.getAttribute('data-end-plan-id'));
  return;
}
```

If you can't find a `[data-rename-plan-id]` branch, locate the existing handler structure by grepping:

```bash
grep -n "data-rename-plan-id\|data-view-plan-id\|onRenamePlan\|onActivatePlan" js/ui.js
```

— the delegate that dispatches `onRenamePlan` is the right insertion point.

- [ ] **Step 3: Add the `onEndPlan` handler**

Insert this function in `js/ui.js` right after `onActivatePlan` (around line 3110). Keep it grouped with `onActivatePlan` / `onRenamePlan` / `onDeletePlan`:

```js
async function onEndPlan(planId) {
  var p = null;
  for (var i = 0; i < plansList.length; i++) {
    if (plansList[i].id === planId) { p = plansList[i]; break; }
  }
  if (!p || !p.is_active) return;
  if (!confirm('End "' + (p.title || 'Untitled') + '"? You can re-activate it from this list anytime.')) return;
  try {
    await endActivePlan();
    closePlans();
    showToast('Plan ended. Activate again from Plans anytime.', null);
    // Re-render the empty state so the Recent workouts list and CTAs
    // are populated correctly. renderEmptyState arrives in Task 4 — for
    // now the existing static markup is what shows.
    if (typeof renderEmptyState === 'function') {
      renderEmptyState();
    }
    // Re-render the dropdown — it should hide if there are no ad-hocs
    // today (Task 5 adds the visibility toggle; for now buildTabs just
    // produces empty HTML, which is acceptable).
    buildTabs();
    // Auto-open the start screen if there's nothing to focus on.
    if (!todayAdHocs || !todayAdHocs.length) {
      openStartScreen();
    }
  } catch(err) {
    console.error('onEndPlan error:', err);
    showToast("Couldn't end plan: " + (err.message || 'unknown error'), null);
  }
}
```

- [ ] **Step 4: Add basic CSS for the End plan button**

The existing `.plans-btn` classes (`view`, `rename`, `activate`, `template`, `delete`) likely already have base styling in `index.html`'s inline `<style>` block. Search for `.plans-btn` to find them:

```bash
grep -n "plans-btn" /Users/sebastianvelez/workout-tracker/index.html | head -20
```

Add an `.end` variant matching the neutral / non-destructive styling. Find the existing `.plans-btn.activate` rule and insert a sibling rule:

```css
.plans-btn.end {
  /* neutral non-destructive — same family as activate, slightly muted */
  background: var(--surface2);
  color: var(--text);
  border-color: var(--border);
}
.plans-btn.end:hover { background: var(--surface3); }
```

If `.plans-btn.activate` already does what you want, the `.end` class can simply share its styling. Use whichever rule shape matches the existing convention.

- [ ] **Step 5: Browser smoke test**

Hard-reload. Open Plans modal (☰ → Plans). Verify:

1. Active plan row shows: `View · Rename · End plan · Activate (disabled) · Template · Delete (disabled if has workouts)`. End plan button is visible only on the active row.
2. Inactive plan rows show: `View · Rename · Activate · Template · Delete (disabled if has workouts)` — NO End plan button.
3. Tap End plan → native confirm appears with the right copy.
4. Cancel → modal stays open, no state change.
5. Confirm → modal closes, toast shows "Plan ended. Activate again from Plans anytime." Tracker view shows the **stale empty state** ("No Plan Loaded — tap Import…") — that's expected, refresh comes in Task 4. Start-screen overlay auto-opens with Generate promoted.
6. Open Plans modal again → the just-ended plan now shows without an Active badge, with End plan button hidden, with Activate button enabled.
7. Tap Activate on the ended plan → confirm → tracker re-renders the plan, day tabs match prior state, summary bar visible. Round-trip works.

If any of these fail, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add js/ui.js index.html
git commit -m "$(cat <<'EOF'
ui(plans): add End-plan button to Plans modal active row

Wires onEndPlan handler that calls data-layer endActivePlan, closes
the modal, toasts confirmation, and auto-opens the start-screen
overlay if no ad-hocs are focused today. Empty state still shows the
stale v1 copy — refresh lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Replace static empty-state HTML with `renderEmptyState()`

Drops the v1 "Tap Import" copy. New empty state has 3 CTAs (Generate primary / Use a template / Blank session), a "View full History" link, and a Recent workouts list (last 7 days).

**Files:**
- Modify: `index.html` — replace the static `#emptyState` markup (~line 2389).
- Modify: `js/ui.js` — add new `renderEmptyState()` function and `recentWorkoutsCache` state var.

- [ ] **Step 1: Empty out the static `#emptyState` markup**

Find the existing block in `index.html` (line 2389):

```html
<div class="empty-state" id="emptyState">
  <div class="empty-state-icon">🏋️</div>
  <h3>No Plan Loaded</h3>
  <p>Tap <strong>Import</strong> to load your weekly plan JSON, then start tracking.</p>
</div>
```

Replace with:

```html
<div class="empty-state" id="emptyState"></div>
```

The contents are now populated by `renderEmptyState()` in JS.

- [ ] **Step 2: Add `recentWorkoutsCache` state var**

In `js/ui.js`, near the other UI-owned state vars at the top of the file (search for `var pickerState = ` and friends — there's a state-declarations block around line 60-150), add:

```js
var recentWorkoutsCache = null; // Lazily populated by renderEmptyState; null = not yet fetched
```

- [ ] **Step 3: Add `renderEmptyState()` function**

Insert this function in `js/ui.js` somewhere reasonable — a good home is right above `openStartScreen()` (around line 1180), since both render no-plan-state surfaces:

```js
// Render the empty-state tracker view (no active plan). Three CTAs
// (Generate / Use a template / Blank session), a View full History
// link, and a Recent workouts list (last 7 days, tappable to open
// in the History detail modal).
//
// Called whenever the no-plan empty state needs to refresh — after
// endActivePlan, on hydrate's no-plan branch, and on sign-in when
// the user has no active plan.
function renderEmptyState() {
  var el = document.getElementById('emptyState');
  if (!el) return;

  var h = '';
  h += '<div class="empty-state-icon">🏋️</div>';
  h += '<h3>No active plan</h3>';
  h += '<p class="empty-state-hint">Pick something to work on, or generate a new plan.</p>';

  h += '<div class="empty-state-actions">';
  h += '<button type="button" class="empty-cta primary" id="emptyCtaGenerate">Generate a plan</button>';
  h += '<button type="button" class="empty-cta" id="emptyCtaTemplate">Use a template</button>';
  h += '<button type="button" class="empty-cta" id="emptyCtaBlank">Blank session</button>';
  h += '<button type="button" class="empty-cta link" id="emptyCtaHistory">View full History</button>';
  h += '</div>';

  h += '<div class="empty-state-recent" id="emptyStateRecent">';
  h += '<div class="empty-state-recent-label">Recent workouts</div>';
  h += '<div class="empty-state-recent-body">Loading…</div>';
  h += '</div>';

  el.innerHTML = h;

  // Wire button clicks. These reuse existing handlers — no new flows.
  var btnGen = document.getElementById('emptyCtaGenerate');
  if (btnGen) btnGen.addEventListener('click', function() { openGenerate(); });
  var btnTpl = document.getElementById('emptyCtaTemplate');
  if (btnTpl) btnTpl.addEventListener('click', function() {
    // The Templates flow lives inside the start screen as an inline
    // expanding card. Open the start screen — user clicks "Use a
    // template" there. One extra tap, but reuses the existing UX
    // without introducing a separate templates-picker modal.
    openStartScreen();
  });
  var btnBlank = document.getElementById('emptyCtaBlank');
  if (btnBlank) btnBlank.addEventListener('click', function() { createAdHocSession(); });
  var btnHist = document.getElementById('emptyCtaHistory');
  if (btnHist) btnHist.addEventListener('click', function() { openHistory(); });

  // Async-fill the Recent workouts list. Render immediately above so
  // the buttons show at 0ms; the list fades in when the query lands.
  fetchRecentWorkouts(userId, 7, 10).then(function(rows) {
    recentWorkoutsCache = rows;
    renderEmptyStateRecent();
  });
}

function renderEmptyStateRecent() {
  var body = document.querySelector('#emptyStateRecent .empty-state-recent-body');
  if (!body) return;
  var rows = recentWorkoutsCache;
  if (!rows) { body.textContent = 'Loading…'; return; }
  if (!rows.length) {
    body.innerHTML = '<div class="empty-state-recent-empty">No recent training in the last 7 days.</div>';
    return;
  }
  var h = '<div class="empty-state-recent-list">';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var d = new Date(r.performed_at);
    var dateLabel = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var nameLabel;
    if (r.day_name) nameLabel = r.day_name;
    else if (r.title) nameLabel = r.title;
    else nameLabel = 'Ad-hoc session';
    var locTag = r.location_name ? ' · @' + escapeHtml(r.location_name) : '';
    var setLabel = r.set_count + ' set' + (r.set_count === 1 ? '' : 's');
    h += '<button type="button" class="empty-recent-row" data-recent-workout-id="' + escapeAttr(r.id) + '">';
    h += '<span class="empty-recent-date">' + escapeHtml(dateLabel) + '</span>';
    h += '<span class="empty-recent-name">' + escapeHtml(nameLabel) + '</span>';
    h += '<span class="empty-recent-meta">' + escapeHtml(setLabel) + locTag + '</span>';
    h += '</button>';
  }
  h += '</div>';
  body.innerHTML = h;

  // Click delegate: tap a row to open in the History detail modal.
  body.addEventListener('click', function(e) {
    var row = e.target.closest('[data-recent-workout-id]');
    if (!row) return;
    openHistoryDetail(row.getAttribute('data-recent-workout-id'));
  });
}
```

- [ ] **Step 4: Hook `renderEmptyState()` into the lifecycle**

Three call sites:

**(a)** In `onEndPlan` (added in Task 3 step 3) — the placeholder `if (typeof renderEmptyState === 'function') { renderEmptyState(); }` is now real. No change needed since the function exists; the conditional just runs the function.

**(b)** Hydrate path. Locate `hydrate` in `js/app.js`. Find the spot where it handles "no active plan loaded" (search for `emptyState` in app.js — the existing path probably does `document.getElementById('emptyState').style.display = 'block'` or similar). Add a `renderEmptyState()` call right after that display flip. Concretely, search for the no-plan branch in `hydrate`:

```bash
grep -n "emptyState\|activePlanId.*null\|!plan\b" js/app.js
```

Find the branch where the app falls through to "no plan loaded" after the plan SELECT comes back empty. Add:

```js
if (typeof renderEmptyState === 'function') renderEmptyState();
```

Right after the existing `display = 'block'` toggle. If hydrate doesn't currently differentiate "no plan" from "plan loaded" beyond the display flip, it may just need the call added unconditionally inside the no-plan branch. The exact line may vary; the principle is: any code path that ends with the empty state visible should also call `renderEmptyState()`.

**(c)** In `endActivePlan` (Task 1) we already toggle `#emptyState` to display: block but don't call `renderEmptyState`. The UI-layer call site is in `onEndPlan` (added in Task 3). That covers the End-plan path. For the "sign in to a fresh account with no plan" path, hydrate covers it (item b above).

- [ ] **Step 5: Add CSS for the new empty-state markup**

In `index.html`'s inline `<style>` block, add styles for the new classes. Locate the existing `.empty-state` rules:

```bash
grep -n ".empty-state" /Users/sebastianvelez/workout-tracker/index.html | head
```

Add these rules after the existing `.empty-state` block:

```css
.empty-state-hint {
  color: var(--text2);
  margin: 8px 0 24px;
  font-size: 14px;
}
.empty-state-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 320px;
  margin: 0 auto 24px;
}
.empty-cta {
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface2);
  color: var(--text);
  font-family: 'Outfit', sans-serif;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.empty-cta:hover { background: var(--surface3); }
.empty-cta.primary {
  background: var(--accent);
  color: var(--accent-text, white);
  border-color: var(--accent);
}
.empty-cta.link {
  background: transparent;
  border-color: transparent;
  color: var(--text2);
  font-weight: 500;
  text-decoration: underline;
}
.empty-state-recent {
  max-width: 480px;
  margin: 0 auto;
  text-align: left;
}
.empty-state-recent-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text3);
  margin-bottom: 8px;
  padding: 0 4px;
}
.empty-state-recent-body { display: flex; flex-direction: column; gap: 6px; }
.empty-state-recent-empty {
  color: var(--text3);
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
.empty-state-recent-list { display: flex; flex-direction: column; gap: 6px; }
.empty-recent-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.empty-recent-row:hover { background: var(--surface3); }
.empty-recent-date { color: var(--text2); white-space: nowrap; }
.empty-recent-name { font-weight: 600; }
.empty-recent-meta { color: var(--text3); font-size: 12px; white-space: nowrap; }
```

If your color tokens differ (e.g., `--surface2` vs `--surface-2`), adjust to match the existing pattern in the stylesheet.

- [ ] **Step 6: Browser smoke test**

Hard-reload. End the active plan from the Plans modal (or sign in to a state with no active plan). Verify:

1. Empty state shows: 🏋️ icon, "No active plan" headline, "Pick something to work on, or generate a new plan." subtitle.
2. Three CTAs visible vertically: Generate (primary, accent color), Use a template, Blank session, View full History (link-styled).
3. Below the CTAs, "RECENT WORKOUTS" label + a list of last 7 days workouts. If you have recent training: rows show date · day name · set count + location tag. If you don't: "No recent training in the last 7 days."
4. Tap **Generate** → opens the Generate flow modal.
5. Close Generate, tap **Use a template** → opens the start-screen overlay (template card visible there).
6. Close start screen (or pick a template), get back to empty state. Tap **Blank session** → creates an ad-hoc session, focuses it. Verify the empty state hides and the ad-hoc card is visible.
7. End the ad-hoc to get back to empty state. Tap **View full History** → opens History modal at current week.
8. Close History. Tap a row in **Recent workouts** → opens the History detail modal for that workout. Verify Bring-to-today / Discard work from this entry point.

- [ ] **Step 7: Commit**

```bash
git add index.html js/ui.js js/app.js
git commit -m "$(cat <<'EOF'
ui(empty-state): refresh no-plan tracker view

Replace the v1 "Tap Import" copy with three CTAs (Generate primary,
Use a template, Blank session), a View full History link, and a
last-7-days Recent workouts list that opens rows in the existing
History detail modal. Renders on hydrate's no-plan branch and after
endActivePlan; reuses existing handler entry points throughout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Hide the day-picker dropdown when no plan and no ad-hocs

`buildTabs()` currently renders empty HTML when there's nothing to show. Instead, hide the wrapper element (`.day-picker-row`) so the page doesn't have a dangling empty dropdown.

**Files:**
- Modify: `js/ui.js` — `buildTabs()` around line 376.

- [ ] **Step 1: Toggle the wrapper visibility**

In `js/ui.js`, find `function buildTabs()` (line 376). Update it to also toggle `.day-picker-row` based on whether anything is shown. The existing function:

```js
function buildTabs() {
  var sel = document.getElementById('dayPicker');
  if (!sel) return;
  var h = '';
  if (plan) {
    // ... existing optgroup ...
  }
  if (todayAdHocs.length) {
    // ... existing optgroup ...
  }
  sel.innerHTML = h;
}
```

Update to:

```js
function buildTabs() {
  var sel = document.getElementById('dayPicker');
  if (!sel) return;
  var h = '';
  if (plan) {
    // ... existing optgroup (unchanged) ...
  }
  if (todayAdHocs.length) {
    // ... existing optgroup (unchanged) ...
  }
  sel.innerHTML = h;

  // Hide the dropdown wrapper when there's nothing to focus on. The
  // plan title / week header above stays visible (or shows "No active
  // plan"), and the New Session button below stays available.
  var wrap = sel.closest('.day-picker-row');
  if (wrap) {
    wrap.style.display = (h === '') ? 'none' : '';
  }
}
```

- [ ] **Step 2: Browser smoke test**

Hard-reload. Test these states:

1. **Active plan, no ad-hocs**: dropdown visible, shows plan-day options. ✓
2. **Active plan + 1 ad-hoc today**: dropdown visible with both optgroups. ✓
3. **No plan + 1 ad-hoc today**: dropdown visible with only the Ad-hoc sessions optgroup. ✓
4. **No plan + 0 ad-hocs**: dropdown hidden entirely. The day-picker-row's display is `none` — verify with DevTools Inspector. ✓
5. After ending a plan with no ad-hocs today: dropdown disappears. After ending with an ad-hoc focused: dropdown stays visible with the ad-hoc.

- [ ] **Step 3: Commit**

```bash
git add js/ui.js
git commit -m "$(cat <<'EOF'
ui(tabs): hide day-picker dropdown when no plan and no ad-hocs

Avoids a dangling empty <select> on the no-plan empty state. Wrapper
.day-picker-row gets display:none when buildTabs produces no options.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Update start-screen overlay copy + verify Template card not gated

The start-screen overlay already promotes Generate to primary in the no-plan state (per v2.5.6). Two cleanups remain.

**Files:**
- Modify: `js/ui.js` — `openStartScreen()` around line 1184.
- Modify: `index.html` — `#startPathEmptyHint` copy if needed.

- [ ] **Step 1: Verify the Use-a-template card isn't hasPlan-gated**

In `js/ui.js`, locate `openStartScreen()` (line 1184). The current `hasPlan` branch shows:

```js
if (hasPlan) {
  suggestedBtn.style.display = '';
  pickDayBtn.style.display = '';
  emptyHint.classList.add('hidden');
  // ...
} else {
  suggestedBtn.style.display = 'none';
  pickDayBtn.style.display = 'none';
  emptyHint.classList.remove('hidden');
  // ...
}
```

Confirm there are NO references to `startPathTemplate` being hidden / shown based on `hasPlan`. If there are, remove them — Template should always be visible. If there aren't (likely the case), no code change needed in this step. Verify by searching:

```bash
grep -n "startPathTemplate" /Users/sebastianvelez/workout-tracker/js/ui.js
```

Expected: only references that handle the inline expanding list (`startPathTemplateList.classList`, etc.) and the click handler — no `style.display` toggles tied to `hasPlan`.

- [ ] **Step 2: Update the `emptyHint` copy**

Find `#startPathEmptyHint` in `index.html` (search for `startPathEmptyHint`). Today it likely says something import-flavored. Update to a no-plan-aware message:

```html
<div class="start-empty-hint hidden" id="startPathEmptyHint">
  No active plan. Pick what to work on, or generate a new plan.
</div>
```

If the existing copy is already similar (the v2.5.6 changes may have already updated it), leave it alone. The grep:

```bash
grep -n "startPathEmptyHint" /Users/sebastianvelez/workout-tracker/index.html
```

— read the current value and update only if it's stale.

- [ ] **Step 3: Browser smoke test**

Hard-reload. End the active plan. Verify the start-screen overlay shows:

1. **Hidden**: Suggested day (`startPathSuggested`), Pick a different day (`startPathPickDay`).
2. **Visible**: Use a template (with inline expanding list), Blank session, Generate (promoted to primary, full-width accent color).
3. **emptyHint** below the cards reads the updated copy.
4. Tap Use a template → inline list expands. Pick a template → ad-hoc session is created, start screen closes.
5. Activate a plan again → reopen start screen (☰ → Start a workout). Confirm: Suggested day + Pick a different day are visible again, Generate is de-emphasized.

- [ ] **Step 4: Commit**

If only the HTML copy changed:

```bash
git add index.html
git commit -m "$(cat <<'EOF'
ui(start-screen): update no-plan emptyHint copy

Replace import-flavored hint with "No active plan. Pick what to work
on, or generate a new plan." to match the v3 no-plan UX direction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If `js/ui.js` also needed adjustment, include it in the same commit.

---

### Task 7: Final smoke test + APP_VERSION bump to v3.0.0

End-to-end verification of the full feature. Bumps the version on success.

**Files:**
- Modify: `js/app.js` — `APP_VERSION` constant (line 10).

- [ ] **Step 1: Run the full smoke test from the spec**

Walk through all 10 test cases in the spec ([docs/superpowers/specs/2026-05-02-end-plan-and-no-plan-ux-design.md](../specs/2026-05-02-end-plan-and-no-plan-ux-design.md), "Test plan" section). For each, follow the exact steps and confirm the expected outcome. The 10 cases are:

1. Activate → End round trip
2. End with logged work today
3. End with ad-hoc focused
4. Empty state with zero recent training
5. Recent workouts list — drill-down
6. Re-activate after end with in-progress session
7. No-plan empty state buttons
8. Cold reload in ended state
9. Coach chat after end
10. Multiple inactive plans

Do not skip any. If any case fails, stop and fix the regression before continuing. Re-run that case until it passes.

- [ ] **Step 2: Bump APP_VERSION**

In `js/app.js` (line 10), change:

```js
var APP_VERSION = 'v2.5.12';
```

to:

```js
var APP_VERSION = 'v3.0.0';
```

This is a major bump — the no-plan state becomes a first-class experience. Per the project's version scheme (memory: `feedback_versioning.md`), milestone bundles use the minor version; major-version bumps mark new lines. v3 is appropriate here because it changes the central workflow (the app no longer assumes a plan is loaded).

- [ ] **Step 3: Browser smoke test post-bump**

Hard-reload the app. Verify the bottom-right footer shows `v3.0.0`. Verify all the v2.5.12 functionality still works (sanity check — at minimum: log a set, mark it done, check the rest timer, open Coach chat).

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
v3.0.0 -- end plan + no-plan UX as first-class experience

Adds an "End plan" button to the Plans modal that drops the user into
a fully-usable no-plan state. The empty-state tracker view becomes a
real surface (Generate / Template / Blank CTAs + Recent workouts list
opening into History detail). Day-picker dropdown hides when there's
nothing to focus on. Start-screen overlay tightened to the three
relevant cards in the no-plan branch. End is fully reversible via the
existing Activate path; all attached workouts/sets/coach history are
preserved across the round trip.

Spec: docs/superpowers/specs/2026-05-02-end-plan-and-no-plan-ux-design.md
Plan: docs/superpowers/plans/2026-05-02-end-plan-and-no-plan-ux.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Hand off to user for push approval**

Per project workflow conventions, do NOT push. Surface the commit log to the user:

```bash
git log --oneline origin/main..HEAD
```

Report the commits and ask whether to push.

---

## Self-review checklist

- [x] Each spec section maps to a task. Surface 1 (Plans modal button) → Tasks 1+3. Surface 2 (empty state) → Task 4. Surface 3 (dropdown) → Task 5. Surface 4 (start screen) → Task 6. Reversibility (re-activate) → covered by existing `activateExistingPlan`, verified in Task 7 smoke test #1, #6.
- [x] Recent workouts query: implemented in Task 2 (`fetchRecentWorkouts`), wired in Task 4.
- [x] Hydration cache no-plan handling: covered by `clearHydrationSnapshot()` call in `endActivePlan` (Task 1).
- [x] Coach context staleness: handled by `refreshCoachForNewSession()` call in `endActivePlan` (Task 1); spec note that `_formatPlanForCoach` already handles `plan == null` gracefully (verified by reading data.js:2847).
- [x] Recent workouts query latency: addressed by async-fill pattern in `renderEmptyState` (Task 4 step 3) — buttons render at 0ms, list fades in.
- [x] Plan title clearing in no-plan state: covered by `endActivePlan` setting `#planTitle` = "No active plan" and `#planWeek` = "" (Task 1).
- [x] APP_VERSION bump: Task 7.
- [x] No placeholder phrases ("TBD", "implement later") in any task. All steps include actual code or actual commands.
- [x] Type/name consistency: `endActivePlan`, `fetchRecentWorkouts`, `renderEmptyState`, `recentWorkoutsCache`, `onEndPlan`, `data-end-plan-id`, `.empty-cta`, `.empty-recent-row` — these names are used consistently across all tasks.
- [x] Workflow rules from project memory honored: small focused commits, manual smoke test before each commit, APP_VERSION bumped only at end, no auto-push.
