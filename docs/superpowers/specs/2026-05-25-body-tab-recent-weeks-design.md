# Body tab: "Recent weeks" historical per-muscle volume

**Date:** 2026-05-25
**Status:** Approved, building

## Problem

The Body tab shows current-week per-muscle volume (chips, color-coded
against per-muscle MEV/MAV/MRV bands) and the projected weekly plan
("Planned (this week)"), but nothing historical. A historical per-muscle
weekly view *does* exist as the **Volume Trends modal** (v3.5.4) accessible
from the hamburger — but it (a) lives in a less-discoverable surface,
(b) is fractional-only with no primary toggle, and (c) doesn't share the
Body view's MEV/MAV/MRV color language, so the same number reads
differently between surfaces.

## Goal

Replace the Volume Trends modal with a **Recent weeks** section
on the Body tab that:

1. Surfaces historical weekly volume as a first-class section alongside
   current-week actuals and planned.
2. Uses the same per-(muscle, mode) MEV/MAV/MRV band coloring as Body
   chips and plan review, so "red" / "green" mean the same thing everywhere.
3. Supports both primary-only and Schoenfeld fractional counting via a
   user-controllable toggle.

## Layout

Third section in `renderBodyView` ([js/ui.js:2733](../../../js/ui.js#L2733)),
below "Planned (this week)":

```
Recent weeks
[ Primary | Fractional ]      [ 4w | 8w | 12w ]

chest    │ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ │  ╱╲╱╲       avg 11
back     │ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ │  ╲╱╲╱       avg 14
quads    │ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ │  ─╱╲╱       avg 9
...
```

- **One row per muscle.** Sorted by window total descending (matches
  existing modal). Muscle label on the left.
- **N pills per row**, one per week, oldest → newest, where N matches the
  selected window (4 / 8 / 12). Pills show the number; background color
  comes from that muscle's MEV/MAV/MRV bands in the active mode
  (`pv-deficit` / `pv-low` / `pv-in` / `pv-high` / `pv-excess` — reuse
  the existing classes from Body chips and plan review).
- **Rightmost pill is the current (in-progress) week.** Continuous trend
  read; matches the existing Volume Trends modal behavior.
- **Sparkline** to the right of pills — same per-row scaled inline SVG
  as the existing `_vtSparklineSvg`. `Avg` column at far right.
- **Tap a row → expand inline** to show both primary and fractional
  weekly numbers side-by-side plus per-mode band readouts:
  ```
  chest
    Primary:    1 2 3 4 5 6 7 8        MEV 4 · MAV 6-12 · MRV 18
    Fractional: 4 5 7 8 9 10 11 12     MEV 6 · MAV 10-16 · MRV 22
  ```
  Tap row again (or another row) to collapse.
- **Controls** above the table:
  - Segmented `[ Primary | Fractional ]` mode toggle.
  - Segmented `[ 4w | 8w | 12w ]` window toggle. Default 8.

## Data layer

Extend `fetchVolumeTrends` in [js/data.js:959](../../../js/data.js#L959)
to compute both primary-only and fractional in the same scan (one query,
two accumulators). New shape:

```
{
  weeks: [{ weekStart, label }, ...],   // unchanged
  muscles: [muscle_group, ...],          // unchanged (sorted by fractional total desc)
  byMuscle:         { mg: [n, ...] },    // fractional, unchanged
  byMusclePrimary:  { mg: [n, ...] },    // NEW — primary-only weekly counts
  totals:           { mg: n },           // fractional, unchanged
  totalsPrimary:    { mg: n },           // NEW
  averages:         { mg: n },           // fractional, unchanged
  averagesPrimary:  { mg: n },           // NEW
}
```

Counting rules match what's already used elsewhere:
- **Primary:** each completed set = 1.0 to `muscle_group` only.
- **Fractional (Schoenfeld):** 1.0 to `muscle_group` + 0.5 to each entry
  in `secondary_muscles`.
- Cardio + mobility filtered out as today.

Existing callers (the coach-context formatter `_formatVolumeTrendForCoach`
at [js/data.js:4828](../../../js/data.js#L4828)) consume `byMuscle` /
`muscles` only — fully back-compat.

## Coloring

Reuse the existing per-(muscle, mode) band → class mapping used by Body
chips and plan-review volume rows. Each pill is given a `pv-*` class based
on its number compared against the active mode's MEV/MAV/MRV thresholds
for that muscle. Bands come from the Coaching Profile (per-muscle overrides
+ seeded defaults). No new color logic — pure reuse.

## State

```js
var bodyRecentWeeksState = {
  weeks: 8,                 // 4 | 8 | 12
  mode: 'fractional',       // 'fractional' | 'primary'
  data: null,               // last fetchVolumeTrends result
  expandedMuscle: null,     // muscle name of currently expanded row, or null
};
```

- Persist `weeks` + `mode` in localStorage (`bodyRecentWeeks.weeks`,
  `bodyRecentWeeks.mode`) so the choice sticks across visits.
- Mode toggle reuses cached `data` → instant re-color, no fetch.
- Window toggle triggers a re-fetch.
- Switching tabs preserves `data` in memory; re-entering Body re-renders
  from cache (no spinner if `data` is fresh).

## Empty / loading

Same pattern as the other Body sections — slot `<div>` with `Loading…`
replaced after the async fetch resolves. Empty state when no completed
sets in the window: `"No completed sets in the last N weeks."`

## Removals

- Delete from [js/ui.js](../../../js/ui.js): `openVolumeTrends`,
  `closeVolumeTrends`, `loadAndRenderVolumeTrends`,
  `renderVolumeTrendsControls`, `renderVolumeTrends`, `volumeTrendsState`,
  and the `_vtSparklineSvg` helper (move into the Recent-weeks code path
  if no other callers remain).
- Delete from [index.html](../../../index.html): `#volumeTrendsOverlay`
  markup and all `.vt-*` CSS rules.
- Remove the hamburger menu entry that opens the Volume Trends modal.
- Add the new event-delegation handlers (mode toggle / window toggle /
  row expand) to the existing Body view click handler chain.

## Non-goals

- No new band logic. We do not introduce a third mode or change MEV/MAV/MRV.
- No multi-muscle drilldown. Tap-expand shows the two modes for the
  tapped muscle, nothing more.
- No date-range picker beyond 4/8/12. Custom windows can be added later
  if needed.
- No export / share button on Recent weeks. The AI analyze flow already
  receives the same data via the coach-context formatter.

## Responsive behavior

At 12-week × phone-narrow viewports (≤375px), the muscle label + 12 pills
+ sparkline + avg may not fit on one line. Acceptable degradations, in
order of preference:

1. Drop the sparkline column on narrow viewports (pills already convey
   the trend visually via color).
2. Allow horizontal scroll inside the pill strip (the row stays a single
   line; user scrubs).

Pick (1) by default; revisit if pills feel too dense at 12w.

## Versioning + rollout

Single visible change → APP_VERSION bump (per workflow conventions). The
data-layer extension to `fetchVolumeTrends` is additive; existing callers
unaffected.
