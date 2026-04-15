# BUG-TEST-13 — `handleImport` crash on second plan import

## Root cause

`#emptyState` is declared at [index.html:445](index.html#L445) **as a child of `#workoutContainer`** at [index.html:444](index.html#L444):

```html
<div class="workout-container" id="workoutContainer">
  <div class="empty-state" id="emptyState">…</div>
</div>
```

`buildDay()` renders into the same container via `document.getElementById('workoutContainer').innerHTML = h`, which destroys every descendant — including `#emptyState`.

Lifecycle that leads to the crash:

1. Fresh page load → `#emptyState` is in the DOM.
2. First successful import → `handleImport` hides `#emptyState` (works), then calls `buildDay(0)` → `#workoutContainer.innerHTML` is overwritten → `#emptyState` is removed from the DOM.
3. Second import → `handleImport` calls `document.getElementById('emptyState')` → returns `null` → `.style.display = 'none'` throws `TypeError: Cannot set properties of null`.

The bug is structural, not a rename or a stale reference. The ID still matches; the element has simply been destroyed by prior rendering. It was latent in the pre-Supabase code too — same HTML structure, same `handleImport` sequence — but never surfaced because a two-imports-in-one-session workflow wasn't common.

`hydrate()` has the mirror-image of the same bug:
- [L626](index.html#L626): `emptyState.style.display = 'block'` after a prior render would crash the no-plan path.
- [L636](index.html#L636): `emptyState.style.display = 'none'` after a prior render would crash the with-plan path on a second hydration (e.g. signout → sign-in-as-same-user, though the `hydratedForUser` guard currently masks this).

## DOM-reference audit

### In `handleImport` (lines 1126–1131)

| ID | Defined at | Parent | Clobbered by renderer? | Status |
|---|---|---|---|---|
| `emptyState` | [L445](index.html#L445) | `#workoutContainer` | **Yes, by `buildDay`** | **BUG** |
| `summaryBar` | [L452](index.html#L452) | `<body>` | No | OK |
| `planTitle` | [L430](index.html#L430) | `.header` | No | OK |
| `planWeek` | [L431](index.html#L431) | `.header` | No | OK |
| `importModal` | [L470](index.html#L470) | `<body>` | No | OK |

### In `hydrate()` (lines 624–634)

Same five IDs, same status. `emptyState` references at [L626](index.html#L626) and [L636](index.html#L636) both risk the same null crash. Everything else in this function is safe.

### In `buildTabs` / `buildDay`

| ID | Parent | Status |
|---|---|---|
| `dayTabs` | `.header` | OK |
| `workoutContainer` | `<body>` | OK — this is the container itself, not a child, so `innerHTML` assignment doesn't destroy it |
| `setsComplete`, `setsTotal`, `dayProgress` | `#summaryBar` | OK — `summaryBar` is never replaced |

No other stale or renamed references detected anywhere.

## Remaining `alert()` calls

Seven total, all in `handleImport` / `exportData`. All pre-existed in the pre-Supabase code; the rewrite preserved them rather than converting to `showToast`.

| Line | Function | Message |
|---|---|---|
| [1102](index.html#L1102) | `handleImport` — invalid JSON shape | `'Invalid format'` |
| [1106](index.html#L1106) | `handleImport` — r1 error (un-flag old plan) | `'Import failed: ' + r1.error.message` |
| [1115](index.html#L1115) | `handleImport` — r2 error (insert new plan) | `'Import failed: ' + r2.error.message` |
| [1132](index.html#L1132) | `handleImport` — outer catch | `'Error: ' + err.message` |
| [1139](index.html#L1139) | `exportData` — no active plan | `'No plan loaded'` |
| [1144](index.html#L1144) | `exportData` — workouts query error | `'Export failed: ' + wRes.error.message` |
| [1199](index.html#L1199) | `exportData` — outer catch | `'Export failed: ' + err.message` |

Problems with `alert()` here: blocking modal swallows the call stack in DevTools, not dismissible without interaction, and inconsistent with the toast system we already have for set-level errors.

## Proposed minimal fix for the crash

**Option A (preferred — structural):** move `#emptyState` out of `#workoutContainer` so the renderer can't destroy it. Change:

```html
<div class="workout-container" id="workoutContainer">
  <div class="empty-state" id="emptyState">…</div>
</div>
```

to:

```html
<div class="empty-state" id="emptyState">…</div>
<div class="workout-container" id="workoutContainer"></div>
```

Zero JS changes. Every `getElementById('emptyState')` reference keeps working, including the re-show path (signout → sign-in-as-same-user with no active plan, or deactivating all plans via dashboard). The empty state now survives any number of `buildDay` calls.

**Option B (defensive only):** helper `function setDisplay(id, v) { var el = document.getElementById(id); if (el) el.style.display = v; }`. Prevents the crash but silently fails to re-show the empty state when a user has no active plan after a prior render. Hides the bug instead of fixing it.

**Recommendation:** Option A. One block-level move in the HTML, no JS churn, correct behavior across all lifecycle paths.

## Proposed cleanup for alerts (separate commit)

Convert all seven `alert(msg)` calls to `showToast(msg, retryFn)`:

- Invalid format → `showToast('Invalid plan file format', null)`.
- r1 / r2 / outer catch in `handleImport` → `showToast('Import failed: ' + err.message, function() { /* retry? */ })`. Retry is tricky because the file input has been consumed; safer to pass `null` and have the user re-select the file.
- `exportData` errors → `showToast('Export failed: ' + msg, null)`. Retry would be `exportData()` again, fine to wire up.
- `'No plan loaded'` in `exportData` → `showToast('No plan loaded', null)`.

Also: remove the `alert` monkey-patch from the browser DevTools console once this lands — no longer needed.

## Status

No changes applied to `index.html`. Awaiting approval on Option A for the crash fix and the alert → toast conversion before touching code. These should land as two separate commits.
