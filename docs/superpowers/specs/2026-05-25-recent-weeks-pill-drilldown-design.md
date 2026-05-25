# Recent weeks: pill drilldown to exercises

**Date:** 2026-05-25
**Status:** Approved, building

## Problem

The Body tab's "Recent weeks" section (v3.6.32) shows weekly per-muscle
volume as color-coded pills. A pill conveys "5 sets of chest in week
of Mar 10" but not "which exercises contributed those sets." The user
has to mentally reconstruct from History or open the workout to see.
For the current week, "what's still planned" lives in a separate "Planned
(this week)" section above — also disconnected from the weekly pill.

## Goal

Make each non-zero pill tappable. Tapping a pill expands an inline
panel BELOW the existing row-expand two-strip panel that shows:

- **Past weeks:** the exercises that contributed completed sets to that
  pill, with per-exercise sets count and contribution math.
- **Current week:** the same COMPLETED list, plus a PLANNED REMAINING
  section listing exercises from the active plan's not-yet-done days
  that target the muscle in the section's active mode.

This closes the "why is my chest at 6 this week?" question and surfaces
upcoming volume in the same place as historical volume.

## Layout

The new drilldown appends BELOW the existing two-strip panel inside
the row-expand area. The row must be expanded (tapping a pill auto-
expands the row if it's collapsed).

```
chest    │ ▢ ▢ ▢ ▢ ▢ ▢ ▣ ▢ │  ╱╲╱╲       avg 11
         ↑ selected pill (week of Mar 10) gets a ring border
─────────────────────────────────────────────────
PRIMARY      [pills…]            MEV 7 · MAV 12-20 · MRV 26
FRACTIONAL   [pills…]            MEV 7 · MAV 12-22 · MRV 28
─────────────────────────────────────────────────
COMPLETED · week of Mar 10
Barbell Bench Press     · 3 sets · +3.0
Incline DB Press        · 3 sets · +3.0
Cable Fly               · 4 sets · +2.0 (secondary)
                                  ──── 8.0 total ────

PLANNED REMAINING                              (current week only)
Decline Press           · 4 sets prescribed · +4.0
Pec Deck                · 3 sets prescribed · +3.0
```

Decimal formatting matches the pill format: integer when whole,
otherwise one decimal place. Contribution math reflects the section's
active mode (primary or fractional). In fractional mode, secondary-
muscle contributions are tagged `(secondary)`.

## Interaction model

- Tap a non-zero pill → set `selectedPill = { muscle, weekIdx }`,
  auto-expand the row if collapsed, render the drilldown panel below
  the two-strip view.
- Tap the same pill again → clear `selectedPill`, keep two-strip
  panel.
- Tap a different pill in the same row → swap drilldown contents.
- Tap a pill in a different row → clear previous, set new (and that
  row auto-expands).
- Tap the row anywhere outside a pill → toggle the row's expand
  state; collapsing also clears `selectedPill`.
- Toggle the section mode (primary ↔ fractional) → `selectedPill`
  persists, drilldown re-renders with the new mode's contribution math.
- Toggle the window (4w/8w/12w) → `selectedPill` clears (weekIdx
  becomes meaningless across windows).
- Zero-value pills are **not** tappable. They render as `<span>` with
  a faded appearance, not `<button>`.

## Data layer

Extend `fetchVolumeTrends` ([js/data.js:959](../../../js/data.js#L959))
to compute per-(muscle, weekIdx) exercise breakdowns in the same pass:

- Add `name` to the embedded `exercises!exercise_id(...)` select.
- In the existing accumulation loop, build:

  ```js
  byMuscleWeekExercises: {
    [muscle]: [
      // length = weeksBack, indexed parallel to weeks[]
      { exercises: [
          { name: 'Barbell Bench Press', sets: 3, role: 'primary' },
          { name: 'Cable Fly',           sets: 4, role: 'secondary' },
          ...
      ]},
      ...
    ]
  }
  ```

- Roles: `'primary'` if the muscle is the exercise's primary; `'secondary'`
  if it's in `secondary_muscles`. (An exercise contributes the same
  muscle in only one role per pass — primary takes precedence.)
- Within a week-cell, exercises are aggregated by name (multiple workouts
  using the same exercise sum their done-set counts).
- Sort order within a cell: primary contributions first, then secondary,
  each block sorted by sets desc.

Zero extra queries; memory is bounded (8w × ~13 muscles × ~5
exercises ≈ 520 entries at most). Existing callers
(`_formatVolumeTrendForCoach`) consume only `byMuscle`/`muscles`/
`averages` → fully back-compat.

## Planned-remaining (current week only)

For the CURRENT week's pill (rightmost), compute planned-remaining
from the in-memory `activePlan` blob:

1. Determine the current week's Sun-anchored start.
2. Find the set of `activePlan.days[]` indices already done this week
   (any workout row with `plan_id === activePlanId` and
   `day_index === di` and `performed_on` in [weekStart, weekEnd]).
3. For each `di` NOT in that set: iterate the day's exercises.
4. Filter by muscle match against the section's active mode:
   - **Primary mode:** include if `exercise.muscle_group === muscle`.
   - **Fractional mode:** include if primary OR `secondary_muscles`
     contains `muscle`.
5. Compute the prescribed-sets count from
   `exercise.sets.length` (or equivalent per-day shape).
6. Contribution = sets × 1.0 (primary) or sets × 0.5 (secondary) per
   the active mode rules.

We reuse the existing helpers that resolve plan days in the Body view
("Planned (this week)" section already does this for muscle-volume
totals — extract the per-exercise iteration as a small helper).

For past weeks, this section is omitted entirely.

For weeks with NO plan-remaining (current week, all plan-days done +
zero ad-hoc), the PLANNED REMAINING header is suppressed (no empty
block).

## State

Add one field to `bodyRecentWeeksState`:

```js
selectedPill: null  // null | { muscle, weekIdx }
```

Not persisted to localStorage — drilldown is a transient interaction.

## UI: pills become buttons (when non-zero)

In `_bodyRwRowHtml` and `_bodyRwExpandHtml`, change non-zero pill
emission from `<span>` to `<button type="button">` with:

```html
<button class="body-rw-pill pv-* [is-selected]"
        data-rw-pill="<weekIdx>"
        data-rw-pill-muscle="<muscle>"
        title="MEV X · MAV Y-Z · MRV W (mode)">5</button>
```

Zero pills stay `<span>` (visually faded, non-interactive). Selected
pill (within the same row) gets `.is-selected` class.

## UI: drilldown panel render

`_bodyRwExpandHtml(muscle)` appends a new `.body-rw-drilldown` block
when `bodyRecentWeeksState.selectedPill?.muscle === muscle`. The
block contains:

- A `COMPLETED · week of <label>` section header (label reuses
  `data.weeks[weekIdx].label` like `5/10`).
- A list of completed-exercise lines, each rendered as a 3-col grid
  (name | sets | contribution).
- A total footer line that matches the pill value (sanity-check the
  user can see the math add up).
- For current week: a `PLANNED REMAINING` section header.
- For current week: a list of planned-exercise lines, same 3-col
  grid layout. The middle column shows "N sets prescribed".

The drilldown panel respects the row-expand's left indent
(`padding-left: 80px` at desktop, `70px` at narrow).

## Row element change: `<button>` → `<div role="button">`

HTML spec disallows interactive children inside `<button>` (browsers
tolerate it but it's invalid). Since pills become `<button>` to get
keyboard accessibility for free, the row's outer `<button>` must
change. Use a non-interactive wrapper with explicit role + tabindex:

```html
<div class="body-rw-row [is-expanded]"
     data-rw-muscle="<muscle>"
     role="button"
     tabindex="0">…</div>
```

Click handler stays the same (`document.getElementById('bodyView').addEventListener('click', …)`).
Add a keydown handler so Enter/Space on the row trigger the same
toggle (native `<button>` did this for free; `<div role="button">`
does not).

The existing `.body-rw-row` CSS already neutralizes browser defaults
(width, background, border, cursor, text-align) — those rules become
mostly no-ops on a `<div>` but harmless. `:focus-visible` still
applies. Net CSS impact: minor.

## CSS

New rules under the existing `.body-rw-*` block in
[index.html](../../../index.html):

```css
button.body-rw-pill { cursor: pointer; border: 0; }
.body-rw-pill.is-selected {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.body-rw-drilldown {
  padding: 8px 0 12px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.body-rw-drill-section-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding-top: 4px;
}
.body-rw-drill-line {
  display: grid;
  grid-template-columns: 1fr auto 60px;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text);
  align-items: baseline;
}
.body-rw-drill-line .secondary-tag {
  color: var(--text2);
  font-size: 10px;
  margin-left: 4px;
}
.body-rw-drill-total {
  border-top: 1px solid var(--border);
  padding-top: 4px;
  margin-top: 2px;
  text-align: right;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text2);
}
```

`<span>.body-rw-pill` (the zero-value, non-interactive variant) stays
non-tappable: the `cursor: pointer` rule is scoped to `button.body-rw-pill`.

## Event handling

Extend the existing `#bodyView` click handler with a `[data-rw-pill]`
branch placed BEFORE the `[data-rw-muscle]` branch (so a pill tap
doesn't also trigger the row-collapse path — `closest` would resolve
both since the pill is inside the row button, but the inner branch
returns early):

```js
var pillBtn = e.target.closest && e.target.closest('[data-rw-pill]');
if (pillBtn) {
  e.stopPropagation();  // prevent the surrounding row's click handler
  var pillMuscle = pillBtn.getAttribute('data-rw-pill-muscle');
  var pillWeek = parseInt(pillBtn.getAttribute('data-rw-pill'), 10);
  if (!pillMuscle || !Number.isFinite(pillWeek)) return;
  var cur = bodyRecentWeeksState.selectedPill;
  var sameAsCur = cur && cur.muscle === pillMuscle && cur.weekIdx === pillWeek;
  if (sameAsCur) {
    bodyRecentWeeksState.selectedPill = null;
  } else {
    bodyRecentWeeksState.selectedPill = { muscle: pillMuscle, weekIdx: pillWeek };
    bodyRecentWeeksState.expandedMuscle = pillMuscle;  // auto-expand row
  }
  renderBodyRecentWeeks();
  return;
}
```

Pills sit INSIDE the row wrapper. `e.stopPropagation()` prevents the
row's click handler from also firing and toggling expand/collapse —
without it, a pill tap would both open and close the row in the same
event.

Add a keydown handler on the row to support Enter/Space:

```js
document.getElementById('bodyView').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var rowEl = e.target.closest && e.target.closest('[data-rw-muscle]');
  if (!rowEl || e.target !== rowEl) return;  // ignore key events on inner buttons
  e.preventDefault();
  rowEl.click();
});
```

## File-by-file changes

1. **[js/data.js](../../../js/data.js):** extend `fetchVolumeTrends`
   to add `byMuscleWeekExercises` to its return shape; add `name` to
   the embedded select.

2. **[js/ui.js](../../../js/ui.js):**
   - Add `selectedPill: null` to `bodyRecentWeeksState`.
   - Change row root from `<button>` to `<div role="button" tabindex="0">`
     in `_bodyRwRowHtml`.
   - Make non-zero pills `<button>` with `data-rw-pill` + `data-rw-pill-muscle`.
   - Extend `_bodyRwExpandHtml` to render the drilldown panel when
     `selectedPill?.muscle === muscle`.
   - New helper `_bodyRwDrilldownHtml(muscle, weekIdx, mode)` returns
     the drilldown HTML — COMPLETED list (always) + PLANNED REMAINING
     (current-week only).
   - New helper `_bodyRwPlannedRemainingForMuscle(muscle, mode)`
     computes planned-remaining exercises from the active plan blob.
   - Click handler: new `[data-rw-pill]` branch; existing
     `[data-rw-muscle]` branch becomes a row-toggle that also clears
     `selectedPill`. Also handle keydown for Enter/Space on the row.
   - Window-toggle branch clears `selectedPill`.

3. **[index.html](../../../index.html):**
   - New CSS for `.body-rw-pill.is-selected`, `.body-rw-drilldown`,
     `.body-rw-drill-section-label`, `.body-rw-drill-line`,
     `.body-rw-drill-total`, `button.body-rw-pill` reset.

4. **[js/app.js](../../../js/app.js):** APP_VERSION bump.

## Non-goals

- No per-set weight/reps/RPE detail. Compact `name + sets + contribution`
  only — set-level history lives in the History modal.
- No drilldown from the avg cell. Pills only.
- No drilldown for the planned-but-not-yet-done current-week pill if
  the pill is zero — zero pills are non-tappable. Edge case: current
  week, nothing done yet, plan has chest exercises today; chest pill
  shows 0 and is non-tappable. The user can still see planned chest in
  the existing "Planned (this week)" section above. (Accepting this
  small UX gap to preserve the "zero pills non-tappable" invariant.)
- No keyboard arrow-navigation across pills. Tab + Enter/Space
  suffice.
- No animation on drilldown open/close.

## Versioning

APP_VERSION bumps to `v3.7.0` (current is `v3.6.34`) — minor bump
marking the Body tab's Recent weeks section reaching its full,
drilldown-capable form. Per the project's version scheme, minor
bumps mark milestone bundles; patches are for follow-ups within a
minor.
