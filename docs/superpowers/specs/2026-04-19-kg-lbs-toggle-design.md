# Kg / Lbs Weight Unit Toggle — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** Let the user switch weight display + input between lbs and kg via a single hamburger-menu toggle. All stored set weights remain canonically lbs; conversion happens only at the display / input boundary. Follow-up item from ROADMAP.md → "UX improvements → Lbs / kg unit toggle (near-term — international travel)".

## Why

The app currently treats every weight value as lbs, implicitly. Input labels read `LBS`; placeholder values rendered from the plan JSON assume lbs; the stored `sets.weight` column is interpreted as lbs everywhere downstream. This is fine for US training but load-bearing when the user logs in European gyms where plates are labeled in kg — converting mentally at every rack adds friction and introduces entry errors.

The near-term driver is an upcoming Europe trip. The fix ships before the trip: one hamburger item flips display + input between units; all existing history stays intact.

## Design

### Canonical storage

`sets.weight` remains lbs, full-precision. No migration, no per-set unit column, no schema change. On input in kg mode, the client converts to lbs (rounded to 2 decimal places) before persisting. On read in kg mode, the client converts lbs → kg for display. The round-trip through `sets` stays numerically stable because every value is rounded once on the way in.

**Rejected alternatives:**
- Per-set unit column (`sets.weight_unit`) — requires a migration, forces every analytics query to become unit-aware, complicates the `prescribed_weight` vs `weight` comparison, and gains nothing the canonical-lbs approach can't replicate visually.
- Session-level unit hint on `workouts` — over-engineered; no real use case for "remember the session was logged in kg" that isn't already covered by displaying all current values in the user's current preference.

### Conversion constants + helpers

All in `js/data.js`:

```javascript
var LBS_PER_KG = 2.20462;

function getWeightUnit() {
  var v = localStorage.getItem('weightUnit');
  return v === 'kg' ? 'kg' : 'lbs';
}

function setWeightUnit(unit) {
  localStorage.setItem('weightUnit', unit === 'kg' ? 'kg' : 'lbs');
}

function lbsToKg(lbs) {
  if (lbs == null) return null;
  return Math.round((lbs / LBS_PER_KG) * 10) / 10;  // 1dp
}

function kgToLbs(kg) {
  if (kg == null) return null;
  return Math.round(kg * LBS_PER_KG * 100) / 100;  // 2dp
}

function displayWeight(lbsValue, unit) {
  if (lbsValue == null || lbsValue === '') return '';
  if (unit === 'kg') {
    var kg = lbsToKg(lbsValue);
    return kg.toFixed(1);
  }
  // lbs: up to 2dp, trailing zeros stripped.
  var n = Math.round(lbsValue * 100) / 100;
  return (n === Math.floor(n)) ? String(Math.floor(n))
       : String(n).replace(/\.?0+$/, '');
}

function parseWeightInput(rawStr, unit) {
  if (rawStr === '' || rawStr == null) return null;
  var parsed = parseFloat(rawStr);
  if (isNaN(parsed)) return null;
  if (unit === 'kg') return kgToLbs(parsed);
  return Math.round(parsed * 100) / 100;
}

function normalizePrescribedLbs(prescribedSet) {
  if (!prescribedSet || prescribedSet.weight == null) return null;
  if (prescribedSet.unit === 'kg') return kgToLbs(prescribedSet.weight);
  return prescribedSet.weight;  // lbs or unspecified → assume lbs
}
```

These are pure utilities plus two localStorage accessors. No side effects beyond `setWeightUnit` writing the key.

### Preference location

`localStorage['weightUnit']` only. Device-local; no DB, no RLS, no migration, no cross-device sync. The Europe-trip use case is one-primary-device (phone). If cross-device sync becomes annoying later, a one-shot migration to a `user_settings` table is small — none of the stored set data needs to change.

Default when the key is absent: `'lbs'`.

### UI — hamburger toggle

A new `<button class="menu-row" id="menuWeightUnit">` inserted into the hamburger menu between "Gym Profiles" and "Sign Out". Label is dynamically suffixed with the current unit: `"Weight unit (lbs)"` or `"Weight unit (kg)"`. The row's text is recomputed on every `openMenu()` call so it always reflects the current preference.

Tap handler:

1. `setWeightUnit(getWeightUnit() === 'lbs' ? 'kg' : 'lbs')`.
2. `closeMenu()`.
3. `buildDay(currentDay)` to re-render the session view in the new unit.

No confirmation dialog, no modal. Toggle is available in every state (fresh, mid-workout, post-completion, ad-hoc, historical). Stored weights don't mutate — they just display differently.

### UI — per-row rendering

**Input label (`renderSetRow` at [js/ui.js:60-89](../../js/ui.js)):**

- Today: `var lbl = weightMode === 'bodyweight' ? 'ADD WT' : 'LBS';`
- New: `var lbl = weightMode === 'bodyweight' ? 'ADD WT' : (getWeightUnit() === 'kg' ? 'KG' : 'LBS');`

Bodyweight mode keeps `ADD WT` regardless of unit (the semantic is "additional weight on top of bodyweight"); the actual number is still converted.

**Input `value`:**

- Today: `value="' + (sl.weight != null ? sl.weight : '') + '"`
- New: `value="' + displayWeight(sl.weight, getWeightUnit()) + '"`

**Placeholder (prescribed hint):**

- Today: `weightPlaceholder = prescribedSet && prescribedSet.weight ? prescribedSet.weight : '—';`
- New: `var lbsP = normalizePrescribedLbs(prescribedSet); weightPlaceholder = lbsP != null ? displayWeight(lbsP, getWeightUnit()) : '—';`

**On input-change (event delegate in `js/ui.js` around line 1805+):**

- Today: `logSet(di, ei, si, 'weight', val)` where `val` is the raw string; `logSet` does `parseFloat(val)` internally.
- New: the input-change branch for `data-field="weight"` calls `parseWeightInput(val, getWeightUnit())` first, passes the resulting lbs number to `logSet`. Reps and RPE paths are unchanged.

### UI — secondary surfaces

**`fmtP` (prescription formatter, `js/ui.js:91-99`):**

- Today: `if (s.weight) p.push(s.weight + (s.unit || 'lbs'));`
- New: `var lbsP = normalizePrescribedLbs(s); if (lbsP != null) p.push(displayWeight(lbsP, getWeightUnit()) + getWeightUnit());`

**History modal (list + detail):**
All weight displays flow through `displayWeight(lbs, getWeightUnit())` with the unit suffix appended.

**View Recent modal (`openExerciseHistory`):**
Set strings currently build as `w + ' × ' + r` where `w = s.weight`. Becomes `displayWeight(s.weight, unit) + ' × ' + r`. No unit suffix on individual set strings — the user knows their current preference, and appending `lbs` / `kg` to every row in a `"0 × 12 · 0 × 12 · 0 × 7"` pattern adds visual noise without disambiguating. The session header row stays as-is.

**Session-complete summary, any other weight readout:**
Audit every `sl.weight` / `s.weight` direct read in `js/ui.js` and route through `displayWeight`.

**Export (CSV / JSON):**
Stays in lbs. Out of scope for this spec — a unit selector on export can come later if needed.

### Edge cases

- **Toggle mid-session with typed-but-not-done values:** In-memory `sl.weight` already holds lbs (the input handler converts on change). Re-render reads lbs → converts to new display unit. Works without special handling.
- **Plan prescribed in kg (rare, but legal per the plan JSON shape):** `normalizePrescribedLbs` handles the `unit: 'kg'` branch. Plans that omit `unit` or use `'lbs'` take the canonical lbs branch. No plan-import step needed — conversion happens at read time.
- **Bodyweight exercises:** `weight_mode === 'bodyweight'` → the input is for added weight (weighted pull-ups, weighted dips). Label stays `ADD WT`; the number is still converted. Users won't see "kg" alongside a bodyweight exercise, but the added-weight value converts cleanly.
- **`weight_mode === 'none'`:** No weight input rendered; toggle has no effect on these cards. No change needed.
- **Existing Fitbod Import history (all stored in lbs):** Renders correctly in either unit automatically. No data migration.
- **Round-trip drift:** User enters `40` in kg → stored `88.18` → displays `40.0 kg` / `88.18 lbs`. Second-toggle back to kg rounds to 1dp: `40.0`. No further drift on subsequent toggles because storage is fixed.

## Manual smoke test checklist

### Toggle behavior
- [ ] Hamburger menu shows "Weight unit (lbs)" by default.
- [ ] Tap it → hamburger closes, all visible weights re-render; input labels show `KG`; placeholders show kg values.
- [ ] Re-open hamburger → row now reads "Weight unit (kg)".
- [ ] Tap again → flips back to lbs; everything re-renders.

### Input + persistence
- [ ] In kg mode, enter `40` in a weight field, tap Done → persists. DB row's `weight` is approximately `88.18`. Reload → still displays `40.0 kg`.
- [ ] In kg mode, enter a decimal (e.g., `42.5`) → persists as `~93.7`. Reload → displays `42.5 kg`.
- [ ] Toggle to lbs → the same set displays as `88.18 lbs` / `93.71 lbs`. Toggle back to kg → `40.0` / `42.5` (no further drift).

### Placeholders
- [ ] A prescribed set with `weight: 90, unit: 'lbs'` (or no `unit`) in kg mode → placeholder shows `40.8`.
- [ ] Plan-JSON with an explicit `unit: 'kg'` prescribed set → placeholder shows `40.0` in kg mode, `88.18` in lbs mode.

### Secondary surfaces
- [ ] `fmtP` prescribed-text in each set row shows the current unit suffix.
- [ ] History modal list rows show weights in the current unit with suffix.
- [ ] History modal detail view: same.
- [ ] View Recent per-exercise modal: set strings render with the current unit.
- [ ] Session-complete summary: weight displays in the current unit.

### Edge cases
- [ ] Bodyweight exercise (weighted pull-up) in kg mode: input label is `ADD WT` (unchanged); value converts cleanly.
- [ ] No-weight exercise (`weight_mode: 'none'`): no weight input rendered. Toggle has no visible effect on the card.
- [ ] Toggle during a mid-session workout with typed-but-not-done weights: display re-renders to the new unit, no data loss.
- [ ] Historical Fitbod Import session → weights display correctly in either unit.

### Regressions
- [ ] RPE buttons still fan out across all sets of an exercise.
- [ ] Exercise-level note / substitution still save on blur.
- [ ] "+ Add set" / "+ Add exercise" flows unchanged; new sets inherit current display unit.
- [ ] Export (CSV/JSON) still in lbs (unchanged; out of scope).

## Implementation surface summary

- **[js/data.js](../../js/data.js)** — add `LBS_PER_KG`, `getWeightUnit`, `setWeightUnit`, `lbsToKg`, `kgToLbs`, `displayWeight`, `parseWeightInput`, `normalizePrescribedLbs`.
- **[js/ui.js](../../js/ui.js)** — `renderSetRow` uses `displayWeight` + unit-aware label; `fmtP` uses `displayWeight` + unit suffix; weight-input change handler calls `parseWeightInput` before state; history and View Recent modals use `displayWeight`; new hamburger item tap handler.
- **[index.html](../../index.html)** — new `<button class="menu-row" id="menuWeightUnit">` between Gym Profiles and Sign Out; no new CSS.
- **No SQL migration. No new Supabase table. No RLS changes.**

## Non-goals

- Cross-device unit preference sync (localStorage is device-local by design for this iteration).
- Plate-math calculator / plate visualization.
- Unit selector on the export modal.
- Mixed-unit sessions (all inputs follow the currently-selected unit).
- Migrating plan JSON to store prescribed values in both units.
- Any change to how `prescribed_weight` is stored in `sets` rows (still canonical lbs).
