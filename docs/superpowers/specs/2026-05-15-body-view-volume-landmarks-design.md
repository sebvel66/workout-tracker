# Body view: visible MEV/MAV/MRV definitions + diverging color scale

**Date:** 2026-05-15
**Status:** Approved, building

## Problem

In the Body view the MEV/MAV/MRV numbers per muscle only appear in chip
hover tooltips (no hover on mobile/touch) plus one dense run-on legend
sentence. There is no plain-language explanation of what the three
landmarks mean, and no per-muscle range table the user can actually
read. Separately, the 5-state color scale uses yellow (`#e8b34a`,
below-MAV) and orange (`#f0a64a`, above-MAV) which are nearly
indistinguishable, and red is shared by both the below-MEV and over-MRV
extremes so "too little" and "too much" look identical.

## Goals

1. Surface clear definitions of MEV, MAV, MRV and the per-muscle ranges
   so they are readable without hovering.
2. Recolor the 5-state scale into a diverging blue→green→red ramp where
   no two adjacent states (and neither extreme) are confusable, plus a
   visible color key.

Non-goal: changing any band *values*. `DEFAULT_MUSCLE_BANDS` and user
overrides stay exactly as defined.

## Design

### 1. Collapsible info panel

Replace the `body-view-band` run-on sentence in `renderBodyView()`
(`js/ui.js`) with a native `<details>` element:

- Summary: `What do MEV / MAV / MRV mean?` — collapsed by default.
- Open/closed state persisted in `localStorage` under
  `bodyInfoPanelOpen` (`'true'`/absent), matching the app's existing
  string-flag localStorage convention. A `toggle` listener attached
  after `body.innerHTML` writes the flag; the `open` attribute is set
  from the flag on render.

Panel contents, three blocks:

- **Definitions** — plain language:
  - MEV — Minimum Effective Volume: fewest weekly sets that still drive
    growth. Below this = under-dosed.
  - MAV — Maximum Adaptive Volume: the productive range where most
    growth happens. The target band.
  - MRV — Maximum Recoverable Volume: most weekly sets you can recover
    from. Beyond this = junk volume / fatigue risk.
- **Color key** — 5 swatches in scale order (below MEV → below MAV → in
  MAV → above MAV → over MRV), each with label + one-line meaning,
  using the actual `pv-*` classes so the key always matches the chips.
- **Ranges by muscle** — a compact table, one row per muscle from
  `DEFAULT_MUSCLE_BANDS` order, columns: Muscle · Primary
  (MEV / MAV low–high / MRV) · Fractional. Reads through
  `muscleVolumeBand(m, mode)` so Coaching-Profile overrides show, not
  just seeded defaults. `—` where a mode has no band.

### 2. Diverging color scale

Recolor the shared `pv-*` CSS classes in `index.html`. The classes are
also used by plan-review and coaching-profile chips, so the new scale
applies consistently everywhere (intended — one scale).

| Class | State | Old | New |
|---|---|---|---|
| `pv-deficit` | below MEV | red | indigo/blue |
| `pv-low` | below MAV | yellow | cyan |
| `pv-in` | in MAV | green | green (unchanged) |
| `pv-high` | above MAV | orange | orange (unchanged) |
| `pv-excess` | over MRV | red | deep red |
| `pv-empty` | no data | gray | gray (unchanged) |

Result: indigo → cyan → green → orange → red. "Too little" (cool) and
"too much" (warm) are different families; below-MEV no longer shares
red with over-MRV.

## Scope

Pure front-end. CSS color values in `index.html`; panel + table render
and the persistence listener in `renderBodyView()` (`js/ui.js`). No
data-model changes. Chip hover tooltips left as-is (now redundant on
desktop, harmless). Bump `APP_VERSION` (patch) and test before commit.
