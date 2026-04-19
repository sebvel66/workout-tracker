# Gym Profiles — Design

**Status:** Approved by user 2026-04-19 (pre-implementation).
**Scope:** Third of three sequenced features (hamburger menu → session notes → gym profiles). This spec covers only gym profiles.

## Why

Resistance machine weights don't translate consistently across gyms. "120 lbs on the cable row at Gym A" is materially different from 120 lbs at Gym B — different pulley geometry, different cable friction, different weight stacks. Logging history without a location tag makes progression tracking and AI-driven plan generation noisier than it has to be.

Tagging workouts with a user-defined gym closes that gap: the v2 AI planner can condition weight progressions on location, and the user can read their own history with gym context inline ("my cable row is 120×10 at Gym A, 135×8 at Gym B — not a plateau, just different equipment").

Future-compatible with per-location equipment profiles (what's available at each gym, which feeds the AI's exercise selection) — but equipment is out of scope for this spec.

## Design

### 1. Schema

New migration `supabase/migrations/20260419000000_locations.sql`:

```sql
create table locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- Case-insensitive name uniqueness per user. Prevents "Gym A" / "gym a"
-- duplicates without collapsing legitimate distinct names like
-- "Planet Fitness Downtown" vs "Planet Fitness Uptown".
create unique index locations_user_name_ci_unique
  on locations (user_id, lower(name));

-- Recency ordering on the management modal and recent-first dropdown.
create index on locations (user_id, created_at desc);

alter table locations enable row level security;
create policy "own_locations" on locations for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tag workouts with a location. SET NULL on delete preserves historical
-- set data when a gym is removed (user loses the tag, not their workouts).
alter table workouts
  add column location_id uuid references locations(id) on delete set null;
create index on workouts (user_id, location_id);
```

### 2. Hamburger menu addition

A new "Gym Profiles" row in the existing hamburger menu (`#menuOverlay`), placed between "History" and "Sign Out". Reuses the `.menu-row` pattern and the close→open sequencing already used by the other rows.

### 3. Gym Profiles management modal

New bottom-sheet modal following the `.menu-modal` / `.history-modal` / `.picker-modal` visual pattern already established (`slideUp 0.3s`, 20px top radius, `max-width: 500px`, safe-area padding-bottom). Structure top-down:

- **Header:** "Gym Profiles" title + ✕ close button. Mirrors the existing modal headers.
- **Add row:** a single `<input type="text" placeholder="New gym name">` + an "Add" button. Submit → case-insensitively dedup-check → insert → clear input → prepend to list. Input enforces a soft 60-character cap via `maxlength` (UI affordance only; DB is `text`).
- **Gym list:** one row per location, sorted by `created_at desc`. Each row shows the name and a small ✕ delete button on the right. Tap the name → the name is replaced inline with a text input scoped to that row; blur or Enter saves; Escape cancels. No separate edit modal.
- **Empty state** (zero gyms): the list area shows *"No gyms yet. Add one above to start tagging workouts."*

Client state: the full `locations` array is kept in memory (`window.locations`), loaded once per hydrate. Mutations update the array in place and trigger a re-render.

**Delete confirmation:** standard `confirm()` dialog with a workout-count hint: *"Delete 'Gym A'? N workouts will lose their gym tag."* N is computed from the already-hydrated `todayPlanStates` / `todayAdHocs` / `historicalCache` in-memory state, plus a `SELECT count(*)` against `workouts WHERE location_id = $1` for rows not yet cached client-side. The count is advisory; the FK's `ON DELETE SET NULL` handles the actual data clean-up server-side.

### 4. Session-view dropdown (placement B)

Rendered in `buildDay` and `buildAdHocDay` between the session-bar block and the `renderSessionNotes` call. Vertical order becomes: session-bar → location → session-notes → exercise-cards.

**Editable state:**

```html
<div class="session-location" data-di="<di>">
  <label class="session-location-label">Location</label>
  <select class="session-location-select" data-di="<di>">
    <option value="">— No gym</option>
    <option value="<uuid>">Gym A</option>
    ...
  </select>
</div>
```

Options are sorted so the last-used location (computed once per hydrate, see §7) appears at the top after `— No gym`, followed by the rest in `created_at desc`. The selected value reflects `state.locationId` (hydrated from `row.location_id` in `stateFromWorkout`).

**Read-only state** (`mode === 'historical'` for plan-day, or any completed ad-hoc we ever expose for historical read): the same `<select>` rendered with `disabled`. Shows the stored `location_id` value.

**Default selection resolution (on render):**
1. If `state.locationId` is non-null (hydrated from an existing `workouts.location_id`), use it.
2. Else if `state.pendingLocationId !== undefined`, use it. (Initialized to `recentLocationId` by `getOrInitToday` on fresh state; an explicit user pick of `— No gym` stores `null`, which is distinct from `undefined` and wins over `recentLocationId`.)
3. Else fall back to `recentLocationId`.

**Change handler:** on `change` event, `persistWorkoutLocation(di, locationId)` runs (`locationId` is `null` when `— No gym` is selected, a UUID otherwise). Logic:

- If `state.workoutId` exists: `UPDATE workouts SET location_id = $1 WHERE id = $2`. Updates `state.locationId` on success.
- If `workoutId` doesn't exist yet (plan-day, no sets logged, no notes): stash `state.pendingLocationId = locationId`. The next `ensureWorkout(di)` reads `state.pendingLocationId` (or falls back to `recentLocationId` if `pendingLocationId === undefined`), includes it on the INSERT, then sets `state.locationId` from the returned row and clears `pendingLocationId`.

This lets a user pick a gym *before* starting a workout — the pending value rides along on the first lazy-create. Matches the same pattern session-notes uses for lazy workout creation. An explicit `— No gym` pick sticks as `null`, distinct from "user hasn't touched it, use recent."

### 5. Zero-gym prompt (option B)

When `locations.length === 0`, the session-view dropdown slot renders a single prompt instead of a `<select>`:

```html
<button class="session-location-prompt" type="button">+ Add a gym to tag workouts</button>
```

Tapping it opens the Gym Profiles modal. After the user adds their first gym and closes the modal, the next `buildDay`/`buildAdHocDay` re-render replaces the prompt with the real dropdown defaulting to that gym.

### 6. Read surfaces (option A — all four)

**6a. Historical day-picker view** (`buildDay` with `mode === 'historical'`). Same dropdown slot as the editable view, `disabled`. Value = workout's `location_id`.

**6b. History browser list** (`renderHistoryList` around [index.html:2938](index.html#L2938)). Each row with a non-null `location_id` gets a small `<span class="history-row-gym">Gym A</span>` inserted into the existing meta line (next to the date / set-count / duration). No badge when `location_id` is null. Location name resolved from `locationById[row.location_id]`.

**6c. History browser detail modal** (`renderHistoryDetail` around [index.html:3040](index.html#L3040)). Location name appended to the metadata line that already shows date + "ad-hoc" tag. Resolved via `locationById`.

**6d. View Recent per-exercise modal** (`openExerciseHistory` around [index.html:2630](index.html#L2630)). Each session's header row in the modal currently shows `<date> · <context>`. We append ` · <gym>` when the workout has a `location_id`. Killer surface for the weight-context use case — two hundred cable-row sets across two gyms now visually distinguishable.

For all read surfaces: missing-from-cache resolution returns no badge (the row renders without the gym tag, rather than showing a dangling UUID or "unknown"). The FK is `SET NULL`, so the only way to see a dangling id is a stale client cache.

### 7. Persistence mechanics

**Hydrate** (inside `hydrate()` at [index.html:1476](index.html#L1476)):

- Call `loadLocations()` right after `loadExerciseLibrary` + `loadRecentExercises`. Populates `locations` (array) and `locationById` (map).
- Compute `recentLocationId` by finding the most recent workout row (across the hydrated `todayPlanStates` / `todayAdHocs` / `historicalCache` and a `SELECT location_id FROM workouts WHERE user_id = $1 AND location_id IS NOT NULL ORDER BY performed_at DESC LIMIT 1` fallback). This is the default selection for new sessions.

**Write paths:**

- `persistLocationAdd(name)` → `insert` into `locations`, prepend to array, return new row. Case-insensitive dupe check: if `locations` already contains `name.toLowerCase()`, show a toast and no-op.
- `persistLocationRename(id, newName)` → `update ... where id = $1`. Update the in-memory row.
- `persistLocationDelete(id)` → `delete ... where id = $1`. Remove from array + map. `ON DELETE SET NULL` handles the `workouts` side server-side; also clear any stale `state.locationId` references on the next re-render (cheap: re-render reads from the array, which doesn't have the deleted row).
- `persistWorkoutLocation(di, locationId)` → see §4 change handler. Dirty-check (no-op if value equals current `state.locationId`).

All writes use the existing `showToast(msg, retryFn)` pattern on failure.

**State fields added to each workout state object:**

- `state.locationId` — from `row.location_id`.
- `state.pendingLocationId` — transient, used by `ensureWorkout` to carry a pre-workout location pick into the INSERT.

**Shape changes to existing helpers:**

- `stateFromWorkout`: populate `state.locationId = row.location_id || null`. `pendingLocationId` is left undefined (reading §4, `undefined` is the "user hasn't touched it" sentinel distinct from `null` = "explicitly no gym").
- `ensureWorkout`: on INSERT, compute `effectiveLocationId = state.pendingLocationId !== undefined ? state.pendingLocationId : recentLocationId`. Include on the INSERT. After success, set `state.locationId = res.data.location_id` and delete `state.pendingLocationId`.
- `getOrInitToday`: initialize `locationId: null` on the freshly-created state object. Do **not** initialize `pendingLocationId` — leaving it `undefined` preserves the "user hasn't touched it" sentinel.
- `createAdHocSession`: include `recentLocationId` on the INSERT and set `locationId` on the ad-hoc state object.

### 8. Visual treatment

- **Dropdown slot:** same horizontal margin as exercise cards (`margin: 10px 14px`). Label + select on one row. Label uses the mono-caps style (`var(--text2)`, `font-size: 11px`, `font-family: 'JetBrains Mono'`, `text-transform: uppercase`) matching the rest of the app's meta labels. `<select>` inherits the day-picker's native styling for consistency (`.day-picker` CSS already handles the native-appearance kill + chevron).
- **Prompt row (zero gyms):** same container, rendered as a dashed-border button to read as a call-to-action. Similar to the existing `.history-load-more` pattern.
- **Gym Profiles modal list:** each row mimics `.menu-row` but with an inline text display, a tappable edit-in-place area, and a small ✕ on the right. CSS reuses `.menu-row:active` background for visual consistency across the hamburger menu cluster.
- **History read badges:** tiny dim text (`.history-row-gym` — `var(--text3)`, `font-size: 11px`) inserted into existing meta lines. No color, no pill, no chip — restraint matches the app's minimal palette.

## Scope boundary

**New code surface in `index.html`:**
- CSS: `.session-location`, `.session-location-label`, `.session-location-select`, `.session-location-prompt`, `.gym-profiles-modal`, `.gym-profiles-add`, `.gym-profiles-row`, `.gym-profiles-row-name`, `.gym-profiles-row-input`, `.gym-profiles-row-delete`, `.history-row-gym`.
- State: `locations`, `locationById`, `recentLocationId` top-level variables; per-state `locationId` + `pendingLocationId` fields.
- Functions: `loadLocations`, `persistLocationAdd`, `persistLocationRename`, `persistLocationDelete`, `persistWorkoutLocation`, `renderSessionLocation(di, state, readOnly)`, `openGymProfiles`, `closeGymProfiles`, `renderGymProfiles`.
- HTML: a new `<div class="modal-overlay" id="gymProfilesOverlay">` and a new menu row in `#menuOverlay`.
- Event wiring: menu row handler; modal overlay-close / close-button handler; add-form submit handler; list row click delegate (rename-in-place, delete); change-event handler for `.session-location-select`; click handler for `.session-location-prompt`.

**New migration:** `supabase/migrations/20260419000000_locations.sql`.

**Bump `APP_VERSION` to `v2.0.13`.**

## Out of scope

- Per-location equipment profiles (future AI-planner feature).
- Per-exercise location overrides.
- Auto-detect via geolocation.
- Merge-on-delete flow (just `SET NULL` the FK, user re-tags if they want to).
- Per-gym notes or metadata beyond the name.
- Renaming a gym retroactively affects its display name everywhere (via `locationById` lookups), but no audit trail / rename history.

## Risks & mitigations

- **Risk:** the CI-unique index on `lower(name)` doesn't tolerate existing duplicates on first migration. Mitigation: no existing data (new column); migration runs on an empty `locations` table. No conflict possible.
- **Risk:** `pendingLocationId` gets orphaned if the user picks a gym on a plan-day, never logs a set or note, and navigates away. Mitigation: the field is transient in-memory only; page reload discards it. Acceptable.
- **Risk:** `recentLocationId` defaults a user into a gym they're not actually at today. Mitigation: the dropdown is always editable (user can change mid-session); `— No gym` option lets them explicitly opt out. Also: on a fresh hydrate with zero historical location_ids, `recentLocationId` is `null` → dropdown defaults to `— No gym`.
- **Risk:** Gym Profiles modal concurrent edit (rename a row mid-session, the session dropdown doesn't re-render to pick up the new name). Mitigation: on `closeGymProfiles`, trigger a `buildDay(currentDay)` re-render to refresh any visible selects/badges.
- **Risk:** `renderHistoryList` renders before the first history page hydrates `locationById`. Mitigation: `loadLocations` runs during hydrate (before any history-browser interaction). If a race still slips through, missing-from-cache renders without the badge — no crash, no dangling UUID.

## Verification

After implementation:

- **Migration applied:** `locations` table exists in Supabase, RLS policy in place, `workouts.location_id` column added. Verified via Supabase dashboard.
- **Hamburger menu:** ☰ → menu shows a new "Gym Profiles" row between History and Sign Out. Tapping it closes the menu and opens the Gym Profiles modal.
- **Gym Profiles modal:**
  - Zero-gym state shows "No gyms yet..." in the list area.
  - Add a gym → appears at the top of the list; the session-view prompt swaps to the real dropdown on next re-render.
  - Rename a gym (tap name → edit → blur to save) → updates everywhere (dropdown, history views).
  - Delete a gym with confirmation dialog showing workout count; past workouts lose the tag but retain sets (check in Supabase Table Editor).
  - Case-insensitive dedup: adding "gym a" while "Gym A" exists shows a toast and no-ops.
- **Session view dropdown:**
  - Appears between the session bar and the session-notes row in both plan-day and ad-hoc views.
  - Default selection = most-recently-used gym (or `— No gym` if none).
  - Changing selection on a session with an existing workout row → `workouts.location_id` updated (verify in DB).
  - Changing selection on a plan-day before any set is logged → `pendingLocationId` stashed; next set-done or notes-blur creates the workout with that `location_id` set.
- **Historical day-picker view:** same dropdown, disabled, shows the workout's tagged gym.
- **History browser list:** rows with a `location_id` show a small dim gym-name badge inline with the meta line.
- **History browser detail modal:** gym name appears in the metadata line.
- **View Recent modal:** each session's header line shows `<date> · <context> · <gym>` when a `location_id` is present.
- **`APP_VERSION` bumped to `v2.0.13`.**
