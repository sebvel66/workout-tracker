# Flexible Session Start — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** Replace the current auto-focus-on-hydrate default (Day 0 or most-recent today-state) with an explicit session start modal. The modal offers a rotation-based suggested day, a list of plan days to pick from, and a blank (ad-hoc) session path. This spec covers the flexible session start feature only. A separate spec covers the lbs/kg unit toggle.

## Why

The current hydrate flow silently focuses Day 0 (or whatever today-state happens to exist) without giving the user a chance to say "actually, I want to train a different plan day today." This is wrong for the realistic case where the user's calendar doesn't match the plan's rotation — a skipped rest day, a travel week, rearranged split. The plan is supposed to be the *rotation*, not a calendar mapping.

The fix: an explicit choice point at session-start time. The plan stays as the organizational backbone, but the user chooses which day to train. This also naturally accommodates users with no active plan (today the tab strip and "+ New Session" button are only rendered when a plan exists, so a no-plan user has nowhere to begin).

Follow-up item from ROADMAP.md → "UX improvements" (replaced by this spec on implementation).

## Design

### Entry points & trigger logic

The modal opens automatically on app load **when no in-progress session exists today**. "In-progress" = any workout row (plan-day or ad-hoc) with `started_at IS NOT NULL AND ended_at IS NULL`. Completed workouts (`ended_at` set) do not block.

The modal also opens manually via a single hamburger menu item — **"Start another workout"** — always available, regardless of session state (fresh, mid-workout, post-completion). Tapping it while the currently focused session has sets logged is safe: the existing session's data is untouched; the user is starting a new one (or picking a different day's today-state to focus).

The modal does **NOT** open when:
- Hydrate finds an in-progress session (go directly to it — preserves "pick up where I left off").
- The user dismisses via tap-outside. Dismissed modal lands on the existing default-focused tab from the current hydrate logic (Day 0, most-recent today-state, or first ad-hoc). Tap-outside is only permitted when a fallback state exists; the no-plan / fresh-user case disables it so the user must pick a path.

**Commitment point:** tapping any of the three modal paths is the commit. Before that, no DB rows are written (lazy-workout semantics continue to apply — a plan-day workout row is created on first set-done, not on path selection).

### Modal structure & three paths

Bottom-sheet modal, reusing the existing `.modal-overlay` + inner sheet pattern shared by Hamburger, History, Gym Profiles, Exercise Picker, etc. (see [ARCHITECTURE.md → UI patterns](../../ARCHITECTURE.md#ui-patterns--conventions)). Same slideUp animation, same safe-area padding, same close-by-overlay-tap behavior (conditionally — see above).

**Path 1 — "Start [Day Name]" (primary, pre-selected suggestion):**

- Large primary card at the top of the modal.
- Content: day name (e.g., *"Start Day 3 — Pull"*) + a subtle one-line hint beneath it ("Last: Day 2 (Push), 2 days ago"). Hint omitted when there's no completion history.
- Suggested day = rotation+1: find the most recent completed workout for the active plan, take its `day_index`, and compute `(lastDoneIndex + 1) mod plan.days.length`. First-ever plan session → Day 0.
- Tap → close modal, focus the suggested day's today-state (`focusTab(di)` — lazy-creates the in-memory state; no DB write yet).

**Path 2 — "Pick a different day":**

- Expands in-place (not a separate screen) to reveal a tappable list of every plan day in plan order.
- Each row: day name + an optional badge on the right:
  - *"in progress"* if `todayPlanStates[di]` has a DB row with `started_at` and no `ended_at`.
  - *"completed today"* if the DB row has `ended_at`.
  - No badge for fresh days.
- Tap a row → close modal, `focusTab(di)`. If the day's today-state exists, it's editable (per the "edit after completion" rule from [DECISIONS.md](../../DECISIONS.md)); if not, a new lazy today-state is initialized.
- Historical workouts (prior days, not today) are NOT listed here. They remain accessible via the History modal (hamburger → History), unchanged.

**Path 3 — "Blank session":**

- Third card, equal visual weight to Path 2 (not demoted to secondary).
- Tap → close modal, call existing `createAdHocSession()` — which creates a `workouts` row with `plan_id = null`, inserts a fresh in-memory state, and opens the exercise picker via the existing flow.
- Default label: *"Blank session"*. User can rename via the title field on the ad-hoc session header (existing affordance).

### No-active-plan state

When no active plan exists (`activePlanId == null` or `plan == null`):

- Paths 1 and 2 are suppressed.
- Path 3 becomes the only option, styled as the primary action.
- Copy shifts: *"No active plan. Start a blank session, or import a plan first."*
- A secondary *"Import a plan"* link triggers the existing file-input flow (same DOM element the hamburger's Import item uses).

Same treatment when the plan JSON is malformed (`plan.days.length === 0`).

### Hydrate flow

Changes in [js/app.js](../../js/app.js), around the current default-focus logic (lines 88-99):

1. Existing today-states load runs unchanged.
2. After the load, run the in-progress check: any today-state whose DB row has `started_at IS NOT NULL AND ended_at IS NULL`.
3. Run the suggested-day query (one-shot):
   ```sql
   select day_index
   from workouts
   where user_id = auth.uid()
     and plan_id = <active_plan_id>
     and ended_at is not null
   order by ended_at desc
   limit 1;
   ```
   Result cached to a new module-level var `suggestedDayIndex` (plain `var`, same pattern as other state).
4. `currentDay` set to the in-progress session's key if one exists; otherwise fall through to existing default-focus logic.
5. `buildTabs()` + `buildDay(currentDay)` run as today — the session view is always the layer beneath the modal.
6. If no in-progress session exists, call `openStartScreen()` as an overlay on top of the rendered session view.

No new tables, no new columns, no new RLS policies. One additional SELECT per hydrate. No impact on the `sets` / `workouts` write paths.

### Hamburger menu addition

Add a single new item — **"Start another workout"** — near the top of the hamburger items (above History), following the existing list-item pattern (`.hamburger-item` with tap handler). Tap handler: close the hamburger sheet, call `openStartScreen()`.

The hamburger remains the established session-adjacent actions surface (History, Gym Profiles, Import, Export, Sign Out per v2.0.11 and follow-ups).

### UI pieces to remove

- The **"+ New Session"** standalone button next to the tab dropdown (added in Session A tail polish, 2026-04-17) is redundant with Path 3 of the new modal. Remove it. DOM element, associated event listener, CSS. `createAdHocSession()` itself stays — it's the Path 3 target.

The tab dropdown (native `<select>` with plan + ad-hoc optgroups) stays unchanged. It remains the mid-session navigator between plan days and ad-hocs — mid-session switching doesn't need to re-open the modal.

### Edge cases

- **Active plan imported mid-session:** `suggestedDayIndex` recomputes on the next hydrate (usually via `applySession` → `hydrate` after sign-out/sign-in or reload). No live recompute mid-session is needed or desired.
- **No completed workouts for active plan** (fresh plan, plan switch): suggested = Day 0.
- **Plan with `days.length === 0`:** same as no-active-plan branch.
- **User taps a day in Path 2 that has a completed today-session:** `focusTab(di)` shows the completed session in editable mode (edit-after-completion rule). The user can add extra sets, amend notes, etc. Completed ≠ locked.
- **User completes Day 2 and reopens app the same evening:** no in-progress session → modal opens → Path 1 suggests Day 3.
- **User has an in-progress ad-hoc + wants to start a plan day in parallel:** modal would be skipped on auto-open (ad-hoc is in-progress), but the hamburger "Start another workout" item is always available. Tap → modal → pick plan day → focus it. Both sessions coexist.

## Manual smoke test checklist

### Entry trigger logic
- [ ] Fresh user (no plan, no workouts) → modal opens on load, only Path 3 visible, "Import plan" link works.
- [ ] Active plan, no completed workouts → modal opens, Path 1 shows "Start Day 0: <name>".
- [ ] Last completed was Day 2, nothing in progress → reopen → modal shows, Path 1 suggests Day 3.
- [ ] Last completed was the final day in the plan → suggested wraps to Day 0.
- [ ] In-progress session on any plan day OR any ad-hoc → modal does NOT open; lands directly on the in-progress session.
- [ ] Completed Day 2 today + no in-progress → reopen app → modal opens (per decision P).

### Three paths
- [ ] Tap Path 1 → modal closes, focus lands on suggested day, lazy-state ready for first set.
- [ ] Tap Path 2 → list expands; tap Day 1 → modal closes, Day 1 focused.
- [ ] Path 2 badge on day with in-progress today-state = "in progress".
- [ ] Path 2 badge on day with completed today = "completed today".
- [ ] Path 2 fresh day = no badge.
- [ ] Tap Path 3 → modal closes, ad-hoc workout row inserted (`plan_id = null`), exercise picker opens.

### Hamburger "Start another workout"
- [ ] Visible in every session context (fresh, mid-workout, post-completion, ad-hoc).
- [ ] Opens the same modal. Picking a path mid-workout preserves the prior session's data (no deletes).

### Empty state & dismiss
- [ ] Modal tap-outside with existing fallback state → dismissed, lands on default `currentDay`.
- [ ] Modal on fresh-user state → tap-outside disabled; must pick a path.

### Plan changes
- [ ] Import new plan mid-session → reload → suggested day recomputes against new plan.
- [ ] Sign out / sign in → suggested-day query re-runs, modal opens with correct suggestion.
- [ ] Plan with `days.length === 0` → modal behaves like no-plan (Path 3 only).

### Regressions to verify didn't break
- [ ] Tab dropdown still switches between plan days + today's ad-hocs during a session.
- [ ] History modal (hamburger → History) still works; past-session edit flow unchanged.
- [ ] Removal of "+ New Session" standalone button doesn't orphan any CSS or event listener.
- [ ] `createAdHocSession()` still wired correctly from Path 3.

## Implementation surface summary

- **[js/app.js](../../js/app.js)** — hydrate flow: suggested-day query, in-progress check, conditional `openStartScreen()` call.
- **[js/data.js](../../js/data.js)** — new `loadSuggestedDayIndex()` query function. New module-level `suggestedDayIndex` var.
- **[js/ui.js](../../js/ui.js)** — new `openStartScreen()` / `closeStartScreen()`. New tap handlers for the three paths. Remove "+ New Session" button DOM + listener.
- **[index.html](../../index.html)** — new `#startScreenOverlay` modal markup following the bottom-sheet pattern. New `#hamburgerStartAnother` item in the hamburger menu. Remove `#btnNewSession` element.
- **No SQL migration, no schema changes, no new RLS policies.**

## Non-goals for this spec

- Showing historical (non-today) workouts in the start modal. History modal remains the surface for past-session browsing.
- Cross-day rotation analytics ("you've been skipping legs — consider Day 3"). The suggestion is strictly rotation+1; smarter defaults are future work.
- Tab-strip redesign. The `<select>` dropdown stays.
- Any changes to the "+ Add exercise" picker, rest timer, session timer, or existing session-view surfaces.
- The kg/lbs unit toggle (separate spec).
