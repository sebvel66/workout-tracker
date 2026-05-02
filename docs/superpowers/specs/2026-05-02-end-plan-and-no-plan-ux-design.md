# End plan + no-plan UX — Design

## Problem

Today, the only way to leave the active-plan state is to upload or generate a replacement. The Plans modal lets the user Activate / Rename / View / Delete, but Delete is gated by `workout_count > 0` (which is true for any plan that's been used), and there is no "deactivate" affordance. The user has three real scenarios that all want the same outcome — **be in the no-plan state without replacing**:

1. **Mesocycle complete.** Block finished; logging ad-hoc or analyzing before deciding what's next.
2. **Pause / break.** Travel, illness, or just not following the plan for a while.
3. **Mistake recovery.** Imported / generated a plan that's wrong and already has logged work, so Delete is blocked.

The DB already supports the no-plan state — `plans` has a partial unique index on `(user_id) WHERE is_active = true`, so zero-active is valid. But the UI surfaces around no-plan (`#emptyState`, the day-picker dropdown, the start-screen overlay) are stale or incomplete because no-plan was historically only the very-first-ever state.

## Goal

A clean, reversible "End plan" affordance that drops the user into a fully usable no-plan state. All three scenarios collapse into the same code path; the user re-activates from the Plans modal whenever they want to come back.

## Non-goals

- **Schema-level lifecycle tracking.** No `ended_at` column. The signal isn't consumed anywhere yet, and `created_at` of the next plan is good enough as an end-marker for now.
- **Chained flows.** No "End and analyze" / "End and generate" combo paths. End is just End. Generate / Analyze remain reachable via their existing entry points.
- **Scheduled end** ("plan ends Saturday"). YAGNI.
- **Editing past sessions from the dropdown.** Past days continue to live in the History browser; we are not changing the dropdown's "what's editable now" contract.

---

## Surface 1 — Plans modal: End-plan button

The Plans modal (`#plansOverlay`) already lists every non-template plan with View / Rename / Activate / Template / Delete. The active plan's row gets a new **End plan** button. Inactive plans don't show it.

Placement on the row: `View · Rename · End plan · Activate (disabled) · Template · Delete (disabled if has workouts)`. Visually, "End plan" uses the same neutral styling as the other action buttons; it isn't a danger button — End is reversible.

Click flow:

1. Native `confirm("End \"<title>\"? You can re-activate it from this list anytime.")` (matches the existing pattern used by Activate and Delete).
2. On confirm, run `endActivePlan()` (new function in `js/data.js`):
   - `UPDATE plans SET is_active = false WHERE user_id = $1 AND is_active = true` (single-row update via the partial unique index — but use the same `eq('is_active', true)` shape as `savePlanAsActive` for consistency).
   - Clear in-memory plan state: `plan = null; activePlanId = null; planCache` retained (other plans may still be cached); `todayState = null; todayPlanStates = {}; historicalCache = {}; daysWithHistory = {}; currentDay = 0; suggestedDayIndex = null;`.
   - Refresh coach context for new session (`refreshCoachForNewSession()`) — clears chat history and the plan-anchored context block so the coach doesn't keep referencing the now-ended plan.
   - Show the empty state (`#emptyState` visible, `#summaryBar` hidden, `#workoutContainer` cleared).
   - `buildTabs()` to re-render the day picker (it'll show only ad-hocs if any, else hidden — see Surface 3).
   - `saveHydrationSnapshot()` so the warm-boot path on next load lands on the no-plan state instead of the just-ended plan.
3. After the data-layer work, the Plans modal closes; show a toast `"Plan ended. Activate again from Plans anytime."` (informational, auto-dismiss).
4. The start-screen overlay auto-opens because the existing hydrate-time logic ("no plan + nothing-focused → open start screen") fires via the empty-state code path. Concretely: after `endActivePlan` finishes, call `openStartScreen()` if `todayAdHocs.length === 0`. If there are ad-hocs in progress today, leave them focused — closing the modal lands the user on the in-progress ad-hoc.

Error handling: do the DB write first, mutate in-memory state only after success — the same shape `activateExistingPlan` uses today. If the `UPDATE` throws, in-memory state is untouched and the user sees `"Couldn't end plan: <message>"` (auto-dismiss toast, `null` retryFn — matches `onActivatePlan` / `onDeletePlan`).

Edge case — **in-progress workout on the plan**: no special handling. The workout row stays in the DB with `plan_id` pointing to the now-inactive plan; `endedAt` is whatever it was (null if running, set if completed). On re-activation, hydrate picks it up exactly as today's logic does. Worth a one-line note in the confirm dialog? **No** — adds friction to the common case for a corner case the user can recover from cleanly. The toast already says they can re-activate.

---

## Surface 2 — Empty state in the tracker view

The current `#emptyState` ([index.html:2389](../../../index.html#L2389)) is a relic from v1:

```
🏋️
No Plan Loaded
Tap **Import** to load your weekly plan JSON, then start tracking.
```

Replaces with a richer card that mirrors the start-screen overlay's no-plan options plus a recent-history strip.

### Layout

```
🏋️  No active plan

[ Generate a plan        →  ]   (primary, full-width)
[ Use a template         →  ]   (secondary)
[ Blank session          →  ]   (secondary)
[ View full History         ]   (tertiary, link-styled)

— Recent workouts ———————————————

  [ Tue, Apr 28 · Day 4 — Pull · 15 sets ]
  [ Mon, Apr 27 · Day 3 — Legs · 18 sets ]
  [ Sun, Apr 26 · Ad-hoc: shoulders · 8 sets ]
  …
  (up to 7 calendar days back, most recent first)

  (or, if empty: "No recent training in the last 7 days.")
```

### Behavior

- **Generate / Template / Blank buttons**: each calls the same handler the start-screen overlay calls today. Generate → `openGenerate()`. Template → opens the existing template list flow (the same one wired to `startPathTemplate`). Blank → `createAdHocSession()`.
- **View full History**: opens the existing History modal (`openHistory()`).
- **Recent workouts list**:
  - Query: last 7 calendar days, all workouts (any `plan_id` including null), most recent `performed_at` first. Reuse the existing query shape from `fetchWeekSummary` if straightforward; otherwise a small dedicated `fetchRecentWorkouts(userId, days=7)` helper in `js/data.js`.
  - Per row: weekday + date · plan-day name (or ad-hoc title or "Ad-hoc session" if no title) · "<N> sets" · gym tag if present.
  - Tap a row → opens the existing `openHistoryDetail(workoutId)` modal. Read-only with the existing recovery actions (Bring to today, Discard) — same surface as History browser drill-down.
  - Cap at 10 rows visible (rare for someone training 2x/day to exceed this in a week, but the cap prevents an absurd scroll). Below the list, a subtle "View full History →" link if `count > 10`.
  - Loaded on empty-state render. Cache for the lifetime of the no-plan state (cleared when a plan is activated). Re-fetch only on explicit refresh (pull-to-refresh isn't a pattern here, so: re-fetch only when re-entering the no-plan state).

### When the empty state shows / hides

- Shows when `plan == null && activePlanId == null`. The existing `display: none` flip in `savePlanAsActive` / `activateExistingPlan` already controls this — we'd add the inverse flip in `endActivePlan`.
- Hides when a plan becomes active (existing behavior).
- Note: the empty state currently hides automatically while `body.unauthed` (sign-out screen). Keep that — `body.unauthed #emptyState { display: none !important; }` already at index.html:648.

### Header treatment

The plan title / week-label area at the top of the page (`#planTitle`, `#planWeek`) currently reads `Workout Tracker` / empty when no plan is loaded — it never had a no-plan-aware text. Update to:

- `#planTitle`: "No active plan"
- `#planWeek`: "" (empty — no week to show)

These get cleared inside `endActivePlan` and on hydrate's no-plan branch.

---

## Surface 3 — Day-picker dropdown when there's no plan

`buildTabs()` currently produces:
- `<optgroup label="Plan days">…</optgroup>` if `plan` is set.
- `<optgroup label="Ad-hoc sessions">…</optgroup>` if `todayAdHocs.length > 0`.

When neither is set, the dropdown ends up empty. We do not change the dropdown's contract. Behavior in the no-plan state:

- **No plan + no ad-hocs today**: dropdown is hidden. `buildTabs()` checks both conditions and toggles the dropdown's container `display: none` when there's nothing to show. (The `+ New Session` button stays visible — it's outside the dropdown.)
- **No plan + ad-hocs today**: dropdown shows just the "Ad-hoc sessions" optgroup, exactly as it does today.

We are deliberately **not** showing past 7 days as dropdown entries. Rationale:

1. The dropdown's mental model is "what's editable / focusable right now." Past days are read-only with recovery actions, so they belong in History detail, not the dropdown.
2. Recent history is surfaced on the empty state below the actions — same data, better placement.
3. Keeping the contract narrow lets us hide the dropdown entirely when nothing is going on, which is cleaner than a near-empty dropdown.

---

## Surface 4 — Start-screen overlay in no-plan state

The start-screen overlay (`#startScreenOverlay`) is auto-opened on hydrate when nothing's focused, and reopenable from the hamburger. Today (post-v2.5.6):

- `hasPlan = true`: shows Suggested-day, Pick-a-different-day, Use-a-template, Blank, Generate (de-emphasized).
- `hasPlan = false`: Suggested-day + Pick-a-different-day are hidden, Generate is promoted to primary, Use-a-template and Blank still visible. Close button hidden if no fallback (no in-progress ad-hoc).

This is mostly correct already. Two cleanups:

- Verify the "Use a template" card (`startPathTemplate` + `startPathTemplateList`) is not gated on `hasPlan`. If it is, ungate it — templates work identically with or without an active plan (they just create an ad-hoc session).
- Update the `emptyHint` text below the cards. Today it says something import-flavored; it should now read along the lines of *"Pick what to work on, or generate a new plan."*

No structural change; just verification and copy.

---

## Reversibility / re-activation flow

End is a one-flag flip. To come back:

- Open Plans modal → tap **Activate** on the plan that was ended.
- This calls the existing `activateExistingPlan(planId)` (data.js:2546). It:
  - Sets the target plan's `is_active = true`. (Since no plan is currently active when re-activating from the no-plan state, the `is_active = false` update on "the previously active plan" is a no-op.)
  - Loads the plan blob, repopulates `plan` / `activePlanId` / `planCache`.
  - `loadDaysWithHistory()` re-derives the day-tab dot state from the workouts table.
  - Hides empty state, shows summary bar, rebuilds tabs and the focused day.
  - `refreshCoachForNewSession()` rebuilds coach context from the now-active plan.
  - `saveHydrationSnapshot()` so warm-boot lands on the active state.

Everything attached to the plan is preserved across the round trip:
- `plans.data` (the plan JSON blob, including `start_date`).
- `plans.title` / `week`.
- All `workouts` rows (with their `plan_id` FK pointing back).
- All `sets` rows (cascade-attached to workouts).
- Coach history (`coach_messages` is plan-agnostic; it's owner-scoped, not plan-scoped).
- Templates derived from this plan (separate `is_template = true` rows).

If the user ends a plan that has an in-progress workout, re-activating brings that session back. Hydrate's normal "find today's plan-day workouts by `performed_at`" picks it up if the date matches today; otherwise it surfaces in the History browser as a past session and the existing Bring-to-today / Discard recovery flow applies.

---

## Code organization

### `js/data.js`

- New `endActivePlan()` async function next to `activateExistingPlan` (~2580). Mirrors `activateExistingPlan` in shape, but flips to inactive and clears state instead of populating it.
- New `fetchRecentWorkouts(userId, days)` helper (or extend `fetchWeekSummary` with a back-window arg if cleaner). Returns rows with `id, performed_at, day_index, title, plan_id, location_id, plans(title, data), locations(name)` and a count of completed sets per workout (sub-query or in-memory aggregate). Used by the empty-state Recent workouts list. Cap at 10 rows.

### `js/ui.js`

- `onEndPlan(planId)` handler near `onActivatePlan` / `onDeletePlan` (~3095). Shape mirrors `onActivatePlan`:

  ```js
  async function onEndPlan(planId) {
    var p = findPlanInList(planId);
    if (!p || !p.is_active) return;
    if (!confirm('End "' + (p.title || 'Untitled') + '"? You can re-activate it from this list anytime.')) return;
    try {
      await endActivePlan();
      closePlans();
      showToast('Plan ended. Activate again from Plans anytime.', null);
      if (todayAdHocs.length === 0) openStartScreen();
    } catch(err) {
      console.error('onEndPlan error:', err);
      showToast("Couldn't end plan: " + (err.message || 'unknown error'), null);
    }
  }
  ```

- `renderPlans()` (~3054) gains the End-plan button on active rows. Click delegate at the bottom of the function (where `data-plan-id` clicks already dispatch) gets a new `data-end-plan-id` branch.

- New `renderEmptyState()` function. Builds the new empty-state DOM (Generate / Template / Blank / View History buttons + Recent workouts list) and wires button clicks to existing handlers. Called whenever the empty state needs to refresh — most notably after `endActivePlan` and on hydrate when there's no plan.

- Extend `buildTabs()` (~376) so the dropdown's container element is hidden when neither `plan` nor `todayAdHocs.length` is set.

- `openStartScreen()` (~1184): verify Use-a-template card isn't gated on `hasPlan`; update `emptyHint` copy.

### `index.html`

- Replace the static `#emptyState` content (~2389) with an empty container that `renderEmptyState()` populates. Keep the same id so the existing `display: flex / none` toggles work.
- The current "Tap Import" copy moves out of static HTML — Import is no longer the primary path; it's still available via the hamburger.

### CSS

Reuse existing classes where possible:
- Action buttons reuse `start-card` / `start-card.primary` styling so the empty state matches the start-screen overlay visually.
- Recent workouts list reuses History-row-like styling. New class `.empty-recent-row` if needed; mirror `history-row` from the History browser.

---

## State / lifecycle

| Event | Plan state | Empty state | Start screen | Hydration cache |
|---|---|---|---|---|
| Sign in, no plan ever | null | shown | auto-opens | empty (or no `plan` key) |
| Sign in, active plan | populated | hidden | doesn't auto-open | full |
| User ends plan | null | shown | auto-opens (if no ad-hoc focused) | re-saved with `plan: null` |
| User re-activates | populated | hidden | doesn't auto-open | full |
| Active plan, hard reload | populated | hidden | doesn't auto-open (focused state) | full |
| Ended plan, hard reload | null | shown | auto-opens | empty-shape |

The hydration cache schema doesn't need a version bump — `plan: null` is already representable (the v2.4.0 reconcile handles it via the user-id-mismatch / plan-404 paths).

---

## Test plan (manual browser smoke test)

1. **Activate → End round trip.**
   - Active plan, no in-progress workouts. Open Plans modal → tap End plan → confirm.
   - Verify: Plans modal closes, toast shows, tracker drops to empty state, start-screen overlay auto-opens with Generate / Template / Blank visible (Generate primary), Suggested + Pick-day hidden.
   - Reopen Plans modal → tap Activate on the now-inactive plan → confirm.
   - Verify: tracker re-renders the plan, day tabs match prior state, day completion dots are correct, summary bar visible.

2. **End with logged work today.**
   - Plan active, log 2 sets done on Day 1, Day 1 timer running. Open Plans modal → End plan → confirm.
   - Verify: empty state shown, dropdown hidden (no ad-hocs today), Recent workouts list shows today's Day 1 with "2 sets". Tap that row → History detail opens with the running timer and logged sets.
   - Re-activate the plan. Verify Day 1 reappears with the running timer and the 2 sets, exactly as before.

3. **End with ad-hoc focused.**
   - Plan active, start an ad-hoc, focus it. Open Plans modal → End plan → confirm.
   - Verify: ad-hoc stays focused, start-screen does NOT auto-open, dropdown shows just the ad-hoc, summary bar visible (focused on the ad-hoc).

4. **Empty state with zero recent training.**
   - End the plan, then sign in as a user with no workouts in the last 7 days (or temporarily delete recent workouts in Supabase for testing).
   - Verify: empty state shows the three buttons + View full History link + "No recent training in the last 7 days."

5. **Recent workouts list — drill-down.**
   - End plan with 3-4 days of recent workouts. Verify list shows them most-recent-first with date, day name, set count.
   - Tap each → History detail opens correctly.
   - Verify Bring-to-today / Discard work from this entry point (no regression).

6. **Re-activate after end with in-progress session.**
   - Plan active, Day 2 timer running, 5 sets logged. End plan. Re-activate immediately.
   - Verify: Day 2 timer is still running with the same elapsed time, 5 sets are intact, RPE/notes preserved.

7. **No-plan empty state buttons.**
   - From empty state: tap Generate → opens Generate flow correctly.
   - Tap Use a template → opens template selection.
   - Tap Blank session → creates and focuses an ad-hoc.
   - Tap View full History → History modal opens at the current week.

8. **Cold reload in ended state.**
   - End plan, hard reload the browser. Verify warm-boot paints the empty state (not the just-ended plan), no flash of the stale plan.
   - Reactivate, hard reload. Verify warm-boot paints the active plan.

9. **Coach chat after end.**
   - Plan active, send 2-3 chat messages. End plan. Open coach chat panel.
   - Verify: chat history is cleared (or shows past messages at 0.65 opacity with date headers — the v2.4.21 behavior); new messages reflect "no active plan" context (Haiku shouldn't reference plan-day specifics).

10. **Multiple inactive plans.**
    - Have 2 already-inactive plans + 1 active. End the active. Verify Plans modal lists 3 inactive plans, none with Active badge, all with Activate button enabled. Activate the most recently-ended one. Verify only that one becomes active.

---

## Risks / open questions

- **Coach context staleness.** `refreshCoachForNewSession` is the existing entry point but it was designed for "new active plan starts." Need to verify it handles `plan == null` cleanly — specifically that `buildCoachContext` doesn't choke on a missing plan. If it does, we add a no-plan branch that builds a minimal context (just recent workouts + coach history). Worth checking during implementation.

- **Coach chat with no plan.** The four context layers in coach-chat (system prompt, semi-static per-session, live, history) all reference plan structure. Without a plan, layer 2 (semi-static) is mostly empty. Haiku should handle this gracefully ("client between plans, ad-hoc only") but it's a context shift worth validating in test step 9.

- **Hydration cache no-plan shape.** The v2.4.0 reconcile already handles `plan: null` (e.g., when an active plan is deleted on another device). Implementation should re-use that no-plan branch rather than introducing a parallel one.

- **Recent workouts query latency on the empty state.** First-paint of the empty state would block on this query. Mitigation: render the empty state with the buttons immediately; load Recent workouts asynchronously and fade in. Same pattern as the rest of the app's optimistic-render approach.
