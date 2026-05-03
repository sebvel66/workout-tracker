# Cold-start plan generation — design

**Date:** 2026-05-03
**Target version:** v3.3.0
**Status:** approved, ready for implementation plan

## Problem

The empty-state "Generate a plan" CTA introduced in v3.0.0 can never succeed. The server-side plan-mode handler at [`api/generate-plan.js:185-186`](../../api/generate-plan.js#L185) bails with `400 "No active plan. Import a plan before generating."` when there's no active plan, and again at [`line 188-189`](../../api/generate-plan.js#L188) with `400 "No workout history found..."` when there's no logged history. Both bails predate the no-plan UX (commit `3b33a3e`, original Edge Function — months before v3.0.0).

The result: any user who has ended their plan via the v3.0.x End-plan flow, or any brand-new user, sees the empty-state CTA but gets a stale-feeling error when they tap it.

## Goal

Plan-mode generation should succeed from any starting point:

| Scenario | Active plan? | Logged history? | Behavior today | Behavior in v3.3.0 |
|---|---|---|---|---|
| Current user (existing plan, history) | ✓ | ✓ | works | unchanged |
| Post-End-plan with prior history | ✗ | ✓ | 400 "Import a plan" | succeeds |
| Brand-new user | ✗ | ✗ | 400 "Import a plan" | succeeds (cold start) |
| User with history but >4 weeks gap | ✗ | empty in window | 400 history bail | depends on `historyWeeks` slider; if 0, cold-start |

Refine and Swap continue to require an active plan — they're fundamentally about evolving an existing one.

Plus: a small UX fix on the analyze error message (same code area, related defect class — see "Analyze error message" section).

## Server changes — `api/generate-plan.js`

### Two bails removed in plan-mode

[`line 185-186`](../../api/generate-plan.js#L185) and [`line 188-189`](../../api/generate-plan.js#L188) deleted. The plan-mode handler runs to completion regardless of whether `activePlan` and `history` are populated.

### `formatCurrentPlan` null guard

[`line 615-616`](../../api/generate-plan.js#L615) currently does `const d = activePlan.data || {};` — crashes on null. Add a one-line guard at the top:

```js
function formatCurrentPlan(activePlan) {
  if (!activePlan) return '';
  const d = activePlan.data || {};
  // ... unchanged
}
```

Internal guard rather than caller-side `if (activePlan) ...` because:
- It's the only formatter that crashes on null today; consolidating the guard inside makes future callers safe by default.
- All call sites (line 573 in plan, line 942 in analyze) collapse to a uniform `dynText += formatCurrentPlan(activePlan);` — analyze's existing `if (activePlan)` guard becomes redundant but harmless (can be cleaned up in a follow-up; not in scope for v3.3.0).

### Other formatters

Already empty-array safe — verified during brainstorming:
- `formatVerbatimHistory` ([line 649-650](../../api/generate-plan.js#L649)): `if (!workouts.length) return '';`
- `formatSummarizedHistory` ([line 720-721](../../api/generate-plan.js#L720)): `if (!workouts.length) return '';`
- `formatCoachHistory` ([line 475-476](../../api/generate-plan.js#L475)): `if (!Array.isArray(messages) || !messages.length) return '';`
- `formatWorkoutVerbatim` ([line 667-668](../../api/generate-plan.js#L667)): null-guards activePlan internally with `activePlan && activePlan.data` / `activePlan && activePlan.id`.

No changes needed to any of these.

### Cold-start signal in user message

When **both** `activePlan` is null AND `history.length === 0`, prepend a short marker to the dynamic text so the planner explicitly knows it's building a first plan (rather than inferring from absent sections):

```
COLD START: No prior plan and no logged training history. Build the first training week for this client based on CLIENT PROFILE and USER INPUTS below.
```

Implementation in `buildUserMessage` ([line 546](../../api/generate-plan.js#L546)):

```js
let dynText = '';
dynText += formatCoachingProfile(coachingProfile);
// v3.3.0 cold-start marker — explicit signal to the planner when both
// the active plan and history are absent. When only one is missing
// (post-End-plan with prior history; or brand-new with no profile yet),
// the marker is omitted and the model infers from absent sections.
if (!activePlan && history.length === 0) {
  dynText += 'COLD START: No prior plan and no logged training history. Build the first training week for this client based on CLIENT PROFILE and USER INPUTS below.\n\n';
}
dynText += formatCurrentPlan(activePlan);
// ... rest unchanged
```

When only ONE of {plan, history} is missing, the existing prompt structure handles it naturally — just an absent section. No marker.

## Analyze error message UX fix

The analyze handler keeps its `if (!history.length)` bail ([line 845-847](../../api/generate-plan.js#L845)) — analyze is fundamentally history-aware and cannot run on no-history input. But the message changes:

Today:
> `"No workout history found. Log at least one week of training before requesting an analysis."`

After:
> `` `No workouts in the last ${historyWeeks} weeks. Try a wider history window or generate a fresh plan first.` ``

The substituted N (`historyWeeks` value) appears literally in the toast. Both halves of the message are accurate for both true cold-start and history-window-empty cases:
- True cold-start (zero history): "Try a wider window…" leads nowhere (still empty), but "…or generate a fresh plan first" gives the right next step (generate now works post-v3.3.0).
- Window-empty (years of history, none in last 4 weeks): "Try a wider window" is the correct first step.

## Frontend changes

**None.** The empty-state Generate CTA already POSTs to `/api/generate-plan` with `mode` defaulting to plan; the issue was purely server-side. After v3.3.0, the same CTA succeeds.

The accept-flow handler `savePlanAsActive` ([data.js:2725](../../js/data.js#L2725)) handles the no-prior-active-plan case correctly — it inserts a new plan row with `is_active = true` and updates in-memory state. Verified during brainstorming.

## What stays unchanged

- **Refine** ([line 1287](../../api/generate-plan.js#L1287)): still bails when `activePlan` is null. Refine is multi-turn evolution of an existing plan; without one, refinement has no anchor.
- **Swap** ([line ~1100](../../api/generate-plan.js#L1100)): still requires `activePlan`. Swap operates on a single exercise within an existing plan slot.
- **Coach** (`api/coach-chat.js`): unrelated endpoint. Already handles all states.
- **System prompts** (`system-prompt-plan.md`, `system-prompt-core.md`): no rewrite needed. Verified during brainstorming — the rules are about USER INPUTS and CLIENT PROFILE, not about a prior plan being present. The model will produce reasonable plans for cold-start input given the COLD START marker plus the coaching profile.

## Cache implications

The Anthropic prompt cache prefix consists of: system prompt (cached) + exercise library (cached). Both are stable between cold-start and successor-plan calls — same library, same system prompt. The dynamic suffix changes (cold-start marker present/absent, current-plan section present/absent), but the cache prefix is preserved. Cold-start calls hit the same warm cache as successor-plan calls. No cache regressions.

## Smoke-test checklist (manual)

1. **No-plan + history**: end your active plan via the Plans modal → empty state appears → tap "Generate a plan" → submit form → wait → review screen renders a plan based on your history → tap accept → plan activates and shows in tracker.
2. **Cold start (no plan + no history)**: simulate by ending plan and either (a) choosing `historyWeeks = 1` after a week with zero logged workouts, or (b) deleting recent workouts directly in Supabase to fully clear the window → Generate → succeeds → review screen renders a first plan → accept works → plan activates. Vercel logs show `[generate-plan] data fetch:` for the request; the COLD START marker isn't directly logged but its presence is implied by the successful response (the bail is gone, formatters handle null, and the planner produced output).
3. **History-window-empty**: have history but no workouts in the last 4 weeks → Analyze with default 4 weeks → toast reads `"No workouts in the last 4 weeks. Try a wider history window or generate a fresh plan first."` → tweaking the slider to a wider window succeeds.
4. **Existing flow with active plan**: regression check — generate a successor plan from an active plan + history → still works → COLD START marker NOT in the prompt.
5. **Refine still bails**: try Refine without an active plan (e.g., before activating from cold-start) — still returns the existing 400. (No way to hit this normally since refine UI only renders post-generate, but worth a sanity check via DevTools.)

## Version target

**v3.3.0** — minor bump per project convention (new functional path: cold-start generation). Diff is modest but unlocks the empty-state CTA permanently.

## Out of scope

- Splitting `mode: 'fresh'` into a separate API mode (over-engineered — same code path with conditional sections is simpler).
- Validation that requires the coaching profile to be filled out before cold-start (let the planner handle sparse profiles; the app already nudges users to fill out the profile via the menu).
- Visual cues in the UI distinguishing cold-start review from successor-plan review (the user already knows which they triggered).
- Removing the now-redundant `if (activePlan)` guard in analyze ([line 942](../../api/generate-plan.js#L942)) — harmless, can be cleaned up later.
- Cleaning up the dropped Refine bail message style. Refine bail stays unchanged.

## Open questions

None.
