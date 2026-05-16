# Body tab: week-aware "Planned" volume (multi-plan / plan-switch)

**Date:** 2026-05-16
**Status:** Approved, building

## Problem

The Body tab's "Planned (active plan, full week)" section sums every
day of the *currently active* plan via `computePlanVolumeByMuscle(plan)`,
ignoring the calendar week and any plan switches. If you do 2 days of a
3-day plan and switch plans, the 2 completed days disappear from the
"planned" target and it just shows the full new plan. The target should
reflect what you actually committed to this week.

## New semantics

For the current Sun–Sat week:

> **Planned (this week)** =
> (a) prescribed volume of every plan-day done this week, each from
>     **its own** plan's prescription (handles mid-week plan switches),
> + (b) actual performed volume of any ad-hoc sessions done this week,
> + (c) prescribed volume of the active plan's days **not** yet done
>     this week.

"Done this week" for a day = a workout exists for it this week with
≥1 completed set (matches the existing week-completion / `perPlan`
semantics in `fetchWeekSummary`). Partial completion still injects that
day's full prescription (per the chosen "plan prescription for
plan-days" rule). Repeats of the same plan-day add up.

Backward-compatible: with no switch and no ad-hoc, done active-plan days
come from bucket (a) and the rest from (c), summing to the same number
as today — now reality-derived rather than coincidental. Ad-hoc uses
actual volume because it has no prescription.

Worked example — 3-day Plan A, did days 1–2, switched to 4-day Plan B,
nothing in B yet: `Planned = A.day1 + A.day2 (A's prescription) +
B.day1..4 (B's prescription)`.

## Algorithm (in `fetchWeekSummary`, `js/data.js`)

`fetchWeekSummary` already loads the week's workouts, prefetches plan
blobs referenced by them (`planCache`), exposes transient `w._planId`,
`w._dayIndex`, `w._planBlob`, and per-workout `w.isAdHoc`,
`w.completedSets`, `w.setsByMuscleGroup`, `w.setsByMuscleGroupPrimary`.
It is the natural home.

In the existing per-workout loop, also build `plannedByMuscle` /
`plannedByMusclePrimary`:

- `w.isAdHoc && w.completedSets > 0` → add `w.setsByMuscleGroup` /
  `…Primary` (actual).
- plan-day, `w.completedSets > 0`, `w._planBlob`, `w._dayIndex != null`
  → accumulate prescribed volume of `w._planBlob.days[w._dayIndex]`
  into planned (fractional + primary). If `w._planId === activePlanId`,
  record `w._dayIndex` in a `doneActiveDays` set.

After the loop, for the active plan (`plan` global when `activePlanId`
set, else `planCache[activePlanId]`): for each day index `d` not in
`doneActiveDays`, accumulate prescribed volume of `plan.days[d]`.

Round planned outputs to 1 decimal (mirrors
`computePlanVolumeByMuscle`). Return two new fields:
`plannedByMuscleGroup`, `plannedByMuscleGroupPrimary`. Existing
`volumeByMuscleGroup*` (actuals) untouched.

### Shared per-day helper

Factor the day/superset walk out of `computePlanVolumeByMuscle` and
`computePlanVolumeByMusclePrimary` into `_accumulatePlanDayFrac(day,
out)` and `_accumulatePlanDayPrimary(day, out)` (each wraps the existing
`_accumulatePlanExercise` / `_accumulatePlanExercisePrimary`,
superset-aware). The two `computePlanVolume*` functions are refactored
to call the per-day helper per day — behavior identical, now reused by
the weekly planned calc. No behavior change for their other callers.

## UI (`renderBodyView`, `js/ui.js`)

- Use `summary.plannedByMuscleGroup` / `…Primary` for the Planned chips
  instead of `computePlanVolumeByMuscle(plan)` /
  `computePlanVolumeByMusclePrimary(plan)`.
- Section label: "Planned (active plan, full week)" → "Planned (this
  week)".
- Add one sentence to the existing collapsible info panel explaining
  the new definition (done plan-days from their own plan + ad-hoc
  actuals + remaining active-plan days).
- Empty state: show Planned whenever there is any completed work this
  week OR an active plan; only show the "no active plan" empty message
  when planned is genuinely empty (no active plan AND nothing done this
  week). The Planned section currently renders inside the
  actuals-bearing async path already (it has the `summary`), so move
  the Planned render to after `fetchWeekSummary` resolves.

## Verification

- `node --check` on changed JS.
- Node sandbox unit test of the new planned accumulation using stub
  workouts + plan blobs: (1) no switch → equals full active plan;
  (2) 2 days of Plan A done + switch to Plan B → A.day1+A.day2 +
  full B; (3) ad-hoc this week adds its actual volume; (4) active-plan
  day done is not double-counted.
- Manual browser pass: a clean week (Planned == full active plan), and
  a plan-switch week.

## Scope

`js/data.js` (`fetchWeekSummary` + factored per-day helpers; the two
`computePlanVolume*` reuse them) and `js/ui.js` (`renderBodyView`
consumes new fields, label, info text, empty-state ordering). No schema
changes. `APP_VERSION` patch bump; commit, do not push without
approval.
