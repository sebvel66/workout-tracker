# Architecture

Map of the repo as a reference for future sessions. The authoritative state of *what's shipped* and *why specific decisions were made* lives in `HANDOFF.md`, `DECISIONS.md`, and `ROADMAP.md`; this doc is about *how the code is organized* and *where to find things*.

Start here if you're picking up the project fresh.

## At a glance

Mobile-first PWA for workout tracking, with an AI plan generator powered by Claude Sonnet 4.6. Frontend is a single HTML page + 5 plain JS modules, no build step. Backend is Supabase (persistence + auth + storage) plus one Vercel serverless function (`/api/generate-plan`) for AI generation. CSS lives inline in `index.html`. Verification is manual browser testing — no automated test suite.

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
├── api/
│   └── generate-plan.js             # Vercel Node serverless function: AI plan generator
├── system-prompt.md                 # Claude coaching prompt, bundled into the function
├── vercel.json                      # Vercel config (includeFiles for system-prompt.md)
├── package.json                     # { "type": "module" } — declares ESM for api/
├── supabase/
│   └── migrations/                  # Forward-only Supabase SQL, timestamp-prefixed
├── docs/
│   └── superpowers/
│       ├── specs/                   # Design specs, dated per-feature
│       └── plans/                   # Implementation plans, dated per-feature
├── HANDOFF.md                       # Current-state pickup doc; version + open items
├── DECISIONS.md                     # Running log of architecture/behavior decisions
├── ROADMAP.md                       # Forward-looking scope
├── ARCHITECTURE.md                  # This file
├── MAJOR-BUGS.md                    # Non-trivial bugs worth preserving for later
└── BUG-TEST-13.md                   # One outstanding latent bug (emptyState crash)
```

`index.html` is only HTML+CSS+script tags — no inline JavaScript. If you're adding logic, it goes in one of the `js/*.js` files per the split below. Server-side logic goes in `api/` — currently just the one plan-generator function.

## Database schema (high level)

Defined in `supabase/migrations/`. Tables:

| Table | Purpose |
|---|---|
| `plans` | Imported/generated plan JSON (`data jsonb`). One `is_active = true` per user via partial unique index. Plan JSON stamps `start_date` (YYYY-MM-DD, client-side on save) for calendar-anchored phase-awareness reasoning. |
| `exercises` | Seed library (`user_id IS NULL`) + user-custom rows. Case-insensitive name uniqueness per user for customs. |
| `workouts` | One per session. `plan_id` null = ad-hoc. Nullable `location_id` FK. `performed_on date` + partial unique index on `(user_id, plan_id, day_index, performed_on)` for dedup. `paused_ms bigint` for pause/resume. `notes text` for session-level notes. |
| `sets` | One per set. Per-set RPE, prescribed vs actual columns, `started_at` / `completed_at`, `CHECK (done = false or completed_at is not null)`. |
| `locations` | User-defined gym names. Case-insensitive unique per user. |
| `physique_photos` | Goal + progress photos. `storage_path` points into the `physique-photos` private bucket; rendering uses short-lived signed URLs. |

**Supabase Storage:**
- `physique-photos` (private bucket) — photo files stored under `{user_id}/{uuid}.{ext}`. Storage RLS policies scope read/insert/delete by path prefix via `storage.foldername(name)[1] = auth.uid()::text`.

RLS on every table: `auth.uid() = user_id` (exercises has a split policy for seed reads). FK deletes are either `CASCADE` (sets on workout delete) or `SET NULL` (`workouts.location_id` on gym delete).

See `DECISIONS.md` for why each schema choice was made (partial unique index semantics, `paused_ms` offset, `completed_at` immutability, case-insensitive name uniqueness, path-prefix storage RLS, etc.).

## JS module layout

Total ~4,500 lines split across 5 frontend files + 1 server file. Rough sizes:

| File | ~Lines | What lives here |
|---|---|---|
| `js/resolver.js` | 68 | `normName`, `EXERCISE_ALIASES`, `resolveLibraryRow`. Pure string/lookup utility. |
| `js/data.js` | 1700 | Supabase client (`sb`), cross-cutting state, queries, persistence, session lifecycle, plan activation/import, `fetchWeekSummary`, photo CRUD, week/date helpers. |
| `js/ui.js` | 2400 | Renderers, modals (History, Photos, Plans, Generate), event listeners, toast, session/rest timers, export. |
| `js/auth.js` | 165 | OTP form state + handlers, `applySession` (sign-in → cache reset → hydrate). |
| `js/app.js` | 135 | `APP_VERSION`, `paintVersion` IIFE, `hydrate` (with auto-load historical), `sb.auth.getSession` + `onAuthStateChange`. |
| `api/generate-plan.js` | 500 | Vercel Node serverless function: JWT verify → Supabase queries → build prompt → Claude API → validate + expand → return. |

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
| `suggestedDayIndex` | data.js | Rotation+1 from most recent completed workout; null if no plan. Populated once per hydrate by `loadSuggestedDayIndex`. Consumed by the start-screen modal. |
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
| `historyView`, `historyWeekStart`, `historyWeekCache`, `historyWeekLoading`, `historyDetails` | ui.js | Weekly History browser state. `historyView` is `'week' \| 'detail'`. |
| `photosView`, `photosPendingFile`, `photosPendingPreviewUrl`, `photosViewerId` | ui.js | Physique photos modal state. `photosView` is `'gallery' \| 'upload' \| 'viewer'`. |
| `photosGoal`, `photosProgress`, `photosLoaded`, `photosSignedUrls` | data.js | Photo metadata + signed-URL cache (keyed by storage_path, 1h TTL). |
| `earliestWorkoutDate` | data.js | YYYY-MM-DD cache for the user's first-ever workout; used by History to gate Prev-week navigation. |
| `generateView`, `generatedPlan`, `generatedMeta`, `generatedInputs`, `generateStartedAt`, `generateInFlight`, `generateAbortController` | ui.js | AI plan generator modal state. `generateView` is `'inputs' \| 'loading' \| 'review'`. |
| `plansList`, `plansLoading` | ui.js | Plans management modal state. |
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

## Server-side: AI plan generator

One serverless function at `api/generate-plan.js`. Deployed on Vercel, runs on Node runtime (not Edge), called from the frontend via `POST /api/generate-plan` with an `Authorization: Bearer <supabase-jwt>` header.

### Request lifecycle

```
Browser (hamburger → Generate → inputs form → Submit)
  │  POST /api/generate-plan  { start_date, target_duration, notes }
  │  Authorization: Bearer <jwt>
  ▼
Edge Function
  ├─ verifyUser(jwt) → /auth/v1/user → extract user_id
  ├─ Promise.all([
  │     fetchActivePlan(userId),
  │     fetchRecentWorkouts(userId, 4),   // 4 weeks history
  │     fetchExerciseLibrary(userId),
  │     fetchPhysiquePhotos(userId),      // latest goal + 1 progress
  │   ])
  ├─ buildUserMessage(...)                 // dynText + photos as image blocks
  ├─ fetch('https://api.anthropic.com/v1/messages', {
  │     model: 'claude-sonnet-4-6',
  │     max_tokens: 16000,
  │     temperature: 0.3,
  │     system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
  │     messages: [{ role: 'user', content: [exercise_library + cache_control, dynText, ...photos] }]
  │   })   // 55s AbortController timeout
  ├─ parse + validatePlan()
  ├─ expandSetRepeats(plan)                // unroll repeat: N shorthand
  ▼
Response  { plan, coaching_notes, weeks_analyzed, model, usage, generated_at }
```

### Key design choices (see DECISIONS.md 2026-04-20 for rationale)

- **Node runtime, not Edge runtime.** Needed for `fs.readFileSync` of the system prompt, longer timeouts, and standard SDK compatibility.
- **Raw `fetch` for both Supabase PostgREST and Anthropic.** No npm dependencies.
- **Service-role key for DB queries.** Bypasses RLS; `user_id` filter applied in code as defense in depth.
- **Two prompt cache breakpoints with 1h TTL:** one on system prompt, one on exercise library. ~8500 tokens cached, ~90% input-cost savings on cache hits.
- **`repeat: N` shorthand on set objects, server-expanded.** Claude emits compact; `expandSetRepeats(plan)` unrolls before returning to the frontend. Cuts output ~60%.
- **55s `AbortController` timeout.** Under Vercel Hobby's 60s function cap, leaves time for clean 504 error envelope.

### System prompt

Lives at repo root (`system-prompt.md`), bundled into the function via `vercel.json` `includeFiles`, loaded once via `fs.readFileSync` at module cold start. Edit = commit = redeploy (Vercel auto-deploys on push). Git diffs are the primary iteration surface.

**`vercel dev` gotcha:** does NOT hot-reload on edits. Kill + restart required after `system-prompt.md` changes.

### Environment variables

Required on Vercel across all environments (Production, Preview, Development):

| Variable | Source | Purpose |
|---|---|---|
| `SUPABASE_URL` | Supabase dashboard | Server-side PostgREST + Storage endpoints |
| `SUPABASE_ANON_KEY` | Supabase dashboard | JWT verification via `/auth/v1/user` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → API Keys (secret) | Bypasses RLS for server-side queries. **Never in frontend code.** |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Claude API authentication |

Local dev: `vercel env pull .env.local` to pull from Vercel, OR manually edit `.env.local` (gitignored). Sensitive variables may need to be manually added to `.env.local` — Vercel's Development scope can block them.

### Performance characteristics (observed in production)

| Scenario | Elapsed | Output tokens | Cost per call |
|---|---|---|---|
| Cache miss (first call of the hour) | 35-45s | 1500-2500 | ~$0.04 |
| Cache hit (subsequent calls within 1h) | 22-30s | 1500-2500 | ~$0.01 |
| Failed (Anthropic slow-spell) | 55s (timeout) | — | partial cost |

Server-side timing logs at phase boundaries (`[generate-plan] data fetch: X ms`, `[generate-plan] prompt build: X ms`, `[generate-plan] claude call: X ms · usage: {...}`) show up in `vercel dev` terminal and Vercel Production logs.

## UI patterns & conventions

Patterns established through earlier features. Reuse these when adding new UI rather than inventing new ones.

- **Bottom-sheet modals.** `.modal-overlay` wrapper + an inner sheet with `border-radius: 20px 20px 0 0`, `max-width: 500px`, `padding-bottom: calc(16px + var(--safe-bottom))`, `animation: slideUp 0.3s ease`. Used by History, Import, Export, Exercise Picker, History Detail, Gym Profiles, Hamburger Menu, Exercise History, Custom Form, Start Screen. New modals should follow this pattern.
- **Overlay-tap to close.** Every modal has a listener on the overlay: `if (e.target === this) closeX();`.
- **Toast feedback.** Errors call `showToast(msg, retryFn)` with a retry callback. Sticky until tapped. Informational toasts call with `null` retryFn and auto-dismiss at 20s.
- **Event delegation.** Mutations on `#workoutContainer` go through a single click delegate + a single change delegate at the top of `ui.js`'s event-listener block. Classes like `.set-check`, `.rpe-btn`, `.session-notes-header`, `.session-location-prompt`, `.session-location-select`, `.card-delete`, `.set-delete`, `.exercise-note-input` etc. are dispatched from there.
- **Wall-clock timers, not counters.** Both the session timer and (since v2.0.14) the rest timer anchor on `Date.now()`. A counter-based `setInterval` freezes when iOS suspends background tabs; a wall-clock compute catches up on `visibilitychange`. This is a project-wide rule — see `DECISIONS.md` (2026-04-19).
- **Notification API is not used.** iOS suspends backgrounded PWA JS, so `new Notification()` from a `setTimeout` won't fire at a deadline. Reliable background notifications require a service-worker + Web Push project, which is out of scope.
- **Lazy workout creation.** The `workouts` row for a plan-day tab is created on the first set-done OR first notes-blur via `ensureWorkout(di)`. Ad-hoc workouts are created eagerly via `createAdHocSession`. When a user picks a gym on a plan-day *before* the workout row exists, `state.pendingLocationId` holds the choice until `ensureWorkout` writes it. See `DECISIONS.md` for the `undefined` / `null` / `UUID` sentinel semantics.
- **State-object shape, in memory.** Every workout state (plan-day, ad-hoc, historical) has a common shape: `{ workoutId, planId, dayIndex, startedAt, endedAt, pausedMs, notes, notesExpanded, locationId, pendingLocationId?, exercises: { ex_<i>: { rpe, note, sub, sets: [{weight, reps, done, ...}], isExtra?, exerciseId?, exerciseMeta? } } }`. Ad-hoc states add `isAdHoc: true` and a `title`. `stateFromWorkout(row)` builds this from a DB row; `getOrInitToday(di)` / `createAdHocSession` initialize it empty.
- **Exercise identity.** All cross-session exercise matching uses `exerciseLibraryByName[normName(name)]` or, for plan-vs-seed mismatches, `resolveLibraryRow(name)`. See `DECISIONS.md` (2026-04-19) for the multi-pass matcher.
- **Three-view modal sub-states.** Modals that cycle through distinct sub-views (History: `'week' | 'detail'`, Photos: `'gallery' | 'upload' | 'viewer'`, Generate: `'inputs' | 'loading' | 'review'`) use a single `xxxView` string variable + a dispatching `renderX()` function. Same pattern across all three — reuse it for any future multi-step modal flow rather than inventing per-modal state shapes.
- **AbortController for long-running fetches.** Both `api/generate-plan.js` (55s server-side) and `ui.js` (client-side, wired to Cancel button + modal close) use `AbortController` to cleanly terminate stuck or user-canceled LLM calls. Required pattern for any future LLM/long-call feature.
- **`planWeekLabel(plan)` is the single source of truth for plan week labels.** Derives Sun-Sat range from `plan.start_date` (with `plans.created_at` fallback via `ensureStartDate`). Always prefer this over `plan.week` at render time.
- **Plan-blob persistence rule:** `savePlanAsActive` creates a new row + flips `is_active`; `activateExistingPlan` flips `is_active` without a new row (preserves original `start_date`). Never conflate the two paths.

## Testing & deployment

- **No automated test framework.** Every feature is verified manually via the "browser smoke test" checklists in `docs/superpowers/specs/`.
- **Every visible change bumps `APP_VERSION`** (in `js/app.js`). Displayed in the bottom-right footer so stale-cache issues are trivial to diagnose ("which version am I on?").
- **Commits** are small and focused; migration + code can bundle in a single commit when the code requires the migration to function.
- **Pushes require explicit user approval.** See the workflow feedback memory.
- **Migrations are forward-only.** Never edit an applied migration; always write a new timestamped file in `supabase/migrations/`. The client applies them manually via the Supabase dashboard or CLI.

## Refactor history

- **Pre-refactor (v2.0.14 and earlier):** single `index.html` with ~3,100 lines of JS inline. File grew from ~2,000 lines at start of Session A to 4,421 lines by the time gym profiles + rest-timer fix landed.
- **The JS split (2026-04-19, post-v2.0.14):** split inline JS into the 5 files described above. No logic changes — `sed` extractions with a single bug (one missing closing brace, caught by `node --check` before any other testing).
- **Session B (2026-04-20, v2.0.19 – v2.0.25):** added weekly History browser, physique photos + storage, AI plan generator Edge Function + inputs UI + Plans management modal. ~1400 new lines in `ui.js`, ~600 in `data.js`, plus 500 lines of new server-side code in `api/generate-plan.js`. Added `system-prompt.md`, `vercel.json`, `package.json`, and one Supabase migration. See HANDOFF.md for the version-by-version breakdown.

## Pointers to other docs

When picking up a fresh session:

1. `HANDOFF.md` — current live version, what's shipped, known open items.
2. `DECISIONS.md` — architecture/behavior decisions, newest first. The "why" behind non-obvious choices.
3. `ROADMAP.md` — forward-looking scope.
4. `MAJOR-BUGS.md` — non-trivial bugs with full debugging narratives. Especially worth reading: 2026-04-20 (system-prompt latency — the prompt-engineering tradeoffs).
5. `docs/superpowers/specs/` — per-feature design specs.
6. `docs/superpowers/plans/` — per-feature implementation plans.
7. `BUG-TEST-13.md` — one outstanding latent bug (emptyState crash on second plan import).

This file (`ARCHITECTURE.md`) is the "how is the code organized" layer; the others are the "what's shipped / why / next" layers.
