# Ranked exercise swap, available for any session exercise

**Date:** 2026-05-15
**Status:** Approved, building

## Problem

The swap/recommend feature has two limits:

1. **One option only.** `SWAP_SYSTEM_PROMPT` instructs Claude to "Return
   exactly ONE exercise. Do not offer options." The UI is a single
   accept/reject. The user wants several alternatives, ranked.
2. **Plan-prescribed exercises only.** The ⇄ button renders on live-plan
   cards, the post-generate review, and a manual template picker.
   Ad-hoc-session exercises and extra exercises added to a plan day have
   no swap at all.

## Goals

- Return **3** alternatives, ranked best-fit first, each with a short
  rationale for its rank.
- Make swap available on **ad-hoc session exercises** and **extra
  exercises on a plan day**, in addition to the existing live-plan and
  post-generate-review contexts.

Out of scope (per user): superset members, template editor. No DB
schema changes.

## Design

### 1. API — 3 ranked options (`api/generate-plan.js`)

- `SWAP_SYSTEM_PROMPT`: replace the single-exercise instruction with:
  return **exactly 3** alternatives ranked best-fit first as
  `{ "options": [ { name, note, rest, sets, why }, … ] }`. `why` is a
  ≤15-word line explaining the option's rank position. All existing
  rules retained: verbatim library names, `weight_mode`-correct rounded
  weights, integer `rest`, `repeat:N` shorthand, exclude exercises
  already on the day, reason-aware selection, coaching continuity
  (don't re-suggest a rejected sub).
- `SWAP_MAX_TOKENS`: 500 → 1400 (three full prescriptions).
- New `validateSwapOptions(options, libraryNames, originalName,
  otherToday)`: array length exactly 3; each option passes the existing
  per-exercise validation; every name in library; none equals the
  original or any `other_today` entry; no duplicate names across the 3.
  On failure return 422 with raw text (existing pattern).
- `handleSwap`: parse `options`, run `expandSetRepeatsForOneExercise`
  on each, respond `{ options, replaced, reason, model, usage,
  generated_at }`. Internal API consumed only by this app — clean cut,
  no singular-`replacement` fallback.

### 2. Client — session swap context (`js/ui.js`)

- Add `swapState.context === 'session'` alongside `'live'` /
  `'review'`. It covers **both** ad-hoc-session exercises and
  extra-on-plan-day exercises: both are runtime session slots keyed
  `ex_N` in `state.exercises`, so one path serves both.
- Render a ⇄ button on the runtime workout exercise card (the
  `buildDay` card path), gated to editable view mode, carrying the
  session day key + `ex_N` via data attributes distinct from the
  live/review ones. Wire the click to `openSwapModalForSession`.
- `openSwapModalForSession(dayKey, ek)`: snapshot from
  `state.exercises[ek].exerciseMeta` (name, muscle_group,
  movement_pattern, equipment, weight_mode) + current sets. Send the
  other session exercises' names as `other_today` so Claude avoids
  duplicates (server already accepts client-supplied `other_today`).
  Movement-history weight calibration is context-independent and needs
  no change.

### 3. Client — ranked-list UI + apply (`js/ui.js`)

- `fireSwapFetch`: expect `body.options` (array of 3); store
  `swapState.options`, set `view = 'review'`.
- `renderSwapReview`: render a list of 3 rows — rank badge (#1/#2/#3),
  exercise name, the `why` line, compact set summary, **Use this**
  button per row — plus **Try again** (re-fire, reason editable) and
  **Cancel**. Replaces the single accept/reject.
- `acceptSwap(optionIndex)` branches on context:
  - `live`: mutate `plan.days[di].exercises[ei]`, persist to `plans`,
    log to `coach_messages` (existing behavior, chosen option).
  - `review`: mutate `generatedPlan` via the existing flat-ei writer
    (in-memory until the plan is accepted).
  - `session`: if any set in `state.exercises[ek].sets` has `done`,
    show a confirm dialog ("This exercise has logged sets — swapping
    will discard them"); on confirm, replace the slot's `exerciseId`,
    `exerciseMeta`, `sub`/`subExercise`, and `sets` with the chosen
    option's fresh prescription, persist session state via the normal
    save path, rebuild the day, and log the swap to `coach_messages`
    for coaching continuity. No `done` sets → apply immediately.

## Verification

- `node --check` on changed JS.
- Node sandbox smoke test of `validateSwapOptions` (accepts a valid
  3-array; rejects wrong length, dupes, original/other-today
  collisions, off-library names).
- Manual browser pass (no engine here): swap from a live plan, from the
  post-generate review, from an ad-hoc session, and from an extra on a
  plan day; confirm the confirm-dialog fires only when a session slot
  has done sets.

## Scope

`api/generate-plan.js` (prompt, token cap, validation, handler
response) and `js/ui.js` (state machine, session entry point, list UI,
apply branches). No schema changes. `APP_VERSION` patch bump; commit,
do not push without approval.
