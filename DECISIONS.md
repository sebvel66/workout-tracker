# Decisions

Running log of architecture/behavior decisions for the workout tracker. Newest first.

## 2026-04-21 — First-paint completion dots via eager `daysWithHistory` map (v2.2.6)

**Bug:** `●` next to each plan day in the dropdown was missing on hard reload for any day the user hadn't selected yet. Showed up only after selection. The user correctly noticed it looked like a "hydration rendering bug."

**Actual root cause (diagnosed via superpowers:systematic-debugging):** not a timing issue. `buildTabs` runs after hydrate populates `todayPlanStates`. But the dot check `hasToday || historicalCache[i]` depends on `historicalCache`, which is lazy-loaded on tab selection (via `loadHistorical(di)`). On hard reload, only the currently-focused day has an entry. Every other plan day with historical workouts renders undotted because the lazy-load never fired for it.

**Fix:** add a new tiny map `daysWithHistory = { [dayIndex]: true }`, populated once per hydrate with a single cheap query:
```
SELECT day_index FROM workouts WHERE user_id = X AND plan_id = activePlanId AND day_index IS NOT NULL
```
Returns a few ints (a user's plan typically has 3-7 days). `buildTabs` dot check becomes `hasToday || daysWithHistory[i] || historicalCache[i]`. The last clause stays as a fallback in case `daysWithHistory` is stale (e.g., after a discard that removes the last workout for a day — acceptable staleness, refreshes on next hydrate).

**Alternatives considered:**

1. **Eagerly load full `historicalCache` for every plan day on hydrate.** Rejected — N additional queries on every hydrate, when all we need is an existence flag per day, not full state.
2. **Re-render `buildTabs` after every lazy `loadHistorical` completion.** Doesn't solve hard reload — hard reload doesn't trigger lazy loads for non-focused days.
3. **Redesign the dropdown to lazy-load dots on scroll / open.** Over-engineered for a ~5-row dropdown.

**Lifecycle hooks added:**
- `applySession` (auth.js sign-in reset) clears `daysWithHistory`.
- `savePlanAsActive` + `activateExistingPlan` (plan-switch paths) clear it and call `loadDaysWithHistory()` before `buildTabs` so dots match the new plan's history.

**How to apply:**

- When a UI indicator depends on data from another table, ask: is this data lazy-loaded, or eagerly available? If lazy, either (a) eagerly load a minimal existence flag, or (b) make the indicator re-render when the lazy-load completes. Relying on "the user will eventually select it" is the wrong mental model — UIs should be correct on first paint.
- Pair eager-flag maps with the corresponding hydrate + plan-switch paths so they stay in sync without requiring full state loads.
- This pattern (small eager-load of existence flags alongside lazy-load of full state) is a general-purpose fix for "list with indicators where the underlying detail state is per-item lazy." Reuse it when the same shape appears elsewhere.

## 2026-04-21 — Drag-to-reorder exercise cards, two zones, plan-level mutation (v2.2.5)

Long-press an exercise card to lift it via SortableJS, drag within the same sort zone, drop. Plan-day sessions have two zones (prescribed / extras); ad-hoc sessions have one. Zones don't cross.

**Design decisions worth recording:**

**1. Plan-zone reorder is plan-level (mirrors Swap v2.0.29).**

When the user reorders a prescribed plan exercise, we mutate `plan.days[di].exercises` in-place and write `plans.data` back to Supabase. Future sessions on this plan day follow the new order. Alternative considered: session-scoped reorder via a new `workouts.exercise_order jsonb` permutation map. Rejected because it requires a migration + render-logic changes at every site that iterates `plan.days[di].exercises` — significantly more surface to get wrong for a feature that maps cleanly onto the Swap pattern already in use. Scope toast matches Swap: *"Reordered for the rest of the week. Plan updated."*

**2. Extras / ad-hoc reorder is session-only.**

Ad-hoc exercises have no plan-blob representation — they exist only as `sets` rows at particular `exercise_order` values. Reordering them remaps `sets.exercise_order` for the current workout only. No plan mutation. Scope toast: *"Reordered — this session only."* This mirrors Substitute (v2.2.1) semantically — one session of difference, plan untouched.

**3. Sets follow their exercise across a drag — two-phase remap avoids unique-index collisions.**

Per the user's explicit ask: sets remap so each set stays attached to its exercise. The partial unique index `(workout_id, exercise_id, exercise_order, set_order) WHERE done = true` (from v2.0.15) would throw 23505 if we tried to update `exercise_order` directly from position N to M while another row's existing value collided mid-shuffle. Fix: **two-phase update**. Phase 1 shifts every affected row to a `+10000` temp range; phase 2 brings each row down to its final position. Each phase parallelizes across affected positions via `Promise.all`; phase 2 waits on phase 1 completing. PostgREST doesn't support column arithmetic in updates, so each phase issues one `.update()` per old-position key.

**4. Two zones that can't cross.**

Per the user's compromise: plan exercises can reorder among themselves, ad-hoc extras can reorder among themselves, but you can't drag a plan exercise into the extras zone (or vice versa). Enforced via SortableJS `group` — distinct group names (`exercise-plan-zone` vs `exercise-extras-zone` vs `exercise-adhoc-session`) prevent cross-zone drops. Interleaving is a future enhancement if needed; current split avoids the complexity of "is this exercise plan-prescribed or user-added?" becoming draggable across that boundary.

**5. SortableJS + long-press + filter, not a dedicated drag handle.**

SortableJS 1.15.2 via CDN. `delay: 400` + `delayOnTouchOnly: true` means a normal tap never initiates drag; holding on the card for 400ms lifts it. `filter: 'input, textarea, button, select, .set-row, .exercise-note, .exercise-note-input, .sub-row, .rpe-row'` means long-pressing on an input, button, set row, RPE row, or sub row never triggers a drag — the tap falls through to the interactive element as normal. No dedicated drag handle (e.g. a grip icon in the card header) — the entire card chrome is the drag surface, which is simpler and matches the user's spec (*"long-press an exercise card"*).

**6. Plan write failure reverts in-memory state.**

If the Supabase `plans.data` update fails (network blip, RLS denial), we splice the array back to its pre-drag order and re-render. Matches the Swap pattern's `originalExercise` deep-clone revert. The set remap is separate from the plan write — if the plan write succeeds but the set remap fails, we surface the mismatch with a specific toast rather than rolling back the plan (the user's reorder intent should stand; they can re-log affected sets if any ended up mis-attributed). Partial failure tolerance is correct here; mass rollback on a sets write failure would lose the plan-level intent.

**7. Read-only views skip Sortable.**

`initSortableZones` is only called when `mode === 'editable'` (active session on today's date). Historical day-picker views, template previews, and history-detail modals render the sort-zone wrappers as ordinary `<div>`s without attaching SortableJS. Prevents accidental reorder of read-only state.

**How to apply:**

- For future features that need to persist a user-ordered permutation of existing rows, use the two-phase temp-shift pattern. PostgREST's no-column-arithmetic limitation means individual `.update()` calls per affected row are unavoidable; pair that with a temp-range offset and you get safe bulk remapping.
- When adding drag interactions on mobile, always set `delay: 400` + `delayOnTouchOnly: true` and a thorough `filter` selector covering every interactive child. Short delays conflict with tap-to-log-a-set UX; long delays don't actually hurt because the user has to commit to the drag intent.
- When a feature's default scope matches an existing feature's (Swap's "for the rest of the week"), use the same toast template + pattern so the user builds one mental model instead of two. Consistent UX framing reduces cognitive load as the app grows.

## 2026-04-21 — Manual session duration adjustment via `started_at` back-compute (v2.2.4)

Every place a session duration is displayed — running timer, completed-today bar, historical day-picker view, ad-hoc running/completed bars, history detail — gets a small `✎` button. Tap prompts for minutes, back-computes `started_at` so the displayed duration equals the requested value.

**Design decisions worth recording:**

**1. Adjust `started_at`, don't store a separate "manual duration" field.**

The displayed duration is computed as `sessionElapsedMs(state) = (ended_at || now) - started_at - paused_ms`. To make that equal N minutes, we set `started_at = (ended_at || now) - N*60000` and zero `paused_ms`. No schema change; the existing timer calc continues to do the right thing. Alternative considered: add a `workouts.manual_duration_minutes int` column that overrides the calc. Rejected — adds a special case everywhere duration is read, and the `started_at` adjustment is semantically honest (we're saying "the workout started N minutes ago from now/end").

**2. `paused_ms` zeroed on every manual edit.**

If the user has paused-resumed a few times, there's accumulated time in `paused_ms`. Manual adjustment resets it to 0 — the user's new explicit duration collapses any prior pause accounting. Usually what they want ("just make it say 45 min") and avoids double-counting the adjustment.

**3. Running-session adjustment anchors to "now" and keeps ticking.**

If the user adjusts mid-session: `started_at = now - N*60000`. Timer continues to read the elapsed from that new base. If they set it to 40 min now and look again 5 min later, timer reads 45. That's correct — they said "I've been here 40 min already, continue from there."

**4. Context-aware post-save refresh.**

Two contexts distinguished by a `data-ctx` attribute on the edit button:
- `'today'`: patch in-memory state (`todayState`, `todayPlanStates[k]`, `todayAdHocs[i]` entries matching the workoutId), re-render current day, restart timer tick if running.
- `'history'`: invalidate `historyDetails[workoutId]` and the week cache, re-open the detail view so the user sees the new duration.

One handler (`promptAdjustDuration`), two click-delegator hooks (workoutContainer + historyBody).

**5. Validation: 0-600 minutes.**

Non-numeric, negative, and absurd (>10 hours) values are rejected with a toast before touching the DB. Upper bound is ~10 hours, which is far beyond any real session but catches typos.

**How to apply:**

- Small write-once helpers like this work well as a single `renderX` HTML builder + a single `promptX` handler + two click routes (today + history). Keep the surface small — don't build a modal for a 1-field prompt when `prompt()` is adequate.
- Whenever editing "current state" data on-device, patch the in-memory structure before (or instead of) a full reload. A full `hydrate()` is correct but expensive; in-place patch + `buildDay` is the right pattern for small mutations.

## 2026-04-21 — PostgREST FK ambiguity fix + reactivate `performed_at` fix + discard typo (v2.2.3)

Three v2.2.2 regressions, debugged systematically via superpowers:systematic-debugging.

**1. PostgREST FK ambiguity — root cause of "couldn't load week" and "swap not working."**

v2.2.1's migration added `sets.prescribed_exercise_id` as a second FK from `sets` to `exercises`. Any PostgREST embed `sets(*, exercises(...))` now errors `PGRST201: More than one relationship was found for 'sets' and 'exercises'`. This broke four queries simultaneously:
- `fetchWeekSummary` (user-visible: "couldn't load week" on the History modal)
- `_fetchRecentExercisePerformance` (coach context's recent-performance block silently empty)
- `runExport` (date-range export failed)
- Edge Function's `fetchRecentWorkouts` (explains "swap not working" — swap mode shares this query; the server-side fetch erroring before the Anthropic call made the entire swap flow return 500 from the user's perspective)

Fix: disambiguate each embed as `exercises!exercise_id(name, equipment, muscle_group, weight_mode)` — explicitly follow the actual-performed FK. The `!exercise_id` hint is backward-compatible with pre-v2.2.1 installs (ignored when only one FK exists, so the fix is safe to ship without a schema dependency).

**Lesson:** when a migration adds a second FK from A → B, grep every `.select('*, B(...)')` in the codebase. PostgREST won't warn; it just fails. This was missed because I wrote the migration and the UI changes in separate commits without re-running the History view.

**2. Reactivate did nothing visible.**

My v2.2.2 `reactivateWorkout` updated `performed_on` (calendar date) but not `performed_at` (timestamp). Hydrate queries today's workouts by `performed_at`:
```js
.gte('performed_at', bounds.start.toISOString())
.lt('performed_at', bounds.end.toISOString())
```
So a reactivated workout had `performed_on = today` but `performed_at = yesterday's_timestamp` — hydrate's filter excluded it, `todayPlanStates` stayed empty, `inProgressKey` was null, and [app.js:143-144](js/app.js#L143-L144)'s fallback opened the session-start modal. User saw the modal pop up instead of landing on their reactivated session.

Fix: add `performed_at: new Date().toISOString()` to the UPDATE payload alongside `performed_on`. The two need to move together for reactivation.

**Lesson:** `performed_at` and `performed_on` capture the same conceptual truth at different granularities. Treat them as coupled — never update one without the other when moving a workout's date.

**3. Discard typo: `renderHistory()` vs `renderHistoryWeek()`.**

My v2.2.2 `onDiscardWorkout` called a function that doesn't exist, throwing `ReferenceError: renderHistory is not defined` after the DB delete succeeded. User saw "couldn't discard session" toast; the delete had actually landed but the UI didn't reflect it without a hard reload. Fix: rename to `renderHistoryWeek()`.

**Lesson:** syntax-check a file doesn't catch function name references across files in a plain-script (no module) architecture — only runtime calls do. Invoking the discard flow once locally before shipping would have caught this.

## 2026-04-21 — Session lifecycle recovery + swap regression fix (v2.2.2)

v2.2.2 addresses a long-standing edge case (accidentally-started session that midnight-traps into history) and cleans up a regression I introduced in v2.2.1 that broke the v2.0.29 Swap invariant.

**Design decisions worth recording:**

**1. Two recovery affordances for the midnight-trap bug: Discard and Reactivate.**

User taps Start on a future day by mistake, taps Complete Session to pause it (0 sets logged), midnight rolls — now the workout is `performed_on = yesterday` and read-only in history, cluttering the AI planner's context. Two shipped affordances:

- **Discard session** (history detail modal, all workouts): deletes the workout row; sets cascade via FK. Confirm prompt includes completed-set count so the user doesn't nuke real training data without realizing.
- **Bring to today** (history detail modal, conditional): `UPDATE workouts SET performed_on = today, started_at = now(), ended_at = NULL, paused_ms = 0 WHERE id = X`. Sets stay attached. Timer resets to now. Reactivate is gated on `plan_id` matching the currently-active plan (or ad-hoc with plan_id = NULL) — reactivating a session from a different plan would drop it into today but it wouldn't surface in today's view, leaving the user more confused.

Edge-case handling: partial unique index on `(user_id, plan_id, day_index, performed_on)` throws 23505 if today already has a workout for this plan-day. Caught and surfaced as: *"You already have this day started today. Complete or discard that one first."*

**2. Pre-midnight cancel for in-progress 0-set sessions.**

Addresses the same accidental-start case before midnight rolls. A dashed *"Cancel session (no sets logged)"* button renders under the session bar whenever today's plan-day state has `startedAt != null && completed_sets === 0`. Safer than letting it drift into history + needing the reactivate path. Deletes the workout row, clears in-memory `todayState` / `todayPlanStates[di]`, re-renders the day as not-started.

Intentionally hidden when any set is completed — at that point the user is training for real, and a blanket "cancel" button could be destructive. Users with real sets logged who still want to scrub use the history-detail Discard path (with its completed-set-count confirmation).

**3. Swap regression fix: fan-out scope reduced; substitution retarget moved into `logSubstitute` with a precise filter.**

v2.2.1's `updateExerciseFanOut` wrote `exercise_id` + `prescribed_exercise_id` to every set at `(workout_id, exercise_order=ei)` when RPE or note changed. In isolation this worked for substitution flips. But combined with a prior v2.0.29 Swap (plan blob mutated, new sets logged post-swap get new exercise_id while old sets stay attached to the pre-swap exercise_id — the documented "historical for the old exercise" invariant), a single RPE tap after swap would overwrite the old sets' `exercise_id` to the new one, erasing the old exercise's history on that workout.

Fix:
- `updateExerciseFanOut` reverted to pre-v2.2.1 behavior — only writes `rpe` and `note`. Never touches `exercise_id` / `prescribed_exercise_id`.
- `logSubstitute` does its own precise UPDATE: `SET exercise_id = newActualId, prescribed_exercise_id = prescribedId WHERE workout_id = X AND exercise_order = ei AND exercise_id = oldActualId`. The `.eq('exercise_id', oldActualId)` filter is the key — only retargets sets that currently match the pre-change actual. Legacy post-swap sets attached to a different `exercise_id` stay untouched.

On failure: reverts in-memory `state.subExercise` and re-renders so the UI matches the DB.

**Lesson:** when adding structural writes to a fan-out helper, audit the assumption that "all rows matching the grouping key belong to the same conceptual thing." In this app that assumption breaks under v2.0.29 Swap, and the fix was to move structural writes into the handlers that understand the structural semantics (logSubstitute) rather than the generic fan-out.

**4. Toast × close button.**

Every toast (error + info) now renders a small × button. Click handler calls `e.stopPropagation()` before `dismissToast(id)` so a user tapping × on a retry toast doesn't accidentally fire the retry callback — the body remains tappable for the retry action. Addresses a UX gap where retry toasts and long info toasts felt undismissable-by-design; × makes the dismiss affordance discoverable without changing the tap-body-to-retry or auto-dismiss semantics.

## 2026-04-21 — Structured per-session substitutions: `exercise_id` = actual, new `prescribed_exercise_id` = plan's ask (v2.2.1)

Replaces the v1 free-text `sets.substitution` column with a structured FK. The v1 design let users type "machine row" into a free-text SUB field; those sets were invisible in Machine Row's history (because `exercise_id` still pointed at Cable Row) and the AI couldn't reason about swap patterns. v2.2.1 fixes both at the schema + UX level.

**Design decisions worth recording:**

**1. `exercise_id` changes semantics: what actually happened, not what was prescribed.**

Before: `sets.exercise_id` was always the plan's prescribed exercise. After: it's what the user actually performed (substitute if subbed, else prescribed). New `sets.prescribed_exercise_id` nullable column records the plan's ask; null on ad-hoc / extra sets.

Chosen over the alternative of adding `substituted_exercise_id` as a sidecar column because:
- View Recent on the substitute *just works* — sets filter on `exercise_id` and land under the correct exercise.
- Plan adherence is a clean one-liner: `WHERE prescribed_exercise_id IS NOT NULL AND prescribed_exercise_id != exercise_id`.
- The backfill is trivial: for every pre-v2.2.1 plan-day set, `prescribed_exercise_id = exercise_id` (substitution was in the separate text column and didn't affect `exercise_id`). One-shot migration, no ongoing special-case logic.

**2. Substitution is session-scoped; swap is plan-scoped. Both are legitimate; the UI makes the split explicit.**

Swap (v2.0.29): mutates `plan.data`. The change lives on the plan for the rest of the week. Next session on this day shows the swapped exercise. Natural fit for "knee's been bothering me; use leg press instead of squats for a while."

Substitute (v2.2.1): doesn't touch the plan. Just this workout's sets get logged under the substitute. Next session shows the prescribed exercise again. Natural fit for "at a different gym today; using dumbbell row instead."

Both features converged on similar UX (exercise library picker, AI recommendation next) — which initially felt redundant. Resolution: keep both, make the scope split explicit via UI callouts:
- Swap review modal carries a yellow callout: *"Accepting replaces this exercise in your plan for the rest of the week. For a one-session change, close this and use SUB on the card."*
- Swap accept toast: *"...for the rest of the week. Plan updated."*
- Substitute apply toast: *"...for today only. Plan unchanged — use the ⇄ Swap icon to change the week."*

The scope callouts make the durable-vs-ephemeral distinction impossible to miss. User decision tree shifts from *"which button?"* to *"do I want this to stick beyond today?"*

**3. Weight-mode and display-name track the substitute, not the prescribed exercise.**

When substituted, the card:
- Shows the substitute's name with a subtle `was: Cable Row` tag (keeps plan origin visible without dominating).
- Uses the substitute's `weight_mode` for the input label (`LBS/ea` for per_side, `ADD WT` for bodyweight, etc.).
- Clears the prescribed-weight placeholder (the plan's 120 lbs is meaningless on a different exercise with different strength curve).
- Keeps the rep target (reps port across most substitutions).

Without these, substituting Cable Row (total, 120) for Dumbbell Row (per_side, ~55) would show the Cable Row weight anchor on the DB Row card — confusing and data-hostile. This was a real bug, not a polish item.

**4. Reuse the exercise picker via a generic `openPicker(onSelect)` callback.**

The picker was hardcoded to `addExerciseToSession`. Refactored to accept an optional callback; default behavior preserved when no callback given. Substitution passes `logSubstitute` as its callback. Pattern is reusable for future library-lookup features without further picker changes. Callback is nulled on close so a subsequent default-open can't accidentally re-run a stale callback.

**5. Legacy free-text `sets.substitution` column: leave as-is.**

New writes set it to null. Old rows keep their text values for display-only fallback (the card shows "<text> (tap to re-link)" until the user re-picks via the library). Considered a one-shot SQL backfill (run `resolveLibraryRow` over every non-null text and promote to the structured columns) — deferred. Volume is small and the display-fallback covers legibility without schema churn.

**6. `updateExerciseFanOut` retargets mid-session.**

If the user substitutes after already logging sets (e.g., they finished set 1 on Cable Row, then the cable machine got taken, they sub to DB Row), the already-persisted sets need their `exercise_id` flipped to the substitute. `updateExerciseFanOut` now does this as part of its existing update-all-sets-for-an-exercise fan-out. In-memory set slots are updated post-write so subsequent re-renders and `buildSetPayload` calls see the fresh ids.

**7. AI recommendation for weight/reps deferred to v2.2.2.**

Shipping the structured plumbing first lets the user validate the core substitution UX with manual weight entry. The v2.2.2 layer adds a `mode: "substitute_recommend"` branch on `/api/generate-plan` that takes the prescribed exercise + chosen substitute + history context and returns calibrated sets. Post-substitute sheet offers three options — suggest / manual / cancel. Manual-entry-with-no-goal is a first-class path (matches ad-hoc exercise add UX). Schema + write path already support it; only the AI call and post-pick prompt remain.

**How to apply:**

- When adding structure to an existing free-text field, audit ALL downstream read paths before changing semantics. History queries, analytics, coach context all needed updates here.
- Scope callouts (toasts + inline modal warnings) are cheap insurance against user confusion between similar-but-distinct features. Two toasts + one modal callout cost ~10 lines of code and remove a full class of "wait did I just change my plan?" moments.
- Generic callback refactors (picker in this case) pay for themselves quickly when a second caller appears. Don't premature-abstract, but when the second caller shows up, extract the callback path.

## 2026-04-20 — Coach Chat: four-layer context, Haiku, separate endpoint, ephemeral history by default (v2.2.0)

Real-time AI coaching during training sessions. Claude Haiku 4.5 on a new endpoint, with context assembled from four layers (static system prompt / semi-static per-session summary / live per-message session state / ephemeral chat history).

**Design decisions worth recording:**

**1. Separate endpoint, not another `mode` branch on `/api/generate-plan`.**

Plan generation and coach chat share almost nothing at the Anthropic-call layer: different model (Haiku vs Sonnet), different budget (500 vs 16000 tokens), different prompt shape (conversational vs structured JSON), different response contract (freeform text vs validated plan), different timeout budget (25s vs 55s), different warmup cadence (5 min vs 10 min). A new file at [api/coach-chat.js](api/coach-chat.js) keeps each endpoint focused and testable; swap mode stays on `/api/generate-plan` because it shares the plan-generation library + history context.

**2. Four-layer context, one layer per mutation cadence.**

- **Layer 1 (static):** system prompt — hardcoded in the endpoint. Never changes at runtime.
- **Layer 2 (semi-static):** `coachContext` built once per session-lifecycle boundary via `buildCoachContext()`. Three Supabase queries in parallel (week status, recent performance, recent notes) + in-memory plan blob. ~650 tokens typical, hard-capped under 1500.
- **Layer 3 (live):** `getLiveContext()` runs on every message — purely in-memory read of `todayState` / `plan` / `locationById`. Zero queries.
- **Layer 4 (conversation):** `chatHistory` accumulates Q/A pairs only. Context setup pair is synthesized fresh on every send because Layer 3 changes per message.

The split lets us amortize expensive work (DB queries) across many messages while keeping latency-sensitive work (live state) on the hot path with zero round-trips.

**3. Plan prescription lives inline in the live context, not just in semi-static.**

First draft had plan prescriptions only in Layer 2 (the cached plan block). Haiku has to cross-reference *"what was prescribed for Day 2 Cable Row"* against *"what I've actually done this session"* — two separate prompt sections, different phrasing, high cross-reference cost. Fix: inline the prescription next to each exercise's actuals in `getLiveContext()`. Format: `"DB Incline Bench Press (30°) [plan: 4×12 @45]: 45×12, 45×12, 45×12, 45×5 — 4/4 done"`. The coach now sees prescription and actuals in one place, enabling one-shot standardization calls ("first three hit target, fourth missed — hold next week").

**4. Chat history is ephemeral by default.**

`chatHistory` is an in-memory JS array, trimmed to the last 20 messages. Cleared on session start, session complete, plan save (active-plan change), and sign-out. **Not persisted to Supabase.** Rationale:

- The questions the coach answers are situation-specific ("should I drop weight on set 3?"). Answers have no value a week later.
- Persistence adds schema + RLS + load-history step + token bloat when feeding old transcripts back into the context. Cost is real, benefit is marginal.
- Cross-user privacy is simpler: if browser tab closes, conversation is gone. No cleanup migration needed when a user signs out on a shared device.

Persistence is a **valid follow-up** if practice shows otherwise. The schema would be `coach_messages (id, user_id, workout_id nullable, role, content, created_at)` with the standard `own_X` RLS policy; load-on-chat-open would add ~100-300ms; the plan generator could then reference cross-session coaching. That's v2.2.1+ work — don't build it speculatively.

**5. Cron warmup: once daily at 5am ET, constrained by Vercel Hobby plan limits.**

Initial v2.2.0 shipped with `*/5 * * * *` (coach-chat) and `*/10 * * * *` (generate-plan) cron entries. **The deploy failed.** Vercel Hobby caps cron jobs at **once per day max** — `/docs/cron-jobs/usage-and-pricing` is explicit: *"Hobby accounts are limited to cron jobs that run once per day. Cron expressions that would run more frequently will fail during deployment."*

Reverted to daily warmup for both endpoints at `0 9 * * *` (9am UTC = 5am EDT / 4am EST — Vercel cron is UTC-only, no timezone support, so the local time drifts an hour across DST). Both endpoints keep a `?warmup=true` early-return branch that short-circuits before Anthropic, so the cron is free in token terms — just one Vercel invocation each per day.

**Honest benefit is narrow:** a daily 5am ping warms a Fluid Compute instance that typically stays hot for ~15-45 minutes under low traffic. If the user trains early morning, the first real call benefits. If they train later, the instance is cold again and the cron saved nothing. For an interactive UX ideally we'd want every-5-minute pings (what the original config tried) — blocked by the Hobby cap.

If cold-start latency ever feels bad in practice, options ranked by cost:
1. External pinger (GitHub Actions cron, UptimeRobot free tier) hitting `?warmup=true` — zero cost, 5-min cadence possible, stays on Hobby.
2. Vercel Pro upgrade ($20/mo) — per-minute crons included plus other benefits.
3. Keep current daily + lean on UX (typing indicator + silent retry handle perceived delay).

**6. Live context inline prescription format: `[plan: N×R @W]` next to each exercise.**

Chose brackets rather than parenthesis or separate line. Readable at a glance, parses cleanly by Haiku (tested — no confusion with exercise notes in parentheses), and fits the existing one-line-per-exercise convention.

**7. Non-streaming response.**

Haiku at 500 tokens lands in ~1-2s warm. Streaming would cut time-to-first-byte by maybe 300-500ms but adds real complexity (Vercel Node streaming pattern, SSE forwarding, frontend chunk parsing). Fallback path chosen per the spec; revisit if user reports the non-streamed UX feeling laggy in practice.

**8. Auto-retry mirrors the v2.0.26 plan-generation pattern.**

On network / 5xx / 504: retry once silently, typing indicator swaps from `…` to *"Warming up…"*. 4xx and 200-without-reply pass through immediately to an inline error message in the thread (not a toast — preserves chat context). Same design lineage, applied to a new endpoint.

**How to apply:**

- Any future AI feature that's *interactive* (multi-turn, short-response) belongs on its own endpoint with Haiku + cron warmup. Bulk / one-shot AI features (plan generation, exercise swap, image analysis) stay on `/api/generate-plan` with Sonnet + the Anthropic prompt cache carrying latency savings.
- If a piece of data needs to be referenced by the AI on every message, inline it in the live context rather than relying on cross-section lookup from the cached prefix. Token cost is small; cross-reference cost to the model is bigger.
- Ephemeral-by-default is a reasonable MVP stance for conversational AI features. Persistence is orthogonal and can be layered in later without touching the hot path.
- When a prior decision is reversed (like the cron-warmup deferral), note it explicitly in the new entry so the history is legible. Don't silently change course.

## 2026-04-20 — Plan templates: same plans table with `is_template` flag; fourth card in start-session modal (v2.1.0)

Templates are reusable workout blueprints. They're modeled as a new row in the existing `plans` table (rather than a new table) gated by `is_template = true` + `is_active = false`. A template can be a whole plan (many days) or a single day (one-entry `days` array); the same consumer code handles both.

**Design decisions worth recording:**

**1. Same table, flag column — not a separate `templates` table.**

`plans` already has exactly the shape we need: `user_id`, `data jsonb`, `created_at`, RLS policy. Splitting templates into their own table would duplicate the schema + double the RLS surface + force consumers to union-query both tables for listings. The active-plan unique index (`plans_one_active_per_user WHERE is_active`) is unaffected since templates always have `is_active = false`. A partial index keyed to template rows (`plans_user_templates_recent ... WHERE is_template = true`) keeps the templates-list query fast without scanning active/historical plan rows.

**2. Single "Save as template" hamburger entry with scope picker inside the modal.**

First draft had two hamburger rows — "Save plan as template" and "Save day [N] as template" — but the pair felt redundant when reading the menu. Consolidated to one entry. The save modal has a segmented Whole plan / Just "[day name]" picker; the day option enables only when focused on a plan day, and hides entirely when launched from a context without day focus (e.g., Plans-modal row save). Clean for the user; simpler code (one entry point, one modal).

**3. Template picker is a 4th card in the start-session modal, not a new entry point.**

Per DECISIONS.md 2026-04-19 (Explicit session-start modal): *"Any feature that wants to insert a new session-start path should add a fourth card to the modal rather than introducing a new entry point."* Honored. Tapping the card expands an inline list of templates; single-day templates create the session immediately, multi-day templates expand inline to show day rows (same visual pattern as Pick a different day). Empty state ("no templates yet") points users at the hamburger.

**4. Single-day and multi-day templates share the same wire format.**

A single-day template is just a plan blob with `days: [oneDay]`. Same JSON shape, same code path. `loadTemplates` / `deleteTemplate` / `createAdHocFromTemplate` don't branch on day count — the difference shows up only in the picker UI (direct-create vs inline expansion).

**5. Template-based sessions are ad-hoc — they do not create plan-day workouts.**

When the user picks a template + day, `createAdHocFromTemplate` inserts a `workouts` row with `plan_id = NULL`. The template's exercises become pre-populated entries in the ad-hoc state with `exerciseId` resolved via `resolveLibraryRow`. Logging sets on this session writes to `sets` normally, linked to the ad-hoc workout. Templates are blueprints, not plans — we don't want templates consuming the "one active plan" slot or polluting the Weekly History browser with phantom plan days.

**6. Name resolution happens at template-use time, not at save time.**

Template JSON stores exercise names verbatim (same as plan JSON). `createAdHocFromTemplate` resolves each name via `resolveLibraryRow` when the user picks the template; exercises that don't resolve are skipped with a toast ("2 exercises skipped, not in your library"). Consequences:
- Templates saved when an exercise existed survive if the exercise is later renamed, as long as an alias or hyphen variant still resolves.
- Templates are portable across library shape changes (e.g., new seed exercises).
- Plays nicely with the planned "Resolve plan exercise names at import time" ROADMAP item — templates get the same treatment if/when that lands.

**7. Templates are read-only after creation.**

No edit button in the templates modal. If the user wants a modified version, they use the template, tweak the session, and save a new template from the modified plan. Avoids all the churn of "does editing a template retroactively change sessions created from it" (answer: it doesn't, because each use creates an independent workout — but making this explicit via no-edit keeps the mental model clean).

**How to apply:**

- Any future "save a workout-structure-as-data" feature (e.g., mesocycles, preset warm-ups) should follow the same pattern: flag column on an existing table, not a new table; shared consumer code for both "large" and "small" variants; resolve names at use time, not save time.
- Any new session-start path (e.g., "Resume from last week", "Copy yesterday") must land as another card in the start-session modal. Do not add new entry points elsewhere — that was settled in the 2026-04-19 flexible-session-start decision.
- When a feature has two hamburger entries that are always paired or contextually redundant, merge them into one entry with the distinction inside the modal.

## 2026-04-20 — AI exercise swap: separate workflow on the same endpoint (v2.1.0)

Single-exercise replacement on a plan day. Reuses the existing `/api/generate-plan` endpoint with `mode: "swap"` — not a new endpoint.

**Design decisions worth recording:**

**1. Same endpoint, early-dispatch on `mode` field.**

Adding a new endpoint (`/api/swap-exercise`) would duplicate env-var checks, JWT verification, timeout handling, and error envelope. Instead, `handler()` checks `rawInputs.mode === 'swap'` before the plan-generation branch and calls `handleSwap(res, userId, rawInputs)`. Each branch has its own system prompt, max_tokens budget, validation, and abort — but shares auth, query helpers (`fetchActivePlan`, `fetchRecentWorkouts`, `fetchExerciseLibrary`), and error-response shape. Cleaner than two endpoints.

**2. Inline swap system prompt, not a new bundled file.**

The main plan-generation prompt lives in `system-prompt.md` loaded at cold start via `fs.readFileSync`. For swap, I put the prompt inline as a JavaScript constant. Reasons:
- ~40 lines, fundamentally different workflow — doesn't share content with the main prompt.
- Bundling a second file via `vercel.json` `includeFiles` would add build complexity for minimal iteration benefit.
- Swap prompt rarely changes; when it does, edit = commit = redeploy, same as `system-prompt.md`.
- Separate `cache_control` breakpoint (1h TTL) on the swap prompt means it gets its own Anthropic cache entry, independent from the main prompt.

If the swap prompt ever grows past ~100 lines or needs frequent iteration, promote it to a bundled file. Not justified now.

**3. 500-token budget, 8-15s warm response target.**

One exercise, one JSON object. Sonnet at ~70-90 tok/s produces 500 tokens in ~6-7s; plus prompt digestion and Anthropic queueing, warm total lands 8-12s. Cold (cache miss) 15-20s. This is fast enough that the frontend doesn't need the silent-retry pattern used for plan generation — the failure mode (504) is surfaceable cleanly and the user taps Try again.

**4. Server gathers context; client sends minimal payload.**

Frontend sends `{ mode, exercise, reason, day_name }`. Server derives:
- Exercise library (for name validation + prompt block).
- Active plan (for today's other exercises — "don't suggest duplicates").
- Recent 2-week history filtered to the same movement_pattern (or muscle_group fallback) — for weight calibration on the replacement.

Moving context derivation server-side means the client stays simple and we don't round-trip context data. The 2-week window is a deliberate narrow scope — more history would bloat the prompt without improving weight choices.

**5. Strict replacement validation rejects off-library names + same-day duplicates.**

`validateSwapReplacement` checks:
- Name is non-empty, a string, and exists in the library (set lookup).
- Name != replaced name (Claude shouldn't suggest the same exercise).
- Name not already on this day (the user message says this explicitly, but belt + suspenders).
- Rest is an integer (seconds, per the sets-are-ints rule).
- Non-empty sets.

Failures return 422 with a specific error so the frontend can show an actionable toast. This is what makes `Try again` work well — Claude gets a clean retry, not a silent garbage response.

**6. Accept-swap mutates the active plan; logged sets on the replaced exercise remain intact.**

On Accept, frontend mutates `plan.days[di].exercises[ei]` and writes `plans.data` to Supabase via a single `update` query. The mutation is in-memory first, Supabase-write second; on write failure, `originalExercise` (deep-cloned at modal-open) is restored so the UI never drifts from the DB.

Already-logged sets on the replaced exercise stay attached to their original `exercise_id` in the `sets` table — the plan blob is metadata, the set rows reference the exercise table directly. Result: "historical for the old exercise on that one workout" is the correct and automatic outcome. No cleanup or migration needed. Future set-done taps on the replaced card resolve the new name via `ensureExerciseId` → `resolveLibraryRow`, same as any plan exercise.

**7. Swap icon is only rendered on plan exercises in editable mode.**

Render condition: `!readOnly` (editable mode) AND inside the prescribed exercise loop (not the extras / ad-hoc loop). Historical and template views don't show swap — you can't mutate a historical plan's exercise; template plans get regenerated wholesale. Ad-hoc sessions don't have a "plan exercise" to replace — add/remove via the picker instead.

**How to apply:**

- Any future per-item AI feature on an existing workflow (e.g., "suggest warm-up sets", "explain this prescription") should follow the same pattern: early-dispatch on a `mode` field, inline system prompt if <100 lines and workflow is distinct, separate `cache_control` breakpoint, minimal client payload + server-side context derivation, strict validation against the library, in-memory mutation with deep-clone revert on write failure.
- The swap failure budget is tighter than plan generation (500 tokens at ~70-90 tok/s = seconds not minutes). If swap latency ever regresses past ~15s warm, check output token count first (same MAJOR-BUGS.md lesson applies: output tokens dominate latency, not input).
- Template-based sessions inherit the *replaced* exercise semantics automatically — sets on a template-day session reference canonical `exercise_id` values, same as any ad-hoc session. No template-specific handling needed in swap.

## 2026-04-20 — User-controlled plan inputs (training days / history weeks / photos) + system prompt as single source of truth (v2.0.27)

Before v2.0.27, day count (5), day placement (Sun-Thu), split structure (Upper/Lower), and history window (4 weeks verbatim+summary) were all baked as constants — some in the serverless function, some in the system prompt. Changing any of them meant editing code or prompt and redeploying. v2.0.27 makes each a per-call input.

**Design decisions worth recording:**

**1. Cached rules, per-call data — consistent with the 2026-04-20 USER INPUTS pattern.**

Training days and History context are always emitted in the per-call user message; the *rules* for how to handle them live in the cached system prompt (`USER INPUTS FOR THIS WEEK` section). Same split as start_date / target_duration / notes — runtime data flows in dynText, interpretation rules stay in the cached prefix. Avoids the MAJOR-BUGS.md 2026-04-20 failure mode where instruction text in dynText added ~1000 output tokens and 6-10s of latency.

**2. Frontend clamps, server re-clamps. Defense in depth.**

`clampFormInt` on the client keeps the form input inside valid ranges; `clampInt` on the server re-validates in case a non-form caller (or a future tool) hits the API with out-of-range values. Both default to the same fallback (5 for training_days, 4 for history_weeks) so a missing field silently produces today's behavior.

**3. `validatePlan` now hard-enforces day count.**

Previous validation was "at least 1 day, each has exercises." New validation: `plan.days.length === expectedDays`. Wrong count → 422 with a specific error. Claude has two reasons to respect the input (cached HARD CONSTRAINT + server validation); if both fail, the user sees an actionable error instead of a silently wrong plan.

**4. `include_photos` defaults are asymmetric: client unchecked, server true.**

The checkbox defaults to OFF because photo analysis costs 1-3s and ~1-2K tokens per image; most weeks the user doesn't upload a new progress photo, so the marginal information gain is near zero. But the server's default-when-absent is ON, so any non-form caller (a future cron, a debug script) gets today's behavior. The explicit `false` from the form is the only path that skips the photo fetch.

When off, `fetchPhysiquePhotos(userId)` is replaced in the `Promise.all` with `Promise.resolve({ goal: null, progress: [] })`. No Supabase Storage round-trip, no photo download, no image blocks in the user message. `buildUserMessage` handles this case naturally since the existing `photos.goal && goalImg` and `photos.progress.length && progressImg` guards are falsy.

**5. System prompt: single source of truth for day count.**

Hardcoded "5-day Upper/Lower Sun-Thu" previously appeared in three places (CLIENT PROFILE, OUTPUT FORMAT, HARD CONSTRAINTS). Now it appears only in USER INPUTS as the default-when-missing, and the CLIENT PROFILE reframes it as *historical preference* with explicit "overridden by Training days" language. The priority rule says user inputs win — no per-call reconciliation reasoning.

**6. Audit pass removed four residual conflict-risk spots.**

Even after the hardcoded structural references were gone, generic coaching language could still collide with user inputs:
- `"shorten the plan"` in Execution rate over plan length → `"trim exercises per session (don't reduce the day count — that's Training days)"`.
- Split re-evaluation bullet in Proactive program re-evaluation → scoped to *"Within the given Training days count..."* with explicit *"Do not propose a different day count."*
- Cut-phase *"reduce session duration"* → *"subject to Target session duration — never trim below the user-specified target."*
- Active-recovery phrasing in CLIENT PROFILE → *"typically the tail end of the week, but which days those are depends on the Training days count"* instead of assuming weekends.

Lesson: when moving a hardcoded value to an input, audit the entire prompt for generic coaching phrases that *implicitly* referenced the old value. The priority rule at the end of USER INPUTS backstops edge cases, but explicit guardrails in each affected section eliminate reconciliation work.

**7. Photo-handling section intentionally left alone.**

The existing `### Physique-driven programming` section is already correctly conditional: *"may include attached images / When these images are present"* + *"If no photos are attached: Rely entirely on training data..."*. Claude cannot distinguish "user has no photos" from "user excluded photos this call" — and shouldn't need to. The opt-out checkbox works without any prompt change. Don't add instruction text about the checkbox; it would add per-call reasoning cost for zero behavioral benefit.

**8. Day placement stays Sunday-anchored.**

Day 1 = Sunday, Day 2 = Monday, etc. — regardless of how many days the user picked. Simpler than letting the user pick a start-of-week, and matches the existing Weekly History browser's Sunday convention. The plan's `start_date` is still the Sunday the plan kicks in.

**How to apply:**

- Any future per-call input should follow the same split: rules in cached system prompt, values in dynText, server clamping, server validation. Put the "what to do if absent" logic in the cached prefix — never in dynText.
- When adding a HARD CONSTRAINT that references an input value, also audit COACHING PHILOSOPHY for generic phrases that could contradict. The priority rule is a backstop, not an excuse to skip the audit.
- Don't over-constrain in the prompt when a server-side validation can catch it. For day count, we have both (belt + suspenders); for something less critical, one is enough.
- Asymmetric defaults (client vs server) are a legitimate pattern for opt-in-heavy features. Don't try to unify them — the divergence encodes policy that matters.

## 2026-04-20 — Cold-start UX: client-side silent retry over server-side warm-up (v2.0.26)

The `/api/generate-plan` serverless function has a known worst-case latency pattern: first call after the Anthropic 1h ephemeral cache expires takes 35-45s (cache miss) vs 22-30s warm. On slow-response days this occasionally tips past the 55s server-side abort, surfacing as a 504 toast. Vercel's Fluid Compute already blunts traditional serverless cold-boot cost (instance reuse across concurrent requests) — the dominant "first call slow" driver in this codebase is the Anthropic prompt cache, not V8 warmup or Supabase connection establishment.

**Chosen:** client-side auto-retry in [js/ui.js](js/ui.js). On the first failure with a retriable outcome (network error / 5xx / 504), fire a second identical request silently. The retry lands on a now-warm Anthropic cache + warm function instance and almost always succeeds within the original elapsed-time budget the user was already waiting through.

**Retry matrix, explicit:**

| Outcome | Retry? |
|---|---|
| Network error (DNS, connection refused) | yes |
| `AbortError` from user-initiated Cancel | no (re-throw → exit clean) |
| HTTP 504 (server-side 55s timeout) | yes |
| HTTP 5xx (anything else) | yes |
| HTTP 4xx | no (won't fix itself) |
| 200 but `!body.plan` | no (content failure, not warmth) |

Exactly one retry. A second retry on a sustained outage gains ~0 expected success rate at the cost of 30-55s more user wait — worse UX than failing fast.

**Alternatives considered and rejected:**

- **Parallelize Supabase queries in the function.** Already shipped — `Promise.all` at [api/generate-plan.js](api/generate-plan.js) L83-88 wraps all four data fetches. No headroom here.
- **Reduce history scope on first call.** Would cut input tokens but *not* latency — per [MAJOR-BUGS.md](MAJOR-BUGS.md) 2026-04-20, output tokens dominate generation time (Sonnet ~70-90 tok/s). Cutting context degrades AI quality without moving the wall-clock. Explicitly refused.
- **Cron warm-up ping every 5 min.** Keeps one function instance hot but does nothing for the Anthropic cache (which is what actually causes the 15s latency delta). Under Fluid Compute the instance-warmth win is smaller than on classic serverless. Also uses Hobby-plan cron slots. Deferred to [ROADMAP.md](ROADMAP.md) — revisit only if the retry UX still feels bad in practice.
- **Vercel Pro (300s timeout).** Valid but $20/mo for a personal app; a $0 client-side retry covers the same failure mode for the common case.

**Also shipped same version:** goal + progress photo downloads in `buildUserMessage` now run via `Promise.all` instead of serially (~200-500ms saved on the prompt-build phase, no cache impact since block order is preserved).

**How to apply:**

- Any future long-running LLM / AI endpoint should implement the same two-state loading pattern (first attempt → retry attempt) with a single silent retry on transient server/network errors. Use the `attemptGeneratePlan` helper shape in [js/ui.js](js/ui.js) as the template.
- Do NOT retry on 4xx, 200-with-bad-body, or user-cancel. The retry should eliminate *transient warmth problems*, not paper over content/auth failures.
- Keep the second-attempt loading message honest about what's happening ("warming up…"). Silent retry with no UI feedback feels broken on slow second attempts.
- If this approach ever stops covering the failure rate: next escalation is cron warm-up (cheap, small win under Fluid Compute) then Vercel Pro (larger timeout budget).

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
