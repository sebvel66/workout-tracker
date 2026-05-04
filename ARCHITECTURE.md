# Architecture

Map of the repo as a reference for future sessions. The authoritative state of *what's shipped* and *why specific decisions were made* lives in `HANDOFF.md`, `DECISIONS.md`, and `ROADMAP.md`; this doc is about *how the code is organized* and *where to find things*.

Start here if you're picking up the project fresh.

## At a glance

Mobile-first PWA for workout tracking, with an AI coach (Claude Sonnet 4.6 + Haiku 4.5) running across plan generation, training analysis, exercise swap, iterative plan refinement, and a real-time coach chat. Frontend is a single HTML page + 5 plain JS modules, no build step. Backend is Supabase (persistence + auth + storage) plus two Vercel serverless functions (`/api/generate-plan` for plan/analyze/swap/refine, `/api/coach-chat` for the floating chat). CSS lives inline in `index.html`. Verification is manual browser testing — no automated test suite.

## Repo layout

```
/
├── index.html                       # HTML + inline CSS + <script src> tags. No JS.
├── js/
│   ├── resolver.js                  # Exercise name resolution (no deps)
│   ├── data.js                      # Supabase client, state, queries, mutations
│   ├── ui.js                        # Renderers, modals, event listeners, timers
│   ├── auth.js                      # OTP sign-in, applySession
│   └── app.js                       # APP_VERSION, paintFromCache, hydrate, auth wiring
├── api/
│   ├── generate-plan.js             # 4-mode Edge Function: plan / analyze / swap / refine
│   └── coach-chat.js                # Real-time chat (Haiku, ~1-2s warm)
├── system-prompt-core.md            # Shared CLIENT PROFILE + COACHING PHILOSOPHY + EXERCISE LIBRARY
├── system-prompt-plan.md            # Plan-mode suffix (USER INPUTS, output schema, cardio, drop sets)
├── system-prompt-analyze.md         # Analyze-mode suffix (4-section assessment, profile_updates)
├── vercel.json                      # Vercel config (includeFiles for system-prompt-*.md, crons)
├── package.json                     # { "type": "module" } — declares ESM for api/
├── supabase/
│   └── migrations/                  # Forward-only Supabase SQL, timestamp-prefixed
├── docs/
│   └── superpowers/
│       ├── specs/                   # Design specs, dated per-feature
│       └── plans/                   # Implementation plans, dated per-feature
├── HANDOFF.md                       # Current-state pickup doc; version + open items
├── DECISIONS.md                     # Running log of architecture/behavior decisions
├── ROADMAP.md                       # Forward-looking scope + Shipped log
├── ARCHITECTURE.md                  # This file
├── MAJOR-BUGS.md                    # Non-trivial bugs worth preserving for later
└── BUG-TEST-13.md                   # One outstanding latent bug (emptyState crash)
```

`index.html` is only HTML+CSS+script tags — no inline JavaScript. If you're adding logic, it goes in one of the `js/*.js` files per the split below. Server-side logic goes in `api/` — currently just the one plan-generator function.

## Database schema (high level)

Defined in `supabase/migrations/`. Tables:

| Table | Purpose |
|---|---|
| `plans` | Imported / generated plan JSON (`data jsonb`). One `is_active = true` per user via partial unique index. `is_template bool` + `template_name text` flag template rows (v2.1.0). Plan JSON stamps `start_date` (YYYY-MM-DD, client-side on save) for calendar-anchored phase-awareness reasoning. |
| `exercises` | Seed library (`user_id IS NULL`) + user-custom rows. Case-insensitive name uniqueness per user for customs. `muscle_group='cardio'` flag drives the cardio set-row UI branch (v2.5.7). |
| `workouts` | One per session. `plan_id` null = ad-hoc. Nullable `location_id` FK. `title` for ad-hoc names. `performed_on date` + partial unique index on `(user_id, plan_id, day_index, performed_on)` for dedup. `paused_ms bigint` for pause/resume. `notes text` for session-level notes. |
| `sets` | One per set. Per-set RPE, prescribed vs actual columns, `started_at` / `completed_at`, `CHECK (done = false or completed_at is not null)`. v2.2.1 added `prescribed_exercise_id` (substitution: what the plan asked for vs `exercise_id` = what actually happened). v2.5.7 added `duration_seconds` + `distance` for cardio. v2.5.11 added `set_type text default 'standard'` (CHECK in 'standard','drop','superset','giant') + `parent_set_id uuid references sets(id) on delete cascade` for drop-set chains; partial index on `parent_set_id where parent_set_id is not null`. |
| `locations` | User-defined gym names. Case-insensitive unique per user. |
| `physique_photos` | Goal + progress photos. `storage_path` points into the `physique-photos` private bucket; rendering uses short-lived signed URLs. |
| `coach_messages` | v2.4.19. Durable log of coaching interactions: chat sends, swap accept rows, plan-gen accept rows, analyze responses. Columns: `role` ('user' or 'assistant'), `content`, `context_type` ('chat' / 'swap' / 'plan_generation'), `exercise_name` (for swap rows), `created_at`. Read by all four Claude call paths — last 2 weeks + current week injected as RECENT COACHING CONVERSATIONS in the user message. |
| `coaching_profile` | v2.5.0. One row per user, jsonb `data` column holds the full profile (sex / height / weight / experience / environment / split preference / goal_type+detail / phase+notes+start_date / injuries-as-list / special_instructions). Read by all four Claude call paths and injected as a CLIENT PROFILE block at the top of the user message. Replaces the hardcoded CLIENT PROFILE / Injury / Phase blocks that used to live in `system-prompt-core.md`. |

**Supabase Storage:**
- `physique-photos` (private bucket) — photo files stored under `{user_id}/{uuid}.{ext}`. Storage RLS policies scope read/insert/delete by path prefix via `storage.foldername(name)[1] = auth.uid()::text`.

RLS on every table: `auth.uid() = user_id` (exercises has a split policy for seed reads; coach_messages and coaching_profile are owner-only select+insert+update). FK deletes are either `CASCADE` (sets on workout delete; sets on parent-set delete; coach_messages / coaching_profile on user delete) or `SET NULL` (`workouts.location_id` on gym delete).

See `DECISIONS.md` for why each schema choice was made (partial unique index semantics, `paused_ms` offset, `completed_at` immutability, case-insensitive name uniqueness, path-prefix storage RLS, etc.).

## JS module layout

Total ~14,140 lines split across 6 frontend files + 3 server files. Rough sizes (as of v3.4.0):

| File | ~Lines | What lives here |
|---|---|---|
| `js/resolver.js` | 80 | `normName`, `EXERCISE_ALIASES`, `resolveLibraryRow`. Pure string/lookup utility. |
| `js/data.js` | 4115 | Supabase client (`sb`), cross-cutting state, queries, persistence, session lifecycle, plan activation/import (`savePlanAsActive` / `activateExistingPlan` / `endActivePlan`), `fetchWeekSummary`, `fetchRecentWorkouts`, photo CRUD, coach message persistence, coaching profile load/save, drop-set state model, cardio helpers, hydration cache, **superset block management** (`applySupersetMerge` / `applySupersetSeparate` / `applySupersetReorderMembers` / `addRoundToBlockMembers` / `_resolveFlatEi` / `_flatEiToPlanMember` / `_restateFromSupersetGroups` / `shouldFireRestForBlockMember` / `supersetGroupsFromPlanDay`), `modelForCoach` / `modelForPlan` / `modelForAnalyze` resolvers, weight-mode override fan-out (`setExerciseWeightMode`), history-edit helpers (`historyUpdateSetField` etc.). |
| `js/ui.js` | 7297 | Renderers, modals (History, Photos, Plans, Templates, Generate, Coaching Profile, Coach Chat panel, Resume-Session prompt, Superset picker), event listeners, toast, session timer, rest-timer pill, export, refine flow, profile-update diff cards, drop-set UI, no-plan empty-state (`renderEmptyState` / `renderEmptyStateRecent`), **superset rendering** (`groupRunsForRender` / `renderSupersetBlock` / `renderPlanDayExerciseCard` / `renderPlanDayExtraCard` / `renderAdHocExerciseCard` / `renderHistoryExerciseCard`), per-block SortableJS zones, History edit mode. |
| `js/auth.js` | 168 | OTP form state + handlers, `applySession` (sign-in → cache reset → hydrate). |
| `js/app.js` | 401 | `APP_VERSION`, `paintVersion` IIFE, `paintFromCache` IIFE (warm-boot from localStorage), `hydrate` (parallelized phase 1 + deferred phase 2; v3 added a parallel no-plan branch that loads exerciseLibrary + locations before falling through to the empty state), `sb.auth.getSession` + `onAuthStateChange`. |
| `js/models.js` | 38 | Per-user AI model selection (v3.2.0). Allowlist + helpers mirrored on the server side in `api/_models.js`. |
| `api/generate-plan.js` | 1629 | Vercel Node serverless function with 4 dispatched modes: `plan` (default), `analyze`, `swap`, `refine`. JWT verify → parallel Supabase queries (active plan, history, library, photos, coach history, coaching profile) → mode-specific prompt build → Claude API with cache_control breakpoints → validate (accepts `superset:true` block shape and recurses) + `expandSetRepeats` (recurses into block children) → return. v3.3.0 cold-start path null-guards `formatCurrentPlan` and prepends a `COLD START` marker when both activePlan and history are absent. |
| `api/coach-chat.js` | 365 | Real-time coach chat (Haiku 4.5, 500 max tokens, ~1-2s warm). JWT verify → side-channel queries (coach_messages, coaching_profile, both via service role) → splice CLIENT PROFILE + RECENT COACHING CONVERSATIONS into messages[0] → forward to Anthropic. Inline COACH_SYSTEM_PROMPT (cached) covers response style, progression rules, COACHING CONTINUITY, cardio Q&A guidance. |
| `api/_models.js` | 43 | Server-side AI model allowlist (v3.2.0 / v3.2.1 with temperature gating for Opus 4.7). Mirrors `js/models.js`. |

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
| `daysWithHistory` | data.js | `{ [dayIndex]: true }` map populated at hydrate so the day-tab dropdown's completion `●` dot renders correctly on first paint without waiting for lazy `historicalCache` populate (v2.2.6 hotfix). |
| `coachingProfile` | data.js | In-memory cache of the user's coaching_profile.data jsonb (v2.5.0). Null until first load; modal reads + writes it. |
| `restInterval`, `restTargetMs`, `restCompleted`, `restAudioCtx` | ui.js | Wall-clock rest timer state. Renders as a non-blocking floating pill at bottom-center (v2.5.9). |
| `sessionTimerInterval` | ui.js | Session-timer re-render interval. |
| `pickerState` | ui.js | Search + filter state for the exercise picker. |
| `historyView`, `historyWeekStart`, `historyWeekCache`, `historyWeekLoading`, `historyDetails` | ui.js | Weekly History browser state. `historyView` is `'week' \| 'detail'`. |
| `photosView`, `photosPendingFile`, `photosPendingPreviewUrl`, `photosViewerId` | ui.js | Physique photos modal state. `photosView` is `'gallery' \| 'upload' \| 'viewer'`. |
| `photosGoal`, `photosProgress`, `photosLoaded`, `photosSignedUrls` | data.js | Photo metadata + signed-URL cache (keyed by storage_path, 1h TTL). |
| `earliestWorkoutDate` | data.js | YYYY-MM-DD cache for the user's first-ever workout; used by History to gate Prev-week navigation. |
| `generateMode`, `generateView`, `generatedPlan`, `generatedAnalysis`, `generatedMeta`, `generatedInputs`, `generateStartedAt`, `generateInFlight`, `generateAbortController`, `generateAttempt` | ui.js | Generate / analyze / refine modal state. `generateMode` is `'plan' \| 'analyze'`; `generateView` is `'inputs' \| 'loading' \| 'review'`. |
| `iterationHistory`, `generatedChangeNotes`, `refineInFlight` | ui.js | Iterative plan refinement state (v2.5.3). Each refine call appends `{plan, feedback}` to `iterationHistory`; the server replays the multi-turn conversation each call. `generatedChangeNotes` is the latest "what changed" string for the WHAT CHANGED banner. |
| `chatHistory`, `chatLoadedHistory`, `chatLoadedAt`, `chatLoadingHistory`, `chatPending`, `chatHasUnread`, `chatAttempt` | ui.js | Coach Chat panel state. `chatHistory` is the in-memory live conversation (capped at 20 messages, sent to `/api/coach-chat`); `chatLoadedHistory` is the durable past-messages strip loaded on panel open with 5-min cache. |
| `coachContext` | data.js | Semi-static per-session coach chat context (plan + this-week status + 2-week per-exercise history). Built lazily on first chat send via `buildCoachContext`; cleared on session start/complete and sign-out. |
| `swapState` | ui.js | AI exercise swap modal state. `view` is `'input' \| 'loading' \| 'review'`. |
| `templatesList` | ui.js | Templates management modal state. |
| `saveTemplateContext`, `saveTemplateActiveScope` | ui.js | Save-as-template modal state (scope picker). |
| `atfCheckedIdx` | ui.js | Add-from-template checkbox state (which template exercises are selected). |
| `plansList`, `plansLoading` | ui.js | Plans management modal state. |
| `recentWorkoutsCache` | ui.js | Lazily populated by `renderEmptyState` via `fetchRecentWorkouts(userId, 5)`; null = not yet fetched. Powers the no-plan empty-state Recent workouts list (v3.0.0). |
| `toastCounter` | ui.js | Monotonic id generator for toasts. |
| `EQUIPMENT_OPTIONS`, `MUSCLE_OPTIONS` | ui.js | Picker filter chip constants. |
| `EXERCISE_ALIASES` | resolver.js | Plan-name → canonical seed-name mapping. |
| `authForm`, `authEmail`, ..., `authStep`, `authPendingEmail` | auth.js | Sign-in form DOM refs + form-stage state. |
| `__hydratedFromCache` (file-local) | app.js | Flag set by the `paintFromCache` IIFE so hydrate's reconcile knows it's in warm-boot mode. |
| `HYDRATION_CACHE_KEY`, `HYDRATION_SCHEMA_VERSION`, `HYDRATION_MAX_AGE_MS` | data.js | localStorage key + schema-version gate + 7d age gate for the hydration cache (v2.4.0). |

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

## Server-side: AI Edge Functions

Two serverless functions, both Node runtime:

- **`api/generate-plan.js`** — 4 modes dispatched by request body's `mode` field: default plan generation, `analyze`, `swap`, `refine`. Sonnet 4.6, 16k max tokens, 55s timeout.
- **`api/coach-chat.js`** — real-time chat with Haiku 4.5, 500 max tokens, ~1-2s warm. Frontend pre-assembles the messages array; server splices in side-channel context (CLIENT PROFILE + RECENT COACHING CONVERSATIONS) before forwarding to Anthropic.

Both authenticated via `Authorization: Bearer <supabase-jwt>` → `/auth/v1/user` → user_id extraction. All downstream Supabase reads use `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS but each query still filters by user_id defensively).

### Request lifecycle (plan / analyze / swap / refine)

```
Browser (Generate flow / Analyze button / Swap ⇄ icon / Refine textarea)
  │  POST /api/generate-plan
  │   { mode?: 'analyze' | 'swap' | 'refine', ...mode-specific inputs }
  │  Authorization: Bearer <jwt>
  ▼
Edge Function (api/generate-plan.js)
  ├─ verifyUser(jwt) → user_id
  ├─ Mode dispatch:
  │     swap     → handleSwap
  │     analyze  → handleAnalyze
  │     refine   → handleRefine
  │     default  → main plan-gen path
  ├─ Promise.all([
  │     fetchActivePlan(user_id),
  │     fetchRecentWorkouts(user_id, history_weeks),
  │     fetchExerciseLibrary(user_id),
  │     fetchPhysiquePhotos(user_id, ...) | { goal: null, progress: [] },
  │     fetchRecentCoachHistory(user_id, 2),    // 2 weeks + current week
  │     fetchCoachingProfile(user_id),          // jsonb data column
  │   ])
  ├─ buildUserMessage(...) — assembles dynText:
  │     1. CLIENT PROFILE (formatCoachingProfile)
  │     2. CURRENT PLAN snapshot
  │     3. RECENT PERFORMANCE (verbatim + summarized)
  │     4. RECENT COACHING CONVERSATIONS (formatCoachHistory)
  │     5. USER INPUTS (mode-specific)
  │     6. mode-specific instruction footer
  ├─ fetch('https://api.anthropic.com/v1/messages', {
  │     model: 'claude-sonnet-4-6',
  │     max_tokens: ...mode-specific...,
  │     system: [{ text: SYSTEM_PROMPT_PLAN | _ANALYZE | inline SWAP_SYSTEM_PROMPT,
  │                cache_control: { ttl: '1h' } }],
  │     messages: [
  │       { role: 'user', content: [
  │         { text: formatExerciseLibrary(...), cache_control: { ttl: '1h' } },
  │         { text: dynText },
  │         ...photo blocks (plan + analyze only)
  │       ]},
  │       // Refine mode only: alternating assistant (prior plan JSON) + user
  │       // (prior feedback) turns from iteration_history; latest assistant
  │       // turn gets cache_control so iter N+1 reuses iter N's prefix.
  │     ]
  │   })
  ├─ parse + mode-specific validate (validatePlan / validateAnalysis /
  │     validateSwapReplacement)
  ├─ expandSetRepeats(plan)   // unroll `repeat: N` shorthand (plan / refine)
  ▼
Response  (mode-specific shape)
  plan:    { plan, weeks_analyzed, training_days, include_photos, model, usage, generated_at }
  analyze: { analysis: { trends, progressing, concerns, next_week, profile_updates: [] }, ... }
  swap:    { replacement, replaced, reason, model, usage, generated_at }
  refine:  { plan, change_notes, iterations, weeks_analyzed, training_days, ... }
```

### Coach-chat lifecycle (separate endpoint)

```
Browser (floating coach chat fab → send)
  │  POST /api/coach-chat
  │   { messages: [ {role:'user', content: COACHING CONTEXT block}, ack, ...history, new user msg ] }
  ▼
Edge Function (api/coach-chat.js)
  ├─ verifyUser(jwt)
  ├─ Promise.all([fetchRecentCoachHistory(2), fetchCoachingProfile()])
  ├─ Splice into messages[0].content:
  │     CLIENT PROFILE block (top, before existing COACHING CONTEXT)
  │     RECENT COACHING CONVERSATIONS (before "Please acknowledge..." trailer)
  ├─ fetch Anthropic — Haiku 4.5, 500 tokens, 25s timeout
  │     system: [{ text: COACH_SYSTEM_PROMPT, cache_control: 1h }]
  ▼
Response  { reply, model, usage }
```

### Key design choices (see DECISIONS.md for rationale)

- **Node runtime, not Edge runtime.** Needed for `fs.readFileSync` of the prompt files, longer timeouts, and standard SDK compatibility.
- **Raw `fetch` for both Supabase PostgREST and Anthropic.** No npm dependencies; deployment is just the .js files.
- **Service-role key for DB queries.** Bypasses RLS; each query still filters by `user_id` in code as defense in depth.
- **Cache breakpoints with 1h TTL.** Plan + analyze: system prompt (cached) + exercise library (cached as first user-message content block) = ~8500 cached tokens, ~90% input-cost savings on cache hits. Swap + coach-chat: cached inline system prompt only. Refine: ALSO adds cache_control on the latest assistant turn so iter N+1 reuses iter N's emission as cached prefix (~$0.01-0.02 per iteration warm).
- **Per-mode cache isolation.** Anthropic prefix-based caching means plan / analyze / swap / coach-chat each have their own cache entries — running analyze does NOT warm plan-gen, etc. See DECISIONS.md.
- **Side-channel queries (coach_messages, coaching_profile).** All four call paths fetch these on every call. Coaching profile replaces the hardcoded CLIENT PROFILE block; coach history adds cross-session continuity. Both queries are non-fatal — a failed fetch returns null/empty and the call proceeds with fallback content (e.g., "client has not filled in their coaching profile yet").
- **`repeat: N` shorthand on set objects, server-expanded.** Claude emits compact; `expandSetRepeats(plan)` unrolls before returning to the frontend. Works for cardio + drop sets too (the spread-copy preserves additional fields).
- **Drop set flat format on plan JSON.** Drops live as additional set entries with `set_type: 'drop'`, contiguous after their parent. Keeps `plan.sets[]` and the in-memory `exState.sets[]` aligned at the same index — avoided the flat-vs-nested mismatch the original spec proposed.
- **55s `AbortController` timeout.** Under Vercel Hobby's 60s function cap; leaves time for a clean 504 envelope. Coach-chat uses 25s (Haiku is fast).

### System prompt files

Three files at the repo root, bundled into the plan-gen function via `vercel.json` `includeFiles: 'system-prompt-*.md'`:

- **`system-prompt-core.md`** — shared across plan + analyze. Universal coaching philosophy, exercise library reference, COACHING CONTINUITY directive, points at `CLIENT PROFILE` in the user message.
- **`system-prompt-plan.md`** — plan-mode suffix. USER INPUTS rules, plan-output schema, CRITICAL FORMAT RULES, CARDIO PRESCRIPTION, DROP SETS, HARD CONSTRAINTS.
- **`system-prompt-analyze.md`** — analyze-mode suffix. ROLE / USER INPUTS / four-section assessment / PROFILE UPDATES (v2.5.2) / output JSON schema.

Loaded once via `fs.readFileSync` at module cold start. `SYSTEM_PROMPT_PLAN = core + '\n\n' + plan_suffix`; `SYSTEM_PROMPT_ANALYZE = core + '\n\n' + analyze_suffix`. Each is sent with its own `cache_control` breakpoint.

Swap and coach-chat use SEPARATE inline system prompts (no shared core) — they're focused workflows where the full coaching philosophy isn't needed and inline strings keep the deploy surface lean.

**`vercel dev` gotcha:** does NOT hot-reload on edits to any prompt file. Kill + restart required after edits. Pushed deploys correctly pick up the changes.

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

| Endpoint / mode | Cache hit | Cache miss | Output tokens | Cost per call (warm) |
|---|---|---|---|---|
| `generate-plan` (plan) | 22-30s | 35-45s | 1500-2500 | ~$0.01 |
| `generate-plan` (analyze) | 15-25s | 30-40s | 500-1000 | ~$0.01 |
| `generate-plan` (swap) | 8-15s | 18-25s | ~300 | ~$0.005 |
| `generate-plan` (refine, iter ≥ 2) | 18-25s | n/a | 1500-2500 | ~$0.01-0.02 |
| `coach-chat` | 1-2s | 3-5s | 100-300 | ~$0.001 |
| Hydrate (warm-cache cold-paint to fresh paint) | ~600-1000ms | — | — | — |

Per-mode cache isolation: each mode (plan / analyze / swap / refine / coach-chat) has its own Anthropic cache entry. Running analyze does NOT warm plan-gen and vice versa. The daily Vercel cron (`0 9 * * *`) keeps the Fluid Compute instance hot for ~15-45 min after the ping but does NOT touch the Anthropic prompt cache — see ROADMAP "GitHub Actions warmup workflow" for the deferred two-layer plan to fix that.

Server-side timing logs at phase boundaries (`[generate-plan] data fetch: X ms`, `[generate-plan] prompt build: X ms`, `[generate-plan] claude call: X ms · usage: {...}`) show up in `vercel dev` terminal and Vercel Production logs. The mode tag (`[generate-plan:swap]`, `[generate-plan:analyze]`, `[generate-plan:refine]`, `[coach-chat]`) disambiguates the call path.

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
- **Hydration cache (v2.4.0).** localStorage-backed snapshot painted synchronously on cold-paint via `paintFromCache()` IIFE in `app.js` BEFORE any network call. Saves running session timer + logged sets visible at 0ms on warm boot. Schema-versioned (`HYDRATION_SCHEMA_VERSION = 1`); 7d age gate; today-state restore additionally gated on `savedAt >= today's local midnight` so yesterday's stale cache doesn't shadow this-week historicals (v2.4.17 fix). Cleared on sign-out + on user-id mismatch + on plan-404 (cache-cached plan deleted on another device).
- **Side-channel queries pattern (Edge Functions).** Server-side, every Claude call path adds two non-fatal queries beyond the core data fetch: `fetchCoachingProfile` (CLIENT PROFILE block) + `fetchRecentCoachHistory` (RECENT COACHING CONVERSATIONS block). Both run in parallel inside the existing `Promise.all`; failures return null/empty and the main call proceeds with fallback content. Future "context augmentation" features should follow this same pattern (parallel fetch + non-fatal + fallback content).
- **Cardio detection via library lookup.** `isCardioExerciseName(name)` checks `exerciseLibraryByName[normName(name)].muscle_group === 'cardio'`. Single source of truth — no redundant `type` field on plan JSON. `renderSetRow`'s `isCardio` flag is computed at the caller (4 sites) and passed through. When cardio, the row renders DURATION + DIST inputs instead of weight + reps; `fmtP` detects `prescribed.duration_seconds != null` to format prescriptions as `30:00, 0.5mi`.
- **Drop set state model (v2.5.11).** Each set object in `todayState.exercises[ei].sets[]` has optional `setType: 'drop'` + `parentSetIdx` (array index of the parent in the same exercise). + Drop Set always attaches to the LAST set; chained drops become siblings of each other (same parent). Cascade-on-parent-done (in `_toggleSetCommit`) walks the array and marks all entries with `setType==='drop' AND parentSetIdx===si` done. Auto-fill from prescribed runs per child against its own `plan.sets[ci]` entry. Prescribed drops in plan JSON use a flat `set_type: 'drop'` field on individual entries (NOT a nested `drop_sets` array) so plan and in-memory indices align.
- **Iterative plan refinement (v2.5.3).** Refine mode (`/api/generate-plan { mode: 'refine' }`) takes `current_plan` + `iteration_history: [{plan, feedback}]` + `new_feedback` and reconstructs the multi-turn conversation server-side. Each subsequent assistant turn carries `cache_control` so iter N+1 reuses iter N's prefix. Frontend tracks `iterationHistory` + `generatedChangeNotes`. Pattern reusable for any future iterative-prompt feature (e.g., "regenerate with adjustments" on the analyze flow).
- **Resume-session prompt (v2.4.18).** Adding work to a session marked `endedAt` triggers a one-shot modal asking whether to resume the timer first. Three options: Resume timer (calls `resumeSession` then runs the action), Just log it (sets a per-session suppress flag), Cancel. Suppress flag clears on explicit Resume. The flow is gated via `promptResumeIfEnded(actionFn)` — wrap any new "user is logging more work" entry point in this helper.
- **Coach Chat panel + persistent history.** Floating chat fab opens a bottom-sheet panel. On open, loads last 2 weeks of `coach_messages` (5-min in-memory cache). Past-session messages render at 0.65 opacity with date headers and context badges (`[swap: Cable Row]`, `[plan]`); current-session messages render at full opacity, no header. The frontend dedupes the live messages array against the loaded history via `(role, content)` match so the same exchange doesn't render twice. Coach prompts are persistent + injected into ALL Claude calls (not just chat) — see DECISIONS.md and the v2.4.x ROADMAP entry.
- **Rest timer floating pill (v2.5.9).** Was a centered modal blocking the whole app while resting. Now a bottom-center horizontal pill (`[-15s] [1:30] [+15s] [Skip]`) at z-index 200; the app stays interactive during rest. Backdrop overlay element kept in DOM but forced `display: none` regardless of any `.show` class.
- **Carry-forward set values (v2.5.10).** + Add Set inherits weight + reps (or duration + distance for cardio) from the most-recent populated set in the same exercise. New set still has `done = false`. Apply this carry-forward pattern when designing any new "stack another similar entry" affordance.
- **No-plan state as a first-class surface (v3.0.0).** The user can intentionally end an active plan via the Plans modal "End plan" button without replacing it. `endActivePlan` (data.js) flips `is_active = false`, clears plan-anchored in-memory state, refreshes coach context, and clears the hydration snapshot. The empty state (`#emptyState`) is no longer the v1 "Tap Import" relic — it is rendered by `renderEmptyState` (ui.js) with three CTAs (Generate / Use a template / Blank session), a View full History link, and a list of the 5 most recent workouts (`fetchRecentWorkouts(userId, 5)`) opening into the existing History detail modal. The day-picker dropdown shows a "No active plan or session" placeholder option when neither plan-days nor today's ad-hocs are available. The start-screen overlay no longer auto-opens or hides its close button in the no-plan branch — the empty state is the always-available fallback. Hydrate's no-plan branch loads `loadExerciseLibrary` (await) + `loadLocations` (background) before rendering, so History detail of ad-hoc and deactivated-plan workouts resolves names + gym tags via `exerciseLibraryById` / `locationById`. End is fully reversible via the existing `activateExistingPlan` round-trip; no schema changes.
- **Superset block model (v3.4.0).** Plan JSON gains an optional block container `{superset:true, rest:int, exercises:[...]}` alongside regular exercises in `day.exercises[]`. Members are full exercise objects (their own `name`, `sets`, optional `note`); only the block carries `rest`. Workout-level structure persists in `workouts.superset_groups jsonb` (`[{exercise_orders:[int,...], rest:int}, ...]`) — decoupled from `plan.data` so history detail renders correctly even after plan deactivation, deletion, or post-workout structural mutations. `stateFromWorkout` derives `state.exercises[ek].supersetGroup: 'g0'|'g1'|null` and `.supersetRest` from the column. Renderers walk runs (`groupRunsForRender(planDayExercises, stateExercises)`) and emit blocks via `renderSupersetBlock`; standalone runs go through the same per-exercise card helper with `badgeLabel = null`. Mid-session merge / separate via the ⟷ chain-link icon mutates `plan.data` (plan-day path, persisted via `plans.update`) or `workouts.superset_groups` (ad-hoc path) and mirrors to in-memory state via `_restateFromSupersetGroups`. Round indicator: `min(completed-set-count)` across members + 1, clamped to `max-set-count`. Rest timer fires only on the last-of-round done-tap (gated by `shouldFireRestForBlockMember`). Drop sets inside a member work unchanged because the cascade walks the member's local sets array. Flat-vs-nested resolution: `_flatEiToPlanMember(dayPlan, ei)` walks the nested plan structure (block entries expand into members) and returns the prescribed exercise at flat ei — used by the rest-timer prescription lookup and drop-set cascade auto-fill. Day-level drag-to-reorder of a whole block is deferred; per-block member reorder uses a unique `data-sort-zone="superset-<groupKey>"` SortableJS group so cross-block drops are rejected.

## Testing & deployment

- **No automated test framework.** Every feature is verified manually via the "browser smoke test" checklists in `docs/superpowers/specs/`.
- **Every visible change bumps `APP_VERSION`** (in `js/app.js`). Displayed in the bottom-right footer so stale-cache issues are trivial to diagnose ("which version am I on?").
- **Commits** are small and focused; migration + code can bundle in a single commit when the code requires the migration to function.
- **Pushes require explicit user approval.** See the workflow feedback memory.
- **Migrations are forward-only.** Never edit an applied migration; always write a new timestamped file in `supabase/migrations/`. The client applies them manually via the Supabase dashboard or CLI.

## Refactor history

- **Pre-refactor (v2.0.14 and earlier):** single `index.html` with ~3,100 lines of JS inline. File grew from ~2,000 lines at start of Session A to 4,421 lines by the time gym profiles + rest-timer fix landed.
- **The JS split (2026-04-19, post-v2.0.14):** split inline JS into the 5 files described above. No logic changes — `sed` extractions with a single bug (one missing closing brace, caught by `node --check` before any other testing).
- **Session B (2026-04-20, v2.0.19 – v2.0.25):** added weekly History browser, physique photos + storage, AI plan generator Edge Function + inputs UI + Plans management modal. ~1400 new lines in `ui.js`, ~600 in `data.js`, plus 500 lines of new server-side code in `api/generate-plan.js`. Added `system-prompt.md`, `vercel.json`, `package.json`, and one Supabase migration.
- **v2.1 – v2.3 milestones (2026-04-20 – 2026-04-21):** plan templates + AI exercise swap (v2.1.0), Coach Chat with `api/coach-chat.js` and Haiku 4.5 (v2.2.0), structured per-session substitutions schema (`prescribed_exercise_id`, v2.2.1), session lifecycle recovery (v2.2.2), drag-to-reorder via SortableJS (v2.2.5), three-way prompt split — `system-prompt-{core,plan,analyze}.md` — and analyze mode (v2.3.0). Schema grew with `is_template`+`template_name`, `prescribed_exercise_id`, the partial unique index on done sets, and the locations table.
- **v2.4.x (2026-04-21 – 2026-04-22):** hydration cache for fast warm boot (v2.4.0; localStorage-backed snapshot, schema-versioned, 7d age gate); Resume-Session prompt for add-while-ended (v2.4.18); persistent Coach chat history end-to-end across 4 commits — `coach_messages` table + frontend logging + Edge Function side-channel injection + chat panel display (v2.4.19 – v2.4.22). v2.4 added a bunch of UX hardening fixes for ad-hoc dedup, template-mid-session add, rest-timer auto-start, etc.
- **v2.5.x (2026-04-23 – 2026-05-01):** adaptive coaching profile end-to-end — `coaching_profile` jsonb table + Coaching Profile modal + Edge Function injection across all four call paths (v2.5.0 – v2.5.1); Option C analyze-time profile_updates (v2.5.2); iterative plan refinement with `mode: 'refine'` and multi-turn cache_control (v2.5.3 – v2.5.4); hydrate parallelization + deferred phase 2 (v2.5.5); start-screen Generate path (v2.5.6); Cardio Phase 1 (v2.5.7 – v2.5.8; new `duration_seconds` + `distance` columns + 5 new seed rows + cardio set-row UI branch + system-prompt CARDIO PRESCRIPTION section); rest timer floating pill (v2.5.9); + Add Set carry-forward (v2.5.10); Drop Sets Phase 1 (v2.5.11 – v2.5.12; new `set_type` + `parent_set_id` columns + UI + cascade-on-done + flat `set_type: 'drop'` plan format + AI prescription).
- **v3.0.0 – v3.0.3 (2026-05-02):** no-plan state becomes a first-class surface. New "End plan" button in the Plans modal flips `is_active = false` without replacing; new `endActivePlan` (data.js) + `fetchRecentWorkouts` (data.js) + `renderEmptyState` / `renderEmptyStateRecent` (ui.js); refreshed `#emptyState` markup with Generate / Use a template / Blank session CTAs + View full History link + 5-most-recent Recent workouts list. Day-picker dropdown shows a "No active plan or session" placeholder option when empty. Start-screen overlay no longer auto-opens or hides its close button in the no-plan branch. Hydrate's no-plan branch mirrors plan-hydrate Phase 1: parallel-loads today's ad-hocs + `exerciseLibraryById` + `locations` and applies a focus hierarchy. v3.0.2 also auto-opens the start-screen when a focused ad-hoc lands in no-plan state. v3.0.3 adds editable history detail (per-set values, RPE, notes via `historyUpdateSetField` / `historyUpdateExerciseRpe` / `historyUpdateExerciseNote` / `historyUpdateWorkoutNotes`).
- **v3.1.0 (2026-05-02):** per-workout weight-mode toggle. New nullable `sets.weight_mode` column lets a placement override the library default (e.g., Hammer Strength Incline plate-loaded at gym A vs cable-driven at gym B). Tappable chip on each card; `setExerciseWeightMode` fan-out keys on `(workout_id, exercise_order)`; volume math, prescription hints, and CSV/JSON export respect the override via `effectiveWeightMode(set, exerciseMeta)`. New sets inherit the override on `+ Add Set` / `+ Drop Set`.
- **v3.2.0 – v3.2.1 (2026-05-03):** per-user AI model selection. Three dropdowns in the Coaching Profile screen (Coach / Plan flows / Analyze) persist into `coaching_profile.data` (`model_coach` / `model_plan` / `model_analyze`). Server validates against an allowlist (`api/_models.js` + `js/models.js`); falls back to bucket default on miss with a `console.warn`. v3.2.1 patches `temperature` (and `top_p` / `top_k` / `thinking`) gating for Opus 4.7 — those params return `400 invalid_request_error` on extended-thinking-aware models, so a `supportsTemperature` flag conditionally spreads the param across all 5 Anthropic POST sites.
- **v3.3.0 (2026-05-03):** cold-start plan generation. Plan-mode no longer requires an active plan or non-empty history; `formatCurrentPlan` is null-guarded; `buildUserMessage` injects a `COLD START` marker when both are absent so Claude builds a first plan from CLIENT PROFILE + USER INPUTS only. Analyze keeps its no-history bail with a clearer message that names the chosen window. Refine and Swap remain plan-anchored.
- **v3.4.0 (2026-05-04):** first-class supersets across plan generation, mid-session interaction, and history rendering. New optional **block container** in plan JSON (`{superset:true, rest, exercises:[...]}` alongside regular exercises in `day.exercises[]`). New `workouts.superset_groups jsonb` column — workout-level structure persists independently of plan.data so history survives plan changes / deactivation. Mid-session pairing via the chain-link (⟷) icon in card headers; merge / separate / +Add round / per-block drag-to-reorder all wired. AI prescribes opportunistically per a new `## SUPERSETS` section in `system-prompt-plan.md` (antagonist pairs, accessory finishers, time-constrained sessions; avoids heavy-compound pairs and beginner cardio mixes). Drop sets inside members work unchanged because the cascade walks the member's local sets array. Day-level block-as-unit drag-reorder deferred — workaround: unpair → reorder → repair. New helpers: `applySupersetMerge` / `applySupersetSeparate` / `applySupersetReorderMembers` / `addRoundToBlockMembers` / `_resolveFlatEi` / `_flatEiToPlanMember` / `_restateFromSupersetGroups` / `shouldFireRestForBlockMember` / `supersetGroupsFromPlanDay` (data.js); `groupRunsForRender` / `renderSupersetBlock` / `countDoneSets` / `renderPlanDayExerciseCard` / `renderPlanDayExtraCard` / `renderAdHocExerciseCard` / `renderHistoryExerciseCard` / `openSupersetPicker` / `onMergeIntoSuperset` / `onRemoveFromSuperset` / `onMemberReordered` (ui.js). Coach Chat (`_formatPlanForCoach`, `getLiveContext`) and the AI prompt helpers (`formatCurrentPlan`) walk blocks and tag members with `(superset)`.

End of v3.4.0: ~14,140 total lines across `js/*` + `api/*` (vs ~4,500 at end of Session B). Most growth is in `js/ui.js` (renderers + many new modal flows + per-block sort zones) and `js/data.js` (the v3 milestone helpers — superset block management, weight-mode fan-out, history-edit helpers, model resolvers).

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
