# Body tab — adjustable date range for "This week so far"

**Date:** 2026-06-28
**Status:** Approved

## Goal

On the Body tab, the "This week so far" section counts completed sets per muscle
group over a default range (the current calendar week). Let the user adjust that
range to see the per-muscle counts change, then easily return to the default.

## Scope

- Affects **only** the "This week so far" (actuals) section.
- "Planned (this week)" and "Recent weeks" are untouched.

## Controls

Rendered inside the actuals section, above the chips:

- Preset buttons: `This week` · `7d` · `14d` · `30d` · `Custom`
- When `Custom` is active: two `<input type="date">` fields (from / to) + `Apply`
- A caption shows the active range, e.g. `Jun 22 – Jun 28 · 7 days`
- `This week` is the default and doubles as the "back to default" button.

## Range math

- `This week` = current calendar week via existing `weekStartForLocalDate(today)`
  → `weekStart … weekStart+6`. Identical to current behavior.
- `7d` / `14d` / `30d` = rolling window ending today: `today-(N-1) … today`.
- `Custom` = the two date inputs; auto-swap if `from > to`; ignore Apply if either
  is empty.

## Data flow

- `This week` reuses the already-fetched week summary
  (`bodyChipDrillState.summary`) — no extra fetch, fast initial load unchanged.
- Any other range fires a separate `fetchWeekSummary(userId, start, end)` and
  stores the result in its own state (`bodyActualsRange.summary`). Planned and
  Recent weeks never read this.
- The chip drilldown (tap a muscle → contributing exercises) works for any range
  because the summary carries `exercisesByMuscle` for whatever window was fetched.
- Concurrency: a request token guards rapid preset clicks; only the latest
  result paints.

## State

```js
var bodyActualsRange = {
  preset: 'week',     // 'week' | '7d' | '14d' | '30d' | 'custom'
  start: null,        // YYYY-MM-DD — effective range start
  end: null,          // YYYY-MM-DD — effective range end
  summary: null,      // fetchWeekSummary result when preset !== 'week'
  inFlight: false,
  reqToken: 0,
};
```

Not persisted to localStorage. Re-entering the Body tab (`renderBodyView`) resets
`preset` to `week`, giving a predictable "back to default."

## Band coloring

Chips are color-graded against **weekly** MEV/MAV/MRV bands. That grading is only
meaningful for a ~7-day window.

- Range length ≤ 7 days (`This week`, `7d`, custom ≤7d): keep band coloring.
- Range length > 7 days (`14d`, `30d`, custom >7d): render chips **neutral grey**
  (raw totals still shown and still drillable) plus a caption noting weekly
  targets apply to 7-day ranges only.

Implement via a new `gradeChips` option on `_dualChipRowsHtml` (default true);
when false, non-zero chips render with the neutral treatment but stay interactive.

## Touch points

- `js/ui.js`
  - New `bodyActualsRange` state.
  - `renderBodyView`: reset range to `week` on entry.
  - `_renderBodyActualsSlot`: render range controls + caption; read the correct
    summary; pass `gradeChips` based on range length.
  - `_dualChipRowsHtml`: add `gradeChips` option.
  - New helpers: `_bodyActualsControlsHtml`, `_computeActualsRange`,
    `_loadBodyActualsRange` (fetch + paint with token guard).
  - `#bodyView` click delegator: handle `[data-ba-preset]` and `[data-ba-apply]`.
  - Reset `bodyChipDrillState.actualsKey = null` on range change.
- `js/app.js`: bump `APP_VERSION`.

## Out of scope

- Persisting the chosen range across sessions.
- Changing Planned / Recent weeks behavior.
- Per-week normalization of long-range totals (we neutralize coloring instead).
