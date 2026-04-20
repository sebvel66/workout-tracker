# Decisions

Running log of architecture/behavior decisions for the workout tracker. Newest first.

## 2026-04-20 — AI plan generation: Vercel Node function + raw fetch + file-based system prompt

Session B shipped an AI plan generator that reads 4 weeks of training history + physique photos and emits a full week's plan via Claude Sonnet 4.6. The architecture hit several forks worth recording:

**Vercel Node runtime, not Edge runtime.** The Claude Sonnet call takes 22-45s and may return 4-16K tokens; Edge runtime's shorter timeouts and streaming-first model don't fit. Node runtime gives us full `fs` (for loading the system prompt), longer `maxDuration` (60s on Hobby, 300s on Pro), and standard Anthropic SDK compatibility. Declared via `export const maxDuration = 60` in the function.

**Raw `fetch` for both Supabase PostgREST and Anthropic.** No npm dependencies. Keeps the repo structure flat (the frontend has no build step; adding one just for the serverless function would have been disproportionate). If we ever need SDK niceties (retries, typed responses), that's a future refactor — easy to swap `fetch` for `@anthropic-ai/sdk` or `@supabase/supabase-js` without changing the surface.

**System prompt lives in a versioned file at repo root** ([system-prompt.md](system-prompt.md)). Bundled into the function via `vercel.json` `includeFiles: "system-prompt.md"`, loaded once via `fs.readFileSync` at module cold start. Why this shape rather than an env var, DB row, or inline string:
- **Git diffs are the primary iteration surface.** The prompt gets tuned often; diff-able history is high-value for attributing behavior regressions to specific revisions.
- **No build step needed.** Reading a file at cold start is simpler than packaging the prompt into the JS bundle.
- **Editable in VS Code.** No need to log into a dashboard or write a migration for prompt tweaks.
- **Future path: an admin UI + DB row** if the prompt ever needs runtime edits by non-developers. Easy migration when justified; not justified now.

**`vercel dev` gotcha:** the prompt is read at cold start, so editing the file requires killing and restarting `vercel dev`. Old content stays in memory otherwise, and Anthropic keeps hitting the stale cache entry.

**Service-role key for all DB queries from the function.** Bypasses RLS (safe, because the user-id filter is applied in code alongside JWT verification). The JWT is verified against `/auth/v1/user` at the start of each request; the returned `user.id` is used as the filter in every downstream query as defense in depth. Never expose the service-role key in any file served to the browser.

**How to apply:**
- Any new server-side function should follow the same pattern: Node runtime, raw `fetch`, env vars for secrets, JWT verification first, then service-role-scoped queries with explicit `user_id` filters.
- Prompt tuning workflow: edit `system-prompt.md` → `vercel dev` restart → test via console fetch script (see `MAJOR-BUGS.md` for the template) → commit → `git push` triggers auto-deploy.

## 2026-04-20 — Prompt caching with two 1h breakpoints: system + exercise library

Anthropic's prompt caching with `cache_control: { type: "ephemeral", ttl: "1h" }` cuts per-call input cost ~90% on cache hits and shaves time-to-first-token. Our two breakpoints:

1. **System prompt** (`system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }]`) — ~1500 tokens, rarely changes (only on `system-prompt.md` edits).
2. **Exercise library** — first content block of the user message, ~3500-4000 tokens. Rarely changes (only when user adds custom exercises).

Cache prefix = system + library = ~8500 tokens, read as `cache_read_input_tokens` on hits. Render order is `tools → system → messages`, so the breakpoint on the library block captures both system and library together.

**Dynamic content (current plan, workout history, photos, user inputs) lives AFTER the library breakpoint** and is re-processed fresh each call. Cheap — only ~5000 tokens of dynText per call.

**1h TTL verified honored.** Usage responses show `cache_creation.ephemeral_1h_input_tokens` populated on miss, zero on hit. Earlier concern that we needed a beta header turned out to be unfounded — the `ttl: "1h"` parameter works without it for now.

**What invalidates the cache:**
- Editing `system-prompt.md` (even whitespace changes).
- User adding a custom exercise to the library.
- Switching models (caches are model-scoped).

**Why 1h (not 5m default):** weekly use case. User generates plans every ~7 days; 5m would mean nearly every call is a cache miss. 1h still misses most of the time but hits during active development and when the user regenerates within a session (e.g., after tweaking inputs).

**How to apply:**
- Any future prompt that has a stable prefix should use the same 2-breakpoint pattern: `cache_control` on the last static system-level content, another on the first user-message block.
- When editing `system-prompt.md`, expect the first call after deploy/restart to be a cache miss (~35-45s write). Subsequent calls within 1h hit cache (~22-30s).
- Never invalidate cache mid-conversation intentionally. If adding a rule, add it to the cached prefix; if signaling per-call state, put it in dynText.

## 2026-04-20 — `repeat: N` shorthand for identical sets; server expansion

Claude Sonnet at ~70-90 tok/s generates 30s of output for a typical 5-day plan (~105 sets). A naïve plan JSON has identical set objects repeated 3-4× per exercise:

```json
"sets": [
  {"weight": 70, "reps_target": 10, "reps_range": "8-10"},
  {"weight": 70, "reps_target": 10, "reps_range": "8-10"},
  {"weight": 70, "reps_target": 10, "reps_range": "8-10"}
]
```

Those duplicates cost ~50 tokens each. With ~30 exercises having identical sets, that's ~1500 wasted output tokens = ~20s of unnecessary generation time.

**Chosen shape — wire-format shorthand, server-expanded:**

Claude emits a single set object with `"repeat": 3` when all sets of an exercise share identical `weight`, `reps_target`, and `reps_range`:

```json
"sets": [{"weight": 70, "reps_target": 10, "reps_range": "8-10", "repeat": 3}]
```

The Edge Function's `expandSetRepeats(plan)` unrolls `repeat: N` into N identical objects (stripping the `repeat` field) before returning to the frontend. Frontend contract is unchanged — it always sees the full-length sets array. Clamps N to `[1, 10]` as a defense against model hallucinations (e.g., `repeat: 9999`).

**Why server expansion rather than frontend expansion:**
- Keeps the client contract identical to plan imports from files — no special-case code.
- Keeps the plan blob in `plans.data` in the canonical fully-expanded shape, so every consumer (export, History browser, re-generation) sees the same structure.
- Fails closed: if Claude emits malformed `repeat` (string, negative, non-numeric), the server normalizes to safe defaults rather than the frontend having to guard.

**Output token impact:** measured ~60% fewer tokens in the sets arrays. Combined with other tightening (word caps on notes, omit unit field, omit decorative `duration`/`sets_total`), total output dropped from 7000-8000 tokens pre-optimization to 1500-2500 tokens post.

**How to apply:**
- Any future structured-output feature where the model emits repetitive content should consider the same shorthand-then-expand pattern. Trade: Claude emits less, server code expands — small server cost, big output savings.
- `expandSetRepeats` lives in the Edge Function because the shorthand is purely a wire-format optimization. If we ever move to client-direct Anthropic calls (we won't — no service-role key in browser), the expansion would need to move too.

## 2026-04-20 — USER INPUTS handling: rules cached in system prompt, data flows in dynText

The Generate Plan flow's inputs form (start date / target duration / notes) creates a design tension: the per-call user inputs need to flow to Claude, but *how to interpret them* shouldn't change per-call (and shouldn't break the prompt cache).

**Chosen split:**

- **Cached system prompt** contains the USER INPUTS handling rules: defaults (Sunday-after-today, 60 min, no special considerations), priority ("user inputs override generic guidance"), and the anti-over-reasoning directive ("Do NOT spend reasoning effort reconciling inputs with other prompt sections").
- **Per-request dynText** contains the actual values as a `USER INPUTS FOR THIS WEEK` section — just the literal data, no interpretation guidance.

**Why:** Claude sees the rules once at cache write, then reads them cached on every call. Zero per-request reasoning overhead for the common case. If inputs are absent, the section is simply omitted from dynText and Claude applies the cached defaults.

**The anti-pattern that burned us (see [MAJOR-BUGS.md](MAJOR-BUGS.md) 2026-04-20):** a single instructional sentence in dynText — "Respect any user inputs above when programming — adjust volume, intensity, or exercise selection as needed" — caused Claude to spend ~1000 extra output tokens on input-reconciliation reasoning, pushing latency past the 55s timeout on Anthropic slow-response days. Removing it dropped output 40% and latency 6-10s. The lesson: *runtime rules belong in the cached prefix, never in per-request dynText*.

**How to apply:**
- Any future user-input channel (chat questions, mid-week adjustments, etc.) should follow the same split. Handling rules → system prompt. Data → user message.
- If a rule needs to be conditional on input presence, express it in the cached prompt with explicit "if present, do X; if absent, default to Y" — not in the per-request message.
- Resist the urge to add "think carefully about X" directives, even for edge cases. They compound latency without meaningfully improving output quality.

## 2026-04-20 — Physique photos: private bucket + path-prefix RLS + signed URLs

Photos feed the AI planner as multimodal image blocks. Storage needs:
1. Access scoped to the owner (no cross-user exposure).
2. No stable public URLs (photos are personal; we don't want indexable links).
3. Deletable when the user deletes a photo.

**Chosen shape:**
- **Private Supabase Storage bucket** (`physique-photos`, `public = false`). No direct URL access — every render requires a signed URL.
- **Path prefix = `{user_id}/{uuid}.{ext}`.** Storage RLS policies (`physique_photos_select_own`, `_insert_own`, `_delete_own`) key on `storage.foldername(name)[1] = auth.uid()::text`. A user can only touch files under their own prefix, even with the anon key.
- **`physique_photos` metadata table** tracks `storage_path`, `photo_type` (`goal` | `progress`), `taken_at`, `notes`. Indexed on `(user_id, photo_type, taken_at desc)` for efficient "latest goal" and "most recent progress" queries.
- **Client renders via time-limited signed URLs** (`sb.storage.from('physique-photos').createSignedUrl(path, 3600)`), cached in memory by path. Signed URL TTL 1h matches typical session length; re-sign on demand when cache expires.

**Why `storage_path` and not `photo_url`:** private buckets have no stable URL. Storing a signed URL in the DB would embed the expiry into data and require constant re-generation. Storing the path lets the client re-sign as needed.

**Upload flow rollback-on-failure:** if the storage upload succeeds but the metadata row insert fails, the orphaned storage file is removed best-effort. If the storage remove fails, we accept a temporary orphan rather than blocking the user on retries.

**Delete flow ordering:** storage first, then metadata row. If storage succeeds but row delete fails, the render path treats the dangling row as a broken thumbnail (user can delete again). If storage fails, the row stays and user retries.

**Feeds the AI planner:** Edge Function downloads the latest goal + latest progress photo, base64-encodes, and includes as `image` content blocks in the Claude call. No compression — photos are ~1-4 MB each, adds a few seconds to the prompt-build phase. Cost impact ~1-2K tokens per image; negligible at our volume.

## 2026-04-20 — Plan start_date client-side stamping + render-time self-heal

Plans need a calendar anchor so the AI planner can reason about phase awareness ("weeks until the July cut"), and so the tracker header's week label matches the History browser's Sun-Sat labels.

**Chosen:**
- **`savePlanAsActive` stamps `plan.start_date = sessionTodayDateString()`** at save time (client-side, no migration). Preserves an explicit start_date if one was set upstream (e.g., user's form input overrides auto-stamp on Accept).
- **`plan.week` is computed from `start_date` at save time** via `planWeekLabel(plan)` (Sun-Sat formatted via `formatWeekLabel`). Overrides whatever string Claude emitted for `week`. Single source of truth: `start_date`.
- **Render-time self-heal via `ensureStartDate(planBlob, dbRow)`:** plans saved before the stamping feature shipped have no `start_date` in their JSON blob. At hydrate and on plan activation, we inject `dbRow.created_at.slice(0, 10)` as a client-side `start_date` fallback. The blob carries the injected value only in memory — persisted on next save.

**Why client-side stamping and not a schema column:** `plans.data` is already a `jsonb` blob with no per-field schema enforcement. Adding a top-level `plans.start_date` column would require a migration and dual-source-of-truth (blob + column), with risk of divergence. Stamping into the blob at save time is forward-compatible with any future schema evolution.

**Why `savePlanAsActive` recomputes `plan.week` from `start_date` rather than trusting Claude:** Claude's emitted `week` string varies in shape ("Week 5", "Week of Apr 26", "Apr 20-24, 2026" — none matching the History browser's Sun-Sat format). Normalizing server-side guarantees the tracker header and History browser always agree.

**`activateExistingPlan` ≠ `savePlanAsActive`:** activating an existing plan via the Plans modal flips `is_active` without writing a new row. Does NOT re-stamp `start_date` (the plan's original date is preserved). Does NOT re-normalize `plan.week` (no re-save).

## 2026-04-20 — Weekly History uses Sunday-Saturday; fetchWeekSummary is the shared primitive

The Weekly History browser and the AI planner Edge Function both need "one week of training data" with per-workout aggregates (volume respecting weight_mode, prescribed-vs-actual counts, skipped-exercise detection). Built once, reused.

**Chosen:**
- **Sunday-to-Saturday week boundaries**, computed client-side via `weekStartForLocalDate` (from `data.js`). Matches the athlete's Sun-Thu training rotation with weekend rest days.
- **`fetchWeekSummary(userId, weekStart, weekEnd)`** in `js/data.js` — takes inclusive YYYY-MM-DD calendar dates, returns a structured object with per-workout detail + week-level aggregates.
- **Calendar-bounded via `workouts.performed_on`** (date column, NOT NULL). No client-side timezone math — the DB's `performed_on` is already the user's local date at the time of insert.
- **Volume respects `weight_mode`:** `per_side` × 2, `bodyweight` uses added load only (never estimates body weight), `none` = 0.
- **Plan workouts track prescribed-vs-completed ratios;** ad-hoc workouts track logged-vs-done. `totalSets` / `completedSets` semantics differ between the two.

**Why not a single shared implementation across client and server:** the client version lives in `data.js` and uses the Supabase JS client; the server version in `api/generate-plan.js` uses raw PostgREST fetch. Same shape of output, different plumbing. Keeping them parallel rather than unifying avoids cross-runtime dependencies (browser vs Node) and lets each side optimize for its environment. If drift becomes a problem, one option is to extract a shared utility module — deferred.

**How to apply:**
- Any future analytics surface (progression charts, PR detection) should build on `fetchWeekSummary` rather than re-implementing set aggregation. The weight_mode handling is subtle and easy to get wrong.
- If the user ever wants Mon-Sun weeks or ISO weeks, it's a one-line change in `weekStartForLocalDate`. Don't sprinkle week-boundary logic elsewhere.

## 2026-04-20 — 55s AbortController timeout + cancel UI for long LLM calls

Vercel Hobby caps serverless functions at 60s. Sonnet generation can take 25-45s on cache hits, occasionally longer on Anthropic slow-response days. Without a client-side timeout, a stuck upstream surfaces as an infinite spinner.

**Chosen:**
- **Server-side** (`api/generate-plan.js`): `AbortController` with `setTimeout(() => abort(), 55000)` scoped per request, signal passed to the Anthropic fetch. On abort, we return a clean `504: AI service timed out (55s). Try again — cache should be warm on the next call.`
- **Client-side** (`ui.js`): separate `AbortController` scoped to each UI request, signal passed to our `fetch('/api/generate-plan')`. Cancel button in the loading view aborts it. Closing the modal via × or overlay-click during an in-flight fetch also aborts.
- **55s chosen deliberately:** sits just under the 60s Vercel Hobby cap, giving us time to return a clean error envelope before Vercel hard-kills the function.

**Why not streaming:** streaming would cut time-to-first-byte but doesn't help when the total generation still exceeds 60s (Vercel still kills the function at the cap). Streaming JSON is also fragile — a truncated JSON from a forced cut is unparseable. Cleaner to fail fast with a specific error and let the user retry (cache should be warm on the next call).

**Cancel semantics:** clicking Cancel during loading *aborts the in-flight fetch* (not just hide the modal). The previous buggy version set `generateInFlight = false` on close without aborting, which caused orphaned requests + double-fetch on re-open.

**How to apply:**
- Any future LLM or long-running API call from this app needs the same two-layer timeout: server-side with a buffer under the platform cap, client-side with a Cancel UI.
- If we ever move to Vercel Pro (300s cap), bump the server timeout to ~270s — still leaves room for a clean error envelope.

## 2026-04-19 — Explicit session-start modal replaces silent day-of-focus default

Before `v2.0.16`, hydrate silently chose which tab to focus: lowest-index plan day with a today-state, else Day 0, else the first ad-hoc. No choice point, no concept of "which day am I actually training today." This mapped poorly to the real-world case where the user's calendar doesn't match the plan's rotation (skipped rest day, travel week, rearranged split). It also meant a user with no active plan had nowhere to begin — the tab strip only rendered when a plan existed.

**Chosen:** a bottom-sheet modal on hydrate whenever no session is in-progress. Three paths:

1. **Suggested day** — `(lastCompletedDayIndex + 1) mod plan.days.length`, computed once per hydrate by `loadSuggestedDayIndex()` via one SELECT on `workouts` filtered to `plan_id = active AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`. First-ever session → Day 0.
2. **Pick a different day** — in-place expanding list of all plan days with badges (`in progress`, `completed today`).
3. **Blank session** — existing `createAdHocSession()`; no plan dependency, so this is also the only path in the no-active-plan state.

**Why this shape:**

- **Modal, not full-screen takeover.** Reuses the existing `.modal-overlay` pattern (History, Hamburger, Gym Profiles, etc.), so zero new CSS primitives and the hydrate render flow is unchanged — the session view still renders beneath, the modal overlays.
- **Rotation+1, not day-of-week.** Day-of-week mapping would re-introduce exactly the calendar-rigidity the modal is trying to break. Rotation+1 honors "the plan is the rotation, not the calendar" — skip Tuesday, come back Wednesday, still suggest the next plan day.
- **In-progress sessions skip the modal.** Modal is the *start* experience; once you're mid-workout, reloads should drop you straight back into the session. The focus hierarchy (v2.0.16) also promotes an in-progress session above lowest-day-index, so a user who completed Day 2 and started Day 3 today lands on Day 3 on reload instead of Day 2.
- **"Start another workout" hamburger item is always available.** Covers the second-session-same-day and the "I changed my mind mid-session but haven't logged anything yet" cases with a single trigger.
- **No schema changes.** One SELECT added to hydrate, everything else composes from existing tables.

**How to apply:**

- Any feature that wants to insert a new session-start path should add a fourth card to the modal rather than introducing a new entry point. The modal is the canonical "which workout am I doing" surface.
- Do not re-introduce day-of-week auto-selection. If the user wants the modal to remember a different default, that's a preference setting, not a silent heuristic.
- The "+ New Session" standalone button has been removed as redundant — "Blank session" (Path 3) is the canonical ad-hoc entry. Don't re-add a shortcut button for ad-hoc.

Design: [docs/superpowers/specs/2026-04-19-flexible-session-start-design.md](docs/superpowers/specs/2026-04-19-flexible-session-start-design.md).

## 2026-04-19 — Partial unique index on `sets (workout_id, exercise_id, exercise_order, set_order) where done = true`

The v1 schema indexed `sets (workout_id, exercise_order, set_order)` for in-session ordered reads but did not make the combination unique. This let a historical-data import script (Fitbod CSV pasted into the Supabase SQL Editor) re-run end-to-end and silently double-insert ~1107 set rows across ~22 workouts, surfacing as doubled entries in the per-exercise View Recent modal (see `MAJOR-BUGS.md` for the full incident write-up).

**Chosen shape:**

```sql
create unique index sets_unique_position_per_workout
  on sets (workout_id, exercise_id, exercise_order, set_order)
  where done = true;
```

**Why this exact shape rather than a full unique index:**

- `done = true` partial: leaves room for non-done placeholder or transient rows (if ever introduced — e.g. an auto-save that pre-creates rows before the checkbox flips) without failing the constraint. Only finalized/history rows are constrained.
- Includes `exercise_id` in the key: the partial workout-uniqueness index (from 2026-04-16) is `(user_id, plan_id, day_index, performed_on)` — it guards against duplicate *workouts*. This index is the complementary set-level guard. Including `exercise_id` handles the case where a client or import assigns identical `(exercise_order, set_order)` to rows that genuinely belong to different exercises (unlikely in the current app but defensive for bulk inserts).
- Chosen over application-level dedup: the actual incident was an external SQL Editor script, not client code, so only a DB-level constraint could have prevented it.

**How to apply:**

- Any future SQL import / bulk insert that re-runs will now 23505 instead of silently double-inserting. Scripts should `ON CONFLICT DO NOTHING` if idempotent re-runs are expected.
- Client-side `persistSet` already handles one-row-at-a-time and will never trip the constraint under normal tap-done flow. The `update` / `insert` branches in [persistSet](js/data.js) don't need changes.
- Migration file is forward-only: `supabase/migrations/20260419010000_sets_unique_position.sql`. Must be dedup'd first (any pre-existing duplicates will block creation).

## 2026-04-19 — Timers use wall-clock deadlines, not counters. Notification API rejected for rest timer.

All time-sensitive UI in this app must be **wall-clock anchored** rather than counter-based. The session timer already does this (`sessionElapsedMs = Date.now() - startedAt - pausedMs`); the rest timer was the outlier until `v2.0.14` — it counted down a `restSeconds` variable via `setInterval(..., 1000)`, and iOS suspended the interval when the PWA lost focus, freezing the timer mid-rest.

**The rule:** any countdown or elapsed display stores `targetMs` (deadline) or `startedAt` (start time) as an absolute `Date.now()` value. The re-render interval just reads `Date.now()` each tick and computes remaining/elapsed. `visibilitychange → visible` handlers catch up on any state that a backgrounded tick missed (e.g. the deadline passed, fire the completion path now).

**Notification API was considered and rejected** for the rest timer. On iOS PWAs:
- `new Notification(...)` only fires when the calling JS is actually running.
- iOS suspends backgrounded PWA JavaScript, so `setTimeout(notify, remainingMs)` won't fire at the deadline.
- Reliable background notifications require a service worker + Web Push (server-scheduled). That's a feature-of-its-own-scale and not warranted by a rest-timer fix.
- On `visibilitychange → visible` after a backgrounded expiration, we could call `new Notification(...)` — but by then the user is already looking at the app, and the vibrate + beep + UI dismissal are already firing. The notification adds nothing beyond a stale unread marker in Notification Center.

**How to apply:**
- If a new feature wants "tell the user something happened while they were away," it's out of scope until we take on a service-worker project. Design around the user returning to the app, not around pushing into their notification center.
- Wake Lock (`navigator.wakeLock.request('screen')`) is a valid orthogonal improvement for foreground flows (keeps the screen on during rest). Not shipped yet; revisit if screen-sleep during rest becomes annoying.

## 2026-04-19 — Gym profiles: `pendingLocationId` sentinel for pre-workout selection

The gym-profiles feature lets a user pick a gym **before** any set is logged — specifically on a plan-day tab where the `workouts` row doesn't exist yet (lazy-created on first set-done or notes-blur via `ensureWorkout`). Three states needed to be distinguishable at render and write time:

1. **User hasn't touched the dropdown** — the UI should default to `recentLocationId` (the last workout with a location tagged), and `ensureWorkout` should persist that default on INSERT.
2. **User explicitly picked "— No gym"** — the UI should show "— No gym" sticky, and `ensureWorkout` should persist `null`, not fall back to `recentLocationId`.
3. **User picked a specific gym** — UI shows it, `ensureWorkout` persists that UUID.

**Chosen encoding:** `state.pendingLocationId`, sitting alongside `state.locationId` on the workout state object. `undefined` = case 1, `null` = case 2, a UUID = case 3. `getOrInitToday` does **not** initialize this field (keeps it `undefined` by default); `persistWorkoutLocation` sets it to the user's choice; `ensureWorkout` reads `state.pendingLocationId !== undefined ? state.pendingLocationId : recentLocationId` to compute the INSERT value, then deletes the field after the row is written.

**Why this shape rather than a single field with a string sentinel:** JS `undefined` vs `null` is the exact distinction we need, and reading `x !== undefined` is clearer than introducing a magic constant like `"UNSET"`.

**How to apply:**
- Any new state factory that creates a workout-state object must leave `pendingLocationId` absent, not `null`.
- Any write path that creates a workout row (currently `ensureWorkout` and `createAdHocSession`) must compute the effective location id from `pendingLocationId` with the `recentLocationId` fallback.
- Hydrated states (`stateFromWorkout`) don't touch `pendingLocationId` — only `locationId` is populated from the DB.

## 2026-04-19 — Exercise name resolution via candidate-list matcher + alias map

Plan JSON stores exercise names as **display labels** with coaching context ("Pull-ups (BW, full ROM)", "DB Incline Bench Press (30°)", "Cable Chest Fly (mid)"), not canonical identifiers. Before this, `ensureExerciseId(planName)` and `openExerciseHistory(planName)` both keyed `exerciseLibraryByName[normName(name)]` directly — so the vast majority of plan exercises silently missed the seed library, created divergent user-custom rows on set-save, and returned "No history" on View Recent even when canonical history existed.

**Approach considered and rejected:** mutate `normName` to do heavier canonicalization (strip parens, hyphens, pluralization). Rejected because `normName` is the hash used at ~20 sites including `sets.name` inserts; changing the contract risks silent data-divergence elsewhere.

**Chosen:** a separate `resolveLibraryRow(name)` that generates candidates via **deterministic transformations** applied cumulatively, checks each against the existing `exerciseLibraryByName` map, and returns the first match or null. Never fabricates a match — only resolves to rows that already exist.

**Transformations, in order:**
1. `normName(name)` — baseline.
2. Strip trailing parenthetical: `"foo (bar)"` → `"foo"`.
3. Hyphen → space: `"pull-up"` → `"pull up"` (bidirectional coverage via library-side secondary index below).
4. Depluralize: trim `-es` / `-s` from each candidate.
5. `EXERCISE_ALIASES[candidate]` override (inline constant; additive as new plan exercises surface).

Library-side secondary hyphen index in `loadExerciseLibrary` keys seed rows both hyphenated (`"pull-up"`) and dehyphenated (`"pull up"`) so lookups either direction resolve without a `normName` contract change.

**Applied in both paths:** `ensureExerciseId` (write) calls the resolver first and reuses the canonical `exercise_id`; `openExerciseHistory` (read) calls it to locate the row to query. Fallback on resolver miss is the prior behavior — upsert a custom row under the normalized plan name — so set-save never blocks on an unknown name. Fallback rows are caught by periodic data audits, not at write time.

**How to apply:**
- Add entries to `EXERCISE_ALIASES` as new plan exercise names surface that don't resolve via the built-in transformations. Keys are raw-normalized forms; values are existing library names.
- Migrating legacy orphans (rows written under the raw-normalized name before this landed) is a separate data-cleanup task, not handled by the resolver. See `HANDOFF.md` → "Known v1 limitations → Open".

## 2026-04-17 — Session pause/resume via `paused_ms` offset column

When a user pauses a session (Complete Session tap, often accidental) and later resumes, the displayed timer must pick up at the same elapsed value it showed at pause — not the wall-clock since `started_at`, which would include the pause gap. Two approaches considered:

- **Shift `started_at` forward by the pause duration.** Simple, no schema change, but mutates a field DECISIONS.md already committed to as "the literal moment of first set-touch." Breaks the semantic across any subsequent analysis that relied on start timestamps.
- **Separate `paused_ms bigint` offset column.** Adds a column, accumulates pause gaps, every display subtracts it. Preserves `started_at` as literal.

Chose the offset column ([supabase/migrations/20260416000400_add_workout_paused_ms.sql](supabase/migrations/20260416000400_add_workout_paused_ms.sql)).

**How to apply:**
- On Resume: add `(now - ended_at)` to `paused_ms`, clear `ended_at`, persist both. `started_at` stays untouched.
- Every timer / duration display uses `sessionElapsedMs(state)` which computes `(ended_at || now) - started_at - paused_ms`.
- Multiple Complete → Resume cycles accumulate into the same column.
- Historical rows default to `paused_ms = 0`; their effective duration is unchanged.

## 2026-04-16 — Per-plan dup prevention: `performed_on` + partial unique index on `(user_id, plan_id, day_index, performed_on)`

Closes two limitations (multi-tab duplicate workouts, first-insert retry dup) with one DB-level constraint.

**Shape that works:**
```sql
create unique index workouts_plan_day_once_per_date
  on workouts (user_id, plan_id, day_index, performed_on)
  where plan_id is not null;
```

Ad-hoc workouts (plan_id NULL) are intentionally excluded so "+ New Session" can create many per day.

**Why the key includes `plan_id`:** the first pass omitted it and keyed on `(user_id, day_index, performed_on)` only. That was too strict — it blocked a user from starting a new-plan workout on the same calendar day that already had an old-plan workout, which collides with the Feature 3 mid-day-import behavior (old-plan workouts are kept in the DB marked historical while the newly active plan takes over). Including `plan_id` still catches the actual race cases (multi-tab and retry both race within a single plan_id) while allowing legitimate plan-switch-mid-day inserts. Corrected in [supabase/migrations/20260417000000_fix_workout_uniqueness_per_plan.sql](supabase/migrations/20260417000000_fix_workout_uniqueness_per_plan.sql).

**How to apply:**
- Client always sends `performed_on` on insert (user-local `YYYY-MM-DD` from `sessionTodayDateString()`, tied to the hydration snapshot).
- On Postgres error `23505` (unique_violation) during insert, the client re-queries by `(user_id, plan_id, day_index, performed_on)` and adopts the existing row instead of creating a duplicate.
- `current_date` is set as the column DEFAULT as a server-side fallback for any row inserted outside the app flow.

## 2026-04-12 — Active plan uniqueness

At most one `plans` row per user may have `is_active = true`, enforced at the database level via a partial unique index:

```sql
create unique index plans_one_active_per_user on plans (user_id) where is_active;
```

**Why DB-level, not app-level:** app-enforcement leaves silent failure modes — race conditions on concurrent import, direct edits from the Supabase dashboard, or interrupted imports — where two rows end up active simultaneously. The v2 AI planner will read "the active plan" and must never ambiguously pick one of two. Making the invalid state impossible is cheaper than defending against it everywhere downstream.

**How to apply:** when importing a new plan, the client must un-flag the previous active plan (`update plans set is_active = false where user_id = auth.uid() and is_active`) in the same logical operation as inserting the new one. A naïve "insert with is_active=true" will be rejected by the unique index.

**Amendment 2026-04-13 — applied state correction.** The index was originally written into `20260412000000_init.sql`, but a re-run failure against the live database meant only the table-creation portion of that migration actually executed; the index never landed. To reconcile file-state with applied-state, the index was split into a follow-up migration (`20260413000000_add_active_plan_unique_index.sql`) and the original init file was edited to remove the index line so it accurately reflects what is in the database. This is a one-time exception: going forward, never edit a previously-run migration — always write a new forward-only migration instead.

## 2026-04-12 — Ad-hoc exercises (extras)

Users will be able to log exercises they did not import from the plan JSON. These live separately from the prescribed plan blob.

- **Client shape (pre-Supabase):** stored on a per-day `extras` array inside `logData`, e.g. `logData.day_<i>.extras = [{ name, sets: [{ weight, reps, done, rpe }], note }]`. The plan blob is never mutated.
- **Supabase shape:** extras become ordinary rows in `sets` with `exercise_order > plan_length`, `prescribed_weight` and `prescribed_reps` null, and a normal `exercise_id` FK (lazy-create the `exercises` row on first use, same as prescribed exercises). No schema change required.
- **Why keep them separate:** the plan blob stays immutable, so re-importing a plan never wipes logged extras, and "did I hit the plan?" queries stay clean (filter `prescribed_reps is not null`). Mutating the plan to append ad-hoc exercises would conflate prescription with execution.
- **Status:** post-v1 feature. Document now, build after Supabase is live.

## 2026-04-12 — Per-set and per-workout timestamps

Per-set timestamps captured for rest-interval analysis, fatigue timing, and skipped-exercise detection. Order fields kept separately as canonical sequence.

- `sets.started_at` (nullable): set when weight or reps is first entered.
- `sets.completed_at`: set when `done` flips true; enforced with a CHECK constraint (`done = false or completed_at is not null`); app defaults it to `now()` on the false→true transition.
- `workouts.started_at` / `workouts.ended_at` (nullable): session bounds. `started_at` on first set touch; `ended_at` on explicit end or falls back to the last set's `completed_at`.
- Added index `sets (workout_id, completed_at)` for time-ordered in-session queries.
- `exercise_order` / `set_order` remain the canonical sequence — timestamps are truth for *when*, order fields for *sequence*. Both matter: order survives if timestamps are ever null/broken, timestamps unlock things order alone can't (rest intervals, total duration, pacing).

## 2026-04-12 — Open questions from HANDOFF.md resolved

**Un-checking a done set → update `done=false`, do not delete.** Mis-taps are common on mobile; preserving fields lets a re-tap restore without re-entry. Analytics filter `where done = true`. Deletion also loses `completed_at` across flaky-wifi tap cycles.

**Edits after completion → auto-upsert changed fields; only the false→true transition bumps `completed_at`.** Once the row exists, corrections must sync. `completed_at` means "when the lift happened," not "when the row was last touched" — v2 progression models depend on this.

- `done` false→true: upsert, `completed_at = now()`.
- Edit while `done=true`: upsert changed fields, leave `completed_at`.
- `done` true→false: update `done=false`, leave `completed_at` (overwrite only if re-done later).
