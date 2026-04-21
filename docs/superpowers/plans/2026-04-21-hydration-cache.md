# Hydration Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint the last-seen tracker view synchronously from `localStorage` on app boot, then reconcile with Supabase in the background. Surface reconciliation state via a "Refreshing…" pill next to the plan week label.

**Architecture:** One cache key (`wt.hydration.v1`) in `localStorage`. Three helpers in `js/data.js` (`saveHydrationSnapshot` / `readHydrationSnapshot` / `clearHydrationSnapshot`) plus `visibilitychange` + `beforeunload` listeners. A new `paintFromCache()` IIFE in `js/app.js` runs synchronously before any network call; `hydrate()` then reconciles and removes the pill. No schema changes, no new dependencies.

**Tech Stack:** Vanilla JS with `<script src>` tags (no build step), Supabase client, plain `localStorage`. No test framework — verification is manual browser testing per project convention.

**Reference spec:** [docs/superpowers/specs/2026-04-21-hydration-cache-design.md](../specs/2026-04-21-hydration-cache-design.md)

---

## Testing approach

This project has no automated test framework. Each task ends with concrete manual verification steps (exact browser actions + expected observations) before commit. The comprehensive end-to-end test matrix (Task 8) runs through the 11-case checklist from the spec before the final commit.

To inspect / manipulate the cache during verification, open DevTools → Application → Local Storage → select the origin → look for `wt.hydration.v1`.

---

## Task 1: Add snapshot helpers to data.js

**Files:**
- Modify: `js/data.js`

### Step 1: Locate the right insertion point

- [ ] **Open `js/data.js` and find the end of the state-declaration block** (the section where `var plan`, `var activePlanId`, `var currentDay`, `var todayPlanStates`, `var todayAdHocs`, `var daysWithHistory`, etc. are declared near the top of the file).

Run: Grep tool for `^var daysWithHistory` in `js/data.js`.
Expected: one match.

The helpers go in a new block **immediately after** the state declarations and **before** the first `async function` — this keeps them visible to every caller in the file.

### Step 2: Add the constants and helpers

- [ ] **Insert this block at the chosen location (after state declarations, before the first `async function`).**

```js
// ---- Hydration cache ----
// localStorage-backed snapshot of the last-painted tracker state.
// Painted synchronously on boot (see paintFromCache in app.js) before any
// network call, then reconciled by hydrate(). Full design:
// docs/superpowers/specs/2026-04-21-hydration-cache-design.md
var HYDRATION_CACHE_KEY = 'wt.hydration.v1';
var HYDRATION_SCHEMA_VERSION = 1;
var HYDRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readHydrationSnapshot() {
  try {
    var raw = localStorage.getItem(HYDRATION_CACHE_KEY);
    if (!raw) return null;
    var blob = JSON.parse(raw);
    if (!blob || blob.schemaVersion !== HYDRATION_SCHEMA_VERSION) return null;
    if (!blob.userId || !blob.savedAt) return null;
    var age = Date.now() - new Date(blob.savedAt).getTime();
    if (!isFinite(age) || age > HYDRATION_MAX_AGE_MS) return null;
    return blob;
  } catch (_) {
    return null;
  }
}

function saveHydrationSnapshot() {
  // Guard: only snapshot when hydrate has fully populated in-memory state
  // for the current user. Prevents capturing half-loaded state from a
  // visibilitychange that fires mid-hydrate or right after sign-out.
  if (!userId || hydratedForUser !== userId) return;
  if (!activePlanId || !plan) return;
  try {
    var blob = {
      schemaVersion: HYDRATION_SCHEMA_VERSION,
      userId: userId,
      appVersion: (typeof APP_VERSION === 'string') ? APP_VERSION : null,
      savedAt: new Date().toISOString(),
      activePlanId: activePlanId,
      plan: plan,
      planTitle: plan.title || 'Workout Tracker',
      planWeek: planWeekLabel(plan) || plan.week || '',
      currentDay: currentDay,
      daysWithHistory: daysWithHistory || {},
      todayPlanStates: todayPlanStates || {},
      todayAdHocs: todayAdHocs || []
    };
    localStorage.setItem(HYDRATION_CACHE_KEY, JSON.stringify(blob));
  } catch (_) {
    // Quota exceeded or serialization failure — not fatal. Cache just
    // won't paint next boot; normal hydrate handles it.
  }
}

function clearHydrationSnapshot() {
  try { localStorage.removeItem(HYDRATION_CACHE_KEY); } catch (_) {}
}
```

### Step 3: Verify the helpers load without breaking the app

- [ ] **Hard reload the app in a browser** (Cmd+Shift+R). Open DevTools → Console.

Expected: no ReferenceErrors, no new errors. App behaves exactly as before (this task adds code but wires nothing into event flow yet).

- [ ] **In DevTools Console, verify the functions exist:**

```js
typeof saveHydrationSnapshot    // "function"
typeof readHydrationSnapshot    // "function"
typeof clearHydrationSnapshot   // "function"
HYDRATION_CACHE_KEY             // "wt.hydration.v1"
```

- [ ] **Confirm the guard works: call `saveHydrationSnapshot()` from Console before signing in.**

Expected: returns undefined, and `localStorage.getItem('wt.hydration.v1')` returns `null` (guard blocks it because `userId` is not set).

### Step 4: Commit

```bash
git add js/data.js
git commit -m "$(cat <<'EOF'
Hydration cache: add snapshot helpers (no wiring yet)

Adds readHydrationSnapshot / saveHydrationSnapshot / clearHydrationSnapshot
to js/data.js. No listeners or callers yet — those come in subsequent
commits. Guard in saveHydrationSnapshot prevents partial-state captures
during hydrate or right after sign-out.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire lifecycle listeners + end-of-hydrate snapshot

**Files:**
- Modify: `js/data.js`
- Modify: `js/app.js`

### Step 1: Add the two listeners in data.js

- [ ] **Locate the end of the block added in Task 1** (just after `clearHydrationSnapshot`).

- [ ] **Append the two listeners immediately after `clearHydrationSnapshot`:**

```js
// Snapshot on hide/unload. These fire reliably on iOS when the user
// swipes the PWA away or switches apps, and on desktop tab close.
document.addEventListener('visibilitychange', function() {
  if (document.hidden) saveHydrationSnapshot();
});
window.addEventListener('beforeunload', function() {
  saveHydrationSnapshot();
});
```

### Step 2: Add the end-of-hydrate snapshot call in app.js

- [ ] **Open `js/app.js`. Locate the success path of `hydrate()` — specifically the block around `buildTabs(); buildDay(currentDay);` near line 139-140.**

Run: Grep tool for `buildDay\(currentDay\);` in `js/app.js`.
Expected: one match around line 140.

- [ ] **Find this exact block:**

```js
    buildTabs();
    buildDay(currentDay);

    // Auto-open the start modal when no session is in-progress. Completed
    // sessions do not block the modal.
    if (inProgressKey == null) {
      openStartScreen();
    }
  } catch(err) {
```

- [ ] **Replace it with this (adds one line):**

```js
    buildTabs();
    buildDay(currentDay);

    // Snapshot the now-fresh state for next boot's paintFromCache.
    saveHydrationSnapshot();

    // Auto-open the start modal when no session is in-progress. Completed
    // sessions do not block the modal.
    if (inProgressKey == null) {
      openStartScreen();
    }
  } catch(err) {
```

### Step 3: Verify the cache is written on page hide

- [ ] **Hard reload, sign in, wait for the tracker to fully load.**

- [ ] **In DevTools → Application → Local Storage, confirm `wt.hydration.v1` now exists.** Click it and verify the JSON contains `schemaVersion: 1`, a `userId`, `savedAt`, `activePlanId`, `plan`, `planTitle`, `planWeek`, `currentDay`, `todayPlanStates`, `todayAdHocs`.

- [ ] **Simulate iOS app-swipe:** in DevTools Console, run:

```js
localStorage.removeItem('wt.hydration.v1');
document.dispatchEvent(new Event('visibilitychange'));
```

Note: `document.hidden` is false in a focused tab, so the above won't trigger a write. To actually test:

- [ ] **Switch to another browser tab** (focus away from the app tab).

- [ ] **Return to the app tab, check DevTools → Application → Local Storage.**

Expected: `wt.hydration.v1` present, `savedAt` updated to the moment you switched away.

### Step 4: Commit

```bash
git add js/data.js js/app.js
git commit -m "$(cat <<'EOF'
Hydration cache: lifecycle listeners + end-of-hydrate snapshot

Writes snapshot on visibilitychange (hidden) + beforeunload + successful
hydrate completion. Cache now populates but isn't read yet — that lands
in the next commit (paintFromCache).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Hook plan mutations and sign-out

**Files:**
- Modify: `js/data.js` (two spots)
- Modify: `js/auth.js`

### Step 1: Snapshot at the end of `savePlanAsActive`

- [ ] **In `js/data.js`, locate `savePlanAsActive` around line 1901.**

Run: Grep tool for `async function savePlanAsActive` in `js/data.js`.
Expected: one match.

- [ ] **Find this exact block at the end of `savePlanAsActive`:**

```js
  buildTabs(); buildDay(0);
  // Coach: new active plan → old chat + context are stale. Refresh both.
  refreshCoachForNewSession();
  return r2.data;
}
```

- [ ] **Replace it with this (inserts the snapshot call):**

```js
  buildTabs(); buildDay(0);
  // Coach: new active plan → old chat + context are stale. Refresh both.
  refreshCoachForNewSession();
  // Persist the now-active plan so next boot paints it, not the old one.
  saveHydrationSnapshot();
  return r2.data;
}
```

### Step 2: Snapshot at the end of `activateExistingPlan`

- [ ] **In `js/data.js`, locate `activateExistingPlan` around line 1957.**

- [ ] **Find this exact block at the end of `activateExistingPlan`:**

```js
  buildTabs(); buildDay(0);
  refreshCoachForNewSession();
  return r2.data;
}
```

- [ ] **Replace it with this:**

```js
  buildTabs(); buildDay(0);
  refreshCoachForNewSession();
  // Persist the re-activated plan so next boot paints it.
  saveHydrationSnapshot();
  return r2.data;
}
```

### Step 3: Clear cache on sign-out

- [ ] **Open `js/auth.js`, locate the `else` branch of `applySession` starting at line 138.**

Run: Grep tool for `hydratedForUser = null;` in `js/auth.js`.
Expected: one match at line 139.

- [ ] **Find this exact block:**

```js
  } else {
    hydratedForUser = null;
    stopTimerTick();
```

- [ ] **Replace it with this:**

```js
  } else {
    hydratedForUser = null;
    clearHydrationSnapshot();
    stopTimerTick();
```

### Step 4: Verify plan-activation updates the cache

- [ ] **Hard reload, sign in, open the Plans modal (hamburger → Plans), activate a non-current plan.** (If only one plan exists, import or generate a second one first.)

- [ ] **In DevTools → Application → Local Storage, confirm `wt.hydration.v1.activePlanId` matches the newly-activated plan's id.**

Note: you can check the active plan's id in DevTools by running `activePlanId` in Console.

### Step 5: Verify sign-out clears the cache

- [ ] **Still signed in, confirm `wt.hydration.v1` is present.**

- [ ] **Click the hamburger → Sign out.**

- [ ] **Check DevTools → Application → Local Storage.**

Expected: `wt.hydration.v1` is gone.

### Step 6: Commit

```bash
git add js/data.js js/auth.js
git commit -m "$(cat <<'EOF'
Hydration cache: plan-activation writes, sign-out clears

savePlanAsActive and activateExistingPlan now call saveHydrationSnapshot
after the in-memory state updates, so next boot paints the new active
plan instead of the old one. Sign-out clears the cache so the next
account doesn't inherit it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `paintFromCache()` IIFE

**Files:**
- Modify: `js/app.js`

### Step 1: Add the IIFE after `paintVersion`

- [ ] **Open `js/app.js`, locate the `paintVersion()` IIFE around line 14-17.**

Run: Grep tool for `paintVersion` in `js/app.js`.
Expected: one function definition + one invocation within the same IIFE.

- [ ] **Find this exact block:**

```js
// Paint the version tag in the bottom-right as soon as APP_VERSION is declared.
// DOM is already parsed here (all the script tags sit at the end of <body>).
(function paintVersion() {
  var el = document.getElementById('versionFooter');
  if (el) el.textContent = APP_VERSION;
})();

// ---- Hydration ----
```

- [ ] **Replace it with this (appends the new IIFE between them):**

```js
// Paint the version tag in the bottom-right as soon as APP_VERSION is declared.
// DOM is already parsed here (all the script tags sit at the end of <body>).
(function paintVersion() {
  var el = document.getElementById('versionFooter');
  if (el) el.textContent = APP_VERSION;
})();

// ---- Paint from hydration cache ----
// Runs synchronously before any network call. Reads the last-saved
// tracker state from localStorage and paints it so the user sees their
// last view instantly on warm boot. hydrate() then reconciles in the
// background and swaps in fresh data. Cold boot (no cache) falls through
// unchanged — #emptyState stays visible per HTML default until auth
// resolves. Full design: docs/superpowers/specs/2026-04-21-hydration-cache-design.md
var __hydratedFromCache = false;
(function paintFromCache() {
  var blob = readHydrationSnapshot();
  if (!blob) return;
  try {
    // Populate globals. hydrate() will overwrite these with fresh server
    // state when it runs; this is the optimistic first paint.
    activePlanId = blob.activePlanId;
    plan = blob.plan;
    planCache[activePlanId] = plan;
    currentDay = blob.currentDay;
    daysWithHistory = blob.daysWithHistory || {};
    todayPlanStates = blob.todayPlanStates || {};
    todayAdHocs = blob.todayAdHocs || [];
    sessionTodayStart = dayBounds(new Date()).start;

    // Paint.
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('summaryBar').style.display = 'flex';
    document.getElementById('planTitle').textContent = blob.planTitle || 'Workout Tracker';
    document.getElementById('planWeek').textContent = blob.planWeek || '';
    buildTabs();
    buildDay(currentDay);

    __hydratedFromCache = true;
  } catch (err) {
    // Paint failed — wipe the bad cache, reset globals, let hydrate do
    // its normal cold-render. Don't mask the error; log it.
    console.error('paintFromCache failed:', err);
    clearHydrationSnapshot();
    activePlanId = null; plan = null;
    todayPlanStates = {}; todayAdHocs = []; daysWithHistory = {};
    __hydratedFromCache = false;
  }
})();

// ---- Hydration ----
```

### Step 2: Verify warm-boot instant paint

- [ ] **Hard reload, sign in, wait for the tracker to fully paint.**

- [ ] **Confirm `wt.hydration.v1` exists in DevTools → Application → Local Storage.**

- [ ] **Hard reload again** (Cmd+Shift+R).

Expected: The plan title, week label, day tabs, and focused day's exercise cards all paint effectively instantly — before the tracker content fully settles from the network. There will still be a brief visual flicker when hydrate overwrites the data (no pill yet — that's Task 5), but the empty-state "Import a plan" view should no longer flash.

- [ ] **Open DevTools → Network, throttle to "Slow 3G", reload.**

Expected: cached view paints in <100 ms; the actual network requests take 2-5s; during that window the user already sees their last state.

### Step 3: Verify cold boot unchanged

- [ ] **Clear cache:** in DevTools Console, `localStorage.removeItem('wt.hydration.v1'); location.reload();`

Expected: the app behaves as it did before this feature — `#emptyState` visible until auth resolves, then hydrate renders the tracker.

### Step 4: Verify corrupt-cache recovery

- [ ] **Corrupt the cache:** in DevTools Console, `localStorage.setItem('wt.hydration.v1', 'not-valid-json'); location.reload();`

Expected: no crash, no flash of wrong data — app falls through to normal cold-boot behavior. `readHydrationSnapshot` returns null on the JSON.parse throw.

### Step 5: Commit

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
Hydration cache: paint from cache before network

New paintFromCache IIFE in app.js runs synchronously after paintVersion
and before any network call. Reads the cache, populates globals, paints
the DOM. Sets __hydratedFromCache flag so hydrate() knows to reconcile.
Reconcile logic + refreshing pill land in next two commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Refreshing pill (CSS + DOM)

**Files:**
- Modify: `index.html`
- Modify: `js/app.js`

### Step 1: Add CSS for the pill

- [ ] **Open `index.html`. Locate the `#planWeek` selector in the CSS block.**

Run: Grep tool for `#planWeek` in `index.html`.
Expected: at least one match in the `<style>` block.

- [ ] **Add this CSS block immediately after the `#planWeek` rule:**

```css
/* Optimistic-paint indicator: shown next to #planWeek when the tracker
   was painted from the hydration cache and hydrate() hasn't yet swapped
   in fresh server state. Removed on successful reconcile. */
.refreshing-pill {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  color: var(--text3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  vertical-align: 1px;
  letter-spacing: 0.3px;
}
```

### Step 2: Append the pill in paintFromCache

- [ ] **In `js/app.js`, locate the `paintFromCache` IIFE added in Task 4.**

- [ ] **Find this exact block inside the IIFE:**

```js
    document.getElementById('planWeek').textContent = blob.planWeek || '';
    buildTabs();
    buildDay(currentDay);

    __hydratedFromCache = true;
```

- [ ] **Replace it with this:**

```js
    var weekEl = document.getElementById('planWeek');
    weekEl.textContent = blob.planWeek || '';
    var pill = document.createElement('span');
    pill.id = 'refreshingPill';
    pill.className = 'refreshing-pill';
    pill.textContent = 'Refreshing…';
    weekEl.appendChild(pill);

    buildTabs();
    buildDay(currentDay);

    __hydratedFromCache = true;
```

### Step 3: Verify the pill appears on warm boot

- [ ] **Hard reload twice (first to populate cache, second to trigger paint).**

Expected: on the second reload, the "Refreshing…" pill appears immediately next to the plan week label, e.g. `Week of Apr 19 – Apr 25 Refreshing…`.

- [ ] **Note the pill is still visible after hydrate() completes** — that's fine; we remove it in Task 6. For now the pill appears permanently on warm boots.

### Step 4: Commit

```bash
git add index.html js/app.js
git commit -m "$(cat <<'EOF'
Hydration cache: refreshing pill next to plan week

paintFromCache now appends a '.refreshing-pill' span inside #planWeek
when painting from cache. Pill removal (on successful reconcile) lands
in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Reconcile logic in hydrate()

**Files:**
- Modify: `js/app.js`

### Step 1: Add a helper that removes the pill

- [ ] **In `js/app.js`, locate the `__hydratedFromCache` declaration added in Task 4** (just before the `paintFromCache` IIFE).

- [ ] **Find this line:**

```js
var __hydratedFromCache = false;
```

- [ ] **Replace it with this (adds a helper beneath):**

```js
var __hydratedFromCache = false;
function __removeRefreshingPill() {
  var pill = document.getElementById('refreshingPill');
  if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
  __hydratedFromCache = false;
}
```

### Step 2: Handle user-ID mismatch early in hydrate

- [ ] **In `js/app.js`, locate the top of `hydrate()`** where `userId = ures.data.user.id;` is set. Line should be around 28.

Run: Grep tool for `userId = ures.data.user.id;` in `js/app.js`.
Expected: one match.

- [ ] **Find this exact block:**

```js
    var ures = await sb.auth.getUser();
    if (!ures.data || !ures.data.user) return;
    userId = ures.data.user.id;

    var planRes = await sb.from('plans').select('*')
```

- [ ] **Replace it with this:**

```js
    var ures = await sb.auth.getUser();
    if (!ures.data || !ures.data.user) return;
    userId = ures.data.user.id;

    // If we painted from cache but the signed-in user doesn't match the
    // cached user (e.g. sign-out + sign-in as a different account), drop
    // the cache + pill and let the rest of hydrate render fresh.
    if (__hydratedFromCache) {
      var cachedBlob = readHydrationSnapshot();
      if (!cachedBlob || cachedBlob.userId !== userId) {
        clearHydrationSnapshot();
        __removeRefreshingPill();
      }
    }

    var planRes = await sb.from('plans').select('*')
```

### Step 3: Handle plan-404 on reconcile

- [ ] **In `js/app.js`, locate the `if (!planRes.data)` branch** (around line 33-42).

Run: Grep tool for `if \(!planRes.data\)` in `js/app.js`.
Expected: one match.

- [ ] **Find this exact block:**

```js
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

- [ ] **Replace it with this:**

```js
    if (!planRes.data) {
      plan = null; activePlanId = null;
      // If we painted from cache, the cached plan has been deleted on
      // another device. Clear cache + pill, then show empty state.
      if (__hydratedFromCache) {
        clearHydrationSnapshot();
        __removeRefreshingPill();
      }
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('summaryBar').style.display = 'none';
      document.getElementById('planTitle').textContent = 'Workout Tracker';
      document.getElementById('planWeek').textContent = 'No plan loaded';
      document.getElementById('dayPicker').innerHTML = '';
      openStartScreen();
      return;
    }
```

### Step 4: Remove pill on successful reconcile

- [ ] **In `js/app.js`, locate the `saveHydrationSnapshot();` call added in Task 2.**

Run: Grep tool for `saveHydrationSnapshot\(\);` in `js/app.js`.
Expected: one match (the end-of-hydrate call).

- [ ] **Find this exact block:**

```js
    buildTabs();
    buildDay(currentDay);

    // Snapshot the now-fresh state for next boot's paintFromCache.
    saveHydrationSnapshot();
```

- [ ] **Replace it with this:**

```js
    buildTabs();
    buildDay(currentDay);

    // Fresh server state is now rendered. Remove the refreshing pill if
    // this was a warm boot from cache.
    __removeRefreshingPill();

    // Snapshot the now-fresh state for next boot's paintFromCache.
    saveHydrationSnapshot();
```

### Step 5: Verify the pill disappears on successful reconcile

- [ ] **Hard reload twice.**

Expected: on the second reload, the pill appears briefly next to the week label, then disappears within 1-3 seconds once hydrate completes.

### Step 6: Verify the pill stays on hydrate failure

- [ ] **Clear cache, reload, let it fully paint (populates cache).**

- [ ] **Open DevTools → Network → throttle: Offline.**

- [ ] **Hard reload.**

Expected: cached view paints with the "Refreshing…" pill, hydrate fails due to offline. The pill remains visible because hydrate never reached the removal point. The console shows the expected auth/network error(s).

- [ ] **Set throttling back to "No throttling"**, reload to confirm recovery.

### Step 7: Verify multi-account handling

- [ ] **Sign out, sign back in as the same user** — cache was cleared on sign-out (Task 3), so this is effectively a cold boot with no pill.

Note: true multi-account testing requires a second Supabase account; if available, sign in as user A, populate cache, sign out (cache cleared), sign in as user B. Expected: no flash of A's data.

### Step 8: Commit

```bash
git add js/app.js
git commit -m "$(cat <<'EOF'
Hydration cache: reconcile logic + pill removal

hydrate() now detects user-ID mismatch and plan-404 cases that stem from
a cache/server divergence, and clears both the cache and the refreshing
pill. On successful reconcile the pill is removed just before the
end-of-hydrate snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Version bump + docs update

**Files:**
- Modify: `js/app.js`
- Modify: `HANDOFF.md`
- Modify: `DECISIONS.md`
- Modify: `ROADMAP.md` (if the hydration gap was listed — optional removal)

### Step 1: Bump APP_VERSION to v2.4.0

- [ ] **In `js/app.js`, find:**

```js
var APP_VERSION = 'v2.3.2';
```

- [ ] **Replace with:**

```js
var APP_VERSION = 'v2.4.0';
```

This is a minor bump (not patch) because it introduces new user-visible behavior — the instant-paint on warm boot and the refreshing pill are distinct from the v2.3.x line.

### Step 2: Add HANDOFF.md entry

- [ ] **Open `HANDOFF.md`. Locate the most recent version entry at the top of the "shipped" list** (it should be `v2.3.2`).

- [ ] **Insert a new entry above it:**

```markdown
- `v2.4.0` — Hydration cache for fast warm boot. On every lifecycle event (`visibilitychange → hidden`, `beforeunload`, successful `hydrate()`, plan activation), the app snapshots its in-memory tracker state to `localStorage['wt.hydration.v1']` — active plan, focused day, today's plan-states + ad-hocs, `daysWithHistory`. On next boot, a synchronous `paintFromCache()` IIFE in [app.js](js/app.js) runs before any network call: hides `#emptyState`, paints the plan title/week, day tabs, focused-day cards with logged sets. A small `Refreshing…` pill next to the week label signals the optimistic-paint state. `hydrate()` then runs as usual and reconciles: overwrites in-memory state with fresh server truth, removes the pill. User-ID mismatch (different account signed in) or plan-404 (active plan deleted elsewhere) clears the cache mid-reconcile and falls back to empty state. Sign-out clears the cache so the next account doesn't inherit it. Schema-versioned blob (`schemaVersion: 1`); age-gated at 7 days. No schema changes. Design: [docs/superpowers/specs/2026-04-21-hydration-cache-design.md](docs/superpowers/specs/2026-04-21-hydration-cache-design.md).
```

### Step 3: Update the "Current live version" line in HANDOFF.md

- [ ] **Near the top of HANDOFF.md, find:**

```markdown
Current live version: **`v2.3.2`**
```

- [ ] **Replace with:**

```markdown
Current live version: **`v2.4.0`**
```

### Step 4: Add DECISIONS.md entry

- [ ] **Open `DECISIONS.md`. Add a new entry at the top (newest-first convention):**

```markdown
## 2026-04-21 — Hydration cache for fast warm boot (v2.4.0)

**Problem.** Warm-boot latency: the empty-state shell ("Import a plan") flashes for 1-3s between page load and `hydrate()` completion. For a daily-opened PWA, the gap is a recurring friction on every open.

**Decision.** Cache the last-painted tracker state in `localStorage` and paint it synchronously on boot, before any network call. `hydrate()` still runs and reconciles in the background; a "Refreshing…" pill signals the state to the user. Cache is single-keyed (`wt.hydration.v1`), schema-versioned (`schemaVersion: 1`), age-gated (7 days), and scoped to the signed-in `userId`.

**Why not:**
- *Skeleton shimmer only.* Simpler but doesn't deliver "see what I last saw" — still blank during network.
- *Full PWA offline with service worker + IndexedDB.* Overkill for the current ask; the failure modes (stale service worker, IndexedDB migration) outweigh the benefit for a single-user app.
- *Write-through on every mutation.* Adds per-set-done / per-keystroke overhead. The lifecycle-event write cadence (`visibilitychange`, `beforeunload`, `hydrate` end, plan-activation) is sufficient because mutations already persist to Supabase via existing paths; the cache only drives the optimistic *first paint*, which only needs to be correct at the "close" moment.
- *Invalidate on `APP_VERSION` bump.* We bump APP_VERSION on every visible change; tying cache invalidation to it would defeat the feature on every deploy. Instead: separate `schemaVersion` constant, bumped only when the cache shape changes.

**Acceptable trade-off:** users may briefly see stale state after multi-device mutations (e.g., completed a set on another device). The pill signals this and the swap happens within ~2s.

**Files:** [js/data.js](js/data.js), [js/app.js](js/app.js), [js/auth.js](js/auth.js), [index.html](index.html). No schema changes.

**Spec + plan:** [docs/superpowers/specs/2026-04-21-hydration-cache-design.md](docs/superpowers/specs/2026-04-21-hydration-cache-design.md), [docs/superpowers/plans/2026-04-21-hydration-cache.md](docs/superpowers/plans/2026-04-21-hydration-cache.md).
```

### Step 5: Verify version paints correctly

- [ ] **Hard reload the app.**

Expected: bottom-right version footer reads `v2.4.0`.

### Step 6: Commit

```bash
git add js/app.js HANDOFF.md DECISIONS.md
git commit -m "$(cat <<'EOF'
v2.4.0 — hydration cache for fast warm boot

Bumps APP_VERSION, adds HANDOFF + DECISIONS entries for the feature.
The cache/paint/reconcile code was committed across the previous six
commits in this plan; this finalizes the release.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full manual test matrix

**Files:** none — this is a verification pass before declaring the feature done.

Run through every case. If any fails, fix inline (don't commit a half-broken feature); after fixes, re-run the full matrix.

- [ ] **Test 1 — Happy path warm boot.** Clear cache, reload, sign in, log 3 sets on any plan day. Switch to another app (or another browser tab). Return. **Expect:** instant paint of plan title/week/day tabs/logged sets with checkmarks; "Refreshing…" pill next to week; pill disappears within ~2s; content unchanged after swap.

- [ ] **Test 2 — Cold boot.** Clear cache, hard reload. **Expect:** current behavior — `#emptyState` visible briefly during auth, then tracker renders from scratch. No pill.

- [ ] **Test 3 — Multi-account.** (Requires a second account — skip if unavailable.) Sign in as user A, log sets, swipe away. Sign out. Sign in as user B. **Expect:** no flash of A's data, normal cold hydrate for B. Swipe + reopen as B. **Expect:** B's data paints instantly.

- [ ] **Test 4 — Offline reconcile failure.** Populate cache (reload, let it settle). DevTools → Network → Offline. Hard reload. **Expect:** last state paints from cache; pill stays; existing error-toast paths fire on any network action. Set throttling back to "No throttling"; reload to confirm recovery.

- [ ] **Test 5 — Plan deleted elsewhere.** Activate plan A (populate cache). Swipe away. In Supabase dashboard, set `is_active = false` on plan A (or delete it, gated on no-workouts). Return to the app. **Expect:** brief cache-paint flash, then empty state, `openStartScreen()` opens.

- [ ] **Test 6 — Plan-activation updates cache.** Open Plans modal, activate a different plan. Swipe away. Reopen. **Expect:** new plan paints instantly, not the old one.

- [ ] **Test 7 — Stale cache (>7d).** DevTools Console:

```js
var b = JSON.parse(localStorage.getItem('wt.hydration.v1'));
b.savedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
localStorage.setItem('wt.hydration.v1', JSON.stringify(b));
location.reload();
```

**Expect:** cache ignored on read (no paint); cold boot runs; fresh cache rewritten at hydrate end.

- [ ] **Test 8 — Corrupt cache.**

```js
localStorage.setItem('wt.hydration.v1', 'not-json-at-all');
location.reload();
```

**Expect:** no crash; cache cleared silently inside `paintFromCache`'s catch; cold boot runs.

- [ ] **Test 9 — Schema bump.**

```js
var b = JSON.parse(localStorage.getItem('wt.hydration.v1'));
b.schemaVersion = 99;
localStorage.setItem('wt.hydration.v1', JSON.stringify(b));
location.reload();
```

**Expect:** cache ignored on read; cold boot runs; fresh cache rewritten at hydrate end (back to `schemaVersion: 1`).

- [ ] **Test 10 — Midnight roll.** Log sets today, swipe away. If you can't literally wait until midnight, simulate by editing `savedAt` to a date two days ago (but still within the 7-day age window):

```js
var b = JSON.parse(localStorage.getItem('wt.hydration.v1'));
b.savedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
localStorage.setItem('wt.hydration.v1', JSON.stringify(b));
location.reload();
```

**Expect:** cached sets briefly visible with pill; fresh hydrate filters to today's bounds and swaps in empty/different today-state within ~1-2s.

- [ ] **Test 11 — Ad-hoc session persistence.** Create an ad-hoc session, log a set, swipe away. Reopen. **Expect:** ad-hoc tab focused instantly with logged set visible; normal reconcile.

- [ ] **If all 11 pass, the feature is done.** No additional commit.

---

## Self-review notes for the engineer

- Every task commits. If you stop mid-task, the prior commit is a working state (the feature degrades to "write cache but don't read it yet" between Tasks 2 and 4, which is safe).
- The `__hydratedFromCache` flag is a global because the codebase uses implicit globals (`<script src>` tags, not ES modules). Don't rewrite to ES modules — that's a separate refactor.
- Don't add `localStorage.setItem` calls outside `saveHydrationSnapshot`. All writes should go through the helper so the guard + error handling are consistent.
- The spec explicitly calls out what is NOT being cached (`weightUnit`). Don't add fields without bumping `HYDRATION_SCHEMA_VERSION`.
- If a future task changes the shape of `todayPlanStates`, `todayAdHocs`, or `daysWithHistory`, bump `HYDRATION_SCHEMA_VERSION` in the same commit — old caches will be ignored on read and rewritten correctly.
