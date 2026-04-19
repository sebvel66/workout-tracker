# Architecture

Map of the repo as a reference for future sessions. The authoritative state of *what's shipped* and *why specific decisions were made* lives in `HANDOFF.md`, `DECISIONS.md`, and `ROADMAP.md`; this doc is about *how the code is organized* and *where to find things*.

Start here if you're picking up the project fresh.

## At a glance

Mobile-first PWA for workout tracking. Single HTML page, plain JavaScript (no build step, no bundler, no framework), Supabase for persistence + auth. Five JS modules under `js/`, loaded as plain `<script src>` tags in dependency order. CSS lives inline in `index.html`. Verification is manual browser testing — there is no automated test suite.

## Repo layout

```
/
├── index.html                       # HTML + inline CSS + <script src> tags. No JS.
├── js/
│   ├── resolver.js                  # Exercise name resolution (no deps)
│   ├── data.js                      # Supabase client, state, queries, mutations
│   ├── ui.js                        # Renderers, modals, event listeners, timers
│   ├── auth.js                      # OTP sign-in, applySession
│   └── app.js                       # APP_VERSION, paintVersion, hydrate, auth wiring
├── supabase/
│   └── migrations/                  # Forward-only Supabase SQL, timestamp-prefixed
├── docs/
│   └── superpowers/
│       ├── specs/                   # Design specs, dated per-feature
│       └── plans/                   # Implementation plans, dated per-feature
├── HANDOFF.md                       # Current-state pickup doc; version + open items
├── DECISIONS.md                     # Running log of architecture/behavior decisions
├── ROADMAP.md                       # Forward-looking scope (v2 AI planner, etc.)
├── ARCHITECTURE.md                  # This file
└── BUG-TEST-13.md                   # One outstanding latent bug (emptyState crash)
```

`index.html` is only HTML+CSS+script tags — no inline JavaScript. If you're adding logic, it goes in one of the `js/*.js` files per the split below.

## Database schema (high level)

Defined in `supabase/migrations/`. Tables:

| Table | Purpose |
|---|---|
| `plans` | Imported plan JSON (`data jsonb`). One `is_active = true` per user via partial unique index. |
| `exercises` | Seed library (`user_id IS NULL`) + user-custom rows. Case-insensitive name uniqueness per user for customs. |
| `workouts` | One per session. `plan_id` null = ad-hoc. Nullable `location_id` FK. `performed_on date` + partial unique index on `(user_id, plan_id, day_index, performed_on)` for dedup. `paused_ms bigint` for pause/resume. `notes text` for session-level notes. |
| `sets` | One per set. Per-set RPE, prescribed vs actual columns, `started_at` / `completed_at`, `CHECK (done = false or completed_at is not null)`. |
| `locations` | User-defined gym names. Case-insensitive unique per user. |

RLS on every table: `auth.uid() = user_id` (exercises has a split policy for seed reads). FK deletes are either `CASCADE` (sets on workout delete) or `SET NULL` (`workouts.location_id` on gym delete).

See `DECISIONS.md` for why each schema choice was made (partial unique index semantics, `paused_ms` offset, `completed_at` immutability, case-insensitive name uniqueness, etc.).

## JS module layout

Total ~3,100 lines split across 5 files. Rough sizes:

| File | ~Lines | What lives here |
|---|---|---|
| `resolver.js` | 68 | `normName`, `EXERCISE_ALIASES`, `resolveLibraryRow`. Pure string/lookup utility. |
| `data.js` | 1080 | Supabase client (`sb`), cross-cutting state, queries, persistence, session lifecycle, import. |
| `ui.js` | 1710 | Renderers, modals, event listeners, toast, session/rest timers, export. |
| `auth.js` | 155 | OTP form state + handlers, `applySession` (sign-in → cache reset → hydrate). |
| `app.js` | 117 | `APP_VERSION`, `paintVersion` IIFE, `hydrate`, `sb.auth.getSession` + `onAuthStateChange`. |

### Load order and why

```
resolver.js  →  data.js  →  ui.js  →  auth.js  →  app.js
```

- **`resolver.js`** first — no runtime dependencies.
- **`data.js`** next — creates `sb` and declares the state globals every later file reads. Putting `sb` here (rather than in `app.js`) avoids load-order gymnastics for `ui.js` and `auth.js`.
- **`ui.js`** third — defines renderers + attaches DOM event listeners. Listeners reference data-layer functions, resolved at click-time (after everything is loaded).
- **`auth.js`** fourth — owns `userId` and `hydratedForUser`, defines `applySession` which the next file wires to Supabase auth events.
- **`app.js`** last — declares `APP_VERSION`, paints the version footer, defines `hydrate`, and calls `sb.auth.getSession().then(applySession)` + `onAuthStateChange(applySession)`. `hydrate` references functions from every other file, but it's only invoked after all files have loaded.

The Supabase client library itself loads from CDN via `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>` in the `<head>`, so `window.supabase` is available before any `js/*.js` runs.

### Why plain scripts, not ES modules

The refactor deliberately uses `<script src>` tags with global vars rather than `<script type="module">` with `import`/`export`. Reasons:
1. The split was "move code, don't change logic." ES modules would have required rewriting every cross-file call to use `import`.
2. ES modules are deferred and strict-mode. Changes the timing of event-listener attachment and a few other subtleties.
3. The file loads fine over plain HTTP from any static host; no CORS requirement.

If the app later grows enough to warrant a build step, ES modules are the natural next step — but YAGNI until then.

## State ownership

Every top-level `var` is declared in exactly one file. Cross-file reads are via implicit globals (because plain-script declarations end up on `window`).

| Variable | Owner | Notes |
|---|---|---|
| `APP_VERSION` | app.js | Bumped every visible change. |
| `SUPABASE_URL` / `_ANON_KEY` / `sb` | data.js | Anon key is public by design (RLS-guarded). |
| `userId` | auth.js | Set in `hydrate`; `null` when signed out. |
| `hydratedForUser` | auth.js | Prevents double-hydration on the same session. |
| `activePlanId`, `plan`, `currentDay` | data.js | Active plan metadata + focused-tab key. |
| `sessionTodayStart` | data.js | Snapshot of local-midnight at hydrate time. |
| `todayPlanStates` | data.js | `{ [dayIndex]: state }` for plan-day workouts today. |
| `todayAdHocs` | data.js | Array of ad-hoc session states. |
| `todayState` | data.js | Pointer to whichever state is focused. |
| `historicalCache` | data.js | `{ [dayIndex]: state }` for prior plan-day workouts. |
| `planCache` | data.js | `{ [planId]: planBlob }` — current + pinned historical plans. |
| `exerciseIdCache` | data.js | `normName → uuid`. |
| `exerciseLibrary*` | data.js | Array + by-name + by-id maps of exercise rows. |
| `recentExercises` | data.js | Up to 10 most-recently-logged, for picker top. |
| `locations`, `locationById`, `recentLocationId` | data.js | Gym profiles + hydrate-computed default. |
| `restInterval`, `restTargetMs`, `restCompleted`, `restAudioCtx` | ui.js | Wall-clock rest timer state. |
| `sessionTimerInterval` | ui.js | Session-timer re-render interval. |
| `pickerState` | ui.js | Search + filter state for the exercise picker. |
| `historyWorkouts`, `historyDetails`, `historyLoading`, `historyFullyLoaded`, `historyView`, `historyPageSize` | ui.js | History-browser modal state. |
| `toastCounter` | ui.js | Monotonic id generator for toasts. |
| `EQUIPMENT_OPTIONS`, `MUSCLE_OPTIONS` | ui.js | Picker filter chip constants. |
| `EXERCISE_ALIASES` | resolver.js | Plan-name → canonical seed-name mapping. |
| `authForm`, `authEmail`, ..., `authStep`, `authPendingEmail` | auth.js | Sign-in form DOM refs + form-stage state. |

## Cross-module contract (function-level)

Who calls what across module boundaries. Useful when you're editing one file and wondering what else might break.

**resolver.js is called by:**
- `data.js` → `ensureExerciseId` (routes plan names through the resolver)
- `ui.js` → `openExerciseHistory` (resolves the display name to a library row for the query)

Plus `data.js` uses `normName` in several mutation paths. Nothing calls into `resolver.js` from `auth.js` or `app.js`.

**data.js is called by:**
- `ui.js` — heavily. Every event handler that logs / mutates / navigates calls something here (`persistSet`, `toggleSet`, `logSet`, `logRPE`, `logNote`, `logSub`, `persistNotes`, `persistWorkoutLocation`, `deleteSet`, `deleteExerciseCard`, `createAdHocSession`, `deleteAdHocSession`, `handleImport`, `startSession`, `completeSession`, `resumeSession`, `focusTab`, `loadHistorical`, `viewModeFor`, `stateForDay`, `sessionElapsedMs`, `loadLocations`, `persistLocation*`, `buildSetPayload`, `ensureWorkout`, `ensureExerciseId`, etc.).
- `auth.js` → `applySession` clears most of the data-layer state.
- `app.js` → `hydrate` pulls in a batch of loads (`loadExerciseLibrary`, `loadRecentExercises`, `loadLocations`).

**ui.js is called by:**
- `data.js` — for user feedback and re-rendering after mutations. Key targets: `showToast`, `buildDay`, `buildTabs`, `startTimerTick`, `stopTimerTick`, `startRestTimer`, `invalidateHistoryCache`, `renderGymProfiles`.
- `auth.js` → `applySession` calls `stopTimerTick` and resets several UI-owned state arrays.
- `app.js` → `hydrate` calls UI renderers at the end.

**auth.js is called by:**
- `app.js` → `applySession` is the target of the two `sb.auth` handlers.

**app.js is called by:**
- `auth.js` → `applySession` calls `hydrate`.

Net shape: the hottest boundary is `ui.js ↔ data.js`. `auth.js` and `app.js` are thin glue layers.

## UI patterns & conventions

Patterns established through earlier features. Reuse these when adding new UI rather than inventing new ones.

- **Bottom-sheet modals.** `.modal-overlay` wrapper + an inner sheet with `border-radius: 20px 20px 0 0`, `max-width: 500px`, `padding-bottom: calc(16px + var(--safe-bottom))`, `animation: slideUp 0.3s ease`. Used by History, Import, Export, Exercise Picker, History Detail, Gym Profiles, Hamburger Menu, Exercise History, Custom Form. New modals should follow this pattern.
- **Overlay-tap to close.** Every modal has a listener on the overlay: `if (e.target === this) closeX();`.
- **Toast feedback.** Errors call `showToast(msg, retryFn)` with a retry callback. Sticky until tapped. Informational toasts call with `null` retryFn and auto-dismiss at 20s.
- **Event delegation.** Mutations on `#workoutContainer` go through a single click delegate + a single change delegate at the top of `ui.js`'s event-listener block. Classes like `.set-check`, `.rpe-btn`, `.session-notes-header`, `.session-location-prompt`, `.session-location-select`, `.card-delete`, `.set-delete`, `.exercise-note-input` etc. are dispatched from there.
- **Wall-clock timers, not counters.** Both the session timer and (since v2.0.14) the rest timer anchor on `Date.now()`. A counter-based `setInterval` freezes when iOS suspends background tabs; a wall-clock compute catches up on `visibilitychange`. This is a project-wide rule — see `DECISIONS.md` (2026-04-19).
- **Notification API is not used.** iOS suspends backgrounded PWA JS, so `new Notification()` from a `setTimeout` won't fire at a deadline. Reliable background notifications require a service-worker + Web Push project, which is out of scope.
- **Lazy workout creation.** The `workouts` row for a plan-day tab is created on the first set-done OR first notes-blur via `ensureWorkout(di)`. Ad-hoc workouts are created eagerly via `createAdHocSession`. When a user picks a gym on a plan-day *before* the workout row exists, `state.pendingLocationId` holds the choice until `ensureWorkout` writes it. See `DECISIONS.md` for the `undefined` / `null` / `UUID` sentinel semantics.
- **State-object shape, in memory.** Every workout state (plan-day, ad-hoc, historical) has a common shape: `{ workoutId, planId, dayIndex, startedAt, endedAt, pausedMs, notes, notesExpanded, locationId, pendingLocationId?, exercises: { ex_<i>: { rpe, note, sub, sets: [{weight, reps, done, ...}], isExtra?, exerciseId?, exerciseMeta? } } }`. Ad-hoc states add `isAdHoc: true` and a `title`. `stateFromWorkout(row)` builds this from a DB row; `getOrInitToday(di)` / `createAdHocSession` initialize it empty.
- **Exercise identity.** All cross-session exercise matching uses `exerciseLibraryByName[normName(name)]` or, for plan-vs-seed mismatches, `resolveLibraryRow(name)`. See `DECISIONS.md` (2026-04-19) for the multi-pass matcher.

## Testing & deployment

- **No automated test framework.** Every feature is verified manually via the "browser smoke test" checklists in `docs/superpowers/specs/`.
- **Every visible change bumps `APP_VERSION`** (in `js/app.js`). Displayed in the bottom-right footer so stale-cache issues are trivial to diagnose ("which version am I on?").
- **Commits** are small and focused; migration + code can bundle in a single commit when the code requires the migration to function.
- **Pushes require explicit user approval.** See the workflow feedback memory.
- **Migrations are forward-only.** Never edit an applied migration; always write a new timestamped file in `supabase/migrations/`. The client applies them manually via the Supabase dashboard or CLI.

## Refactor history

- **Pre-refactor (v2.0.14 and earlier):** single `index.html` with ~3,100 lines of JS inline. File grew from ~2,000 lines at start of Session A to 4,421 lines by the time gym profiles + rest-timer fix landed.
- **The refactor (2026-04-19, post-v2.0.14):** split inline JS into the 5 files described above. No logic changes — `sed` extractions with a single bug (one missing closing brace, caught by `node --check` before any other testing). Load order and ownership decisions are captured in the commit message and in this doc's earlier sections.

## Pointers to other docs

When picking up a fresh session:

1. `HANDOFF.md` — current live version, what's shipped, known open items.
2. `DECISIONS.md` — architecture/behavior decisions, newest first. The "why" behind non-obvious choices.
3. `ROADMAP.md` — forward-looking scope (next: Session B AI planner).
4. `docs/superpowers/specs/` — per-feature design specs.
5. `docs/superpowers/plans/` — per-feature implementation plans.
6. `BUG-TEST-13.md` — one outstanding latent bug (emptyState crash on second plan import).

This file (`ARCHITECTURE.md`) is the "how is the code organized" layer; the others are the "what's shipped / why / next" layers.
