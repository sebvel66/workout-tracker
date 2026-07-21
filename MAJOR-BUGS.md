# Major bugs

Record of significant bugs that required non-trivial investigation or data cleanup. Newest first. Small, in-code-fixed-in-one-commit bugs don't belong here — those live in git history. This file is for bugs where the root cause, the fix, or the blast radius is worth knowing later.

## 2026-07-20 — Ad-hoc sets never persist when there's no active plan (v3.7.9)

### Symptoms

User report: "I am really struggling with the workout tracker when I'm not using a plan. When I try to use ad-hoc sessions, the exercises do not save — even if I check them as completed, they never persist." No error toast, no visible failure. Sets appeared checked for the rest of the session (in-memory state was mutated) and were gone on reload. Ad-hoc sessions *while an active plan exists* worked fine — the bug only fired in no-plan mode.

### Root cause

`_toggleSetCommit` ([js/data.js:2529](js/data.js#L2529)) read the prescribed set for auto-fill without a null guard on `plan`:

```js
var prescribed = plan.days[di] && plan.days[di].exercises[ei] && plan.days[di].exercises[ei].sets[si];
```

In no-plan mode `plan` is `null` ([js/app.js:119](js/app.js#L119)), so this threw `TypeError: Cannot read properties of null (reading 'days')` — **eight lines before `await persistSet(di, ei, si)`**. The set was never written, `buildTabs()` / `buildDay(di)` never ran, and the rest timer never fired.

With an active plan the same line is harmless: `di` is an `'ah_<uuid>'` string, so `plan.days['ah_…']` is `undefined` and the `&&` chain short-circuits. That's why the bug was invisible to anyone who kept a plan active.

Two things made it **silent** rather than a visible error:

1. Check-on routes through `promptResumeIfEnded(function() { _toggleSetCommit(…) })` ([js/data.js:2513](js/data.js#L2513)), which invokes the callback un-awaited ([js/ui.js:8189](js/ui.js#L8189)). An async callback's rejection became an unhandled promise rejection — no toast.
2. `sl.done = !wasDone` ([js/data.js:2520](js/data.js#L2520)) runs *first*, so in-memory state said "done" while the DB had nothing. Every subsequent re-render honored the lie until reload.

The persistSet error path has a well-built toast with the Supabase message on it — it just never got reached, because the throw was upstream of the `try`.

### What was fixed

Guarded the deref to match the style already used by the cascade lookup at data.js:2564 and the rest-timer lookup at data.js:2606 — both of which were written as `(plan && plan.days) ? … : null`. This one line was the only site in the function that missed the guard.

```js
var prescribed = plan && plan.days && plan.days[di] && plan.days[di].exercises[ei] && plan.days[di].exercises[ei].sets[si];
```

An audit of all ~80 `plan.` dereferences across `js/data.js`, `js/ui.js`, `js/app.js` found **no other** unguarded site reachable with `plan === null` — `buildDay` dispatches to `buildAdHocDay` before its `if (!plan) return`, `buildTabs` wraps the day loop in `if (plan)`, and `buildSetPayload` / `_persistSetInner` keep their plan reads inside the `else` of `if (todayState.isAdHoc || exState.isExtra)`.

### Blast radius

Latent since the no-plan branch existed, but only reachable while **no plan is active** — which for most of this app's history was a transient state. It bites the window after "End plan" and before the next plan is generated. Ad-hoc sessions logged *alongside* an active plan were never affected, which is why ad-hoc looked healthy for months.

Confirmed against production data. Of 48 ad-hoc (`plan_id IS NULL`) workouts, 47 have a full set of `done=true` rows — all of them logged during periods when a plan was active (e.g. Jun 22 / Jun 23 / Jun 27 ad-hocs sit inside plan `c9c47b2f` / `29b60a33` active windows). The single exception is the session on the day the bug was reported, the only one logged with every plan `is_active=false`:

```
2026-07-20 | plan_id NULL | sets: 2 | done: 0     <-- no active plan
2026-06-27 | plan_id NULL | sets: 23 | done: 23   <-- plan active
2026-06-23 | plan_id NULL | sets: 7  | done: 7    <-- plan active
```

### Why partial rows exist rather than none

The affected session has two `done=false` rows at `set_order` 1 and 2, and nothing at `set_order` 0. That signature is the bug's fingerprint, not a contradiction of it:

- **Tap 1 (check on):** `sl.done = true` in memory → TypeError → no row, no re-render. From the user's side the tap did nothing.
- **Tap 2 (same checkbox):** `toggleSet` now reads `wasDone = true`, so `_toggleSetCommit` sets `sl.done = false` and **skips the entire `if (sl.done)` block** — including the unguarded lookup. No crash. `persistSet` runs and inserts the row **with `done: false`**.

So a set the user tapped twice got saved as *not completed*, and a set tapped once got no row at all. Both read as "it didn't save." The `weight`/`reps` on those rows came along because `logSet` had already stamped them in memory. Nothing about this was recoverable as completed work — `completed_at` is null on both.

### Debugging path

1. Read the ad-hoc write path end-to-end: `toggleSet` → `_toggleSetCommit` → `persistSet` → `_persistSetInner` → `buildSetPayload`.
2. Grepped `plan\.days\[` filtered against the guarded forms — 2529 stood out as unguarded in a function whose *other* two plan reads were guarded.
3. Confirmed against real shipped code rather than by inspection: extracted the `_toggleSetCommit` source out of `js/data.js` at runtime, ran it in a sandbox with stubbed `persistSet` / `buildDay`, once with a plan and once with `plan = null`. First passed, second threw and recorded zero `persistSet` calls. Re-ran after the fix; both passed.

### Lessons

- **A guard added in three places and missed in one is the default failure mode.** The cascade and rest-timer lookups in this same function were both written defensively. Whoever added them was reasoning about the no-plan case and still missed the auto-fill lookup ten lines up. When adding a null guard, grep the whole function for the same deref rather than fixing the line in front of you.
- **Un-awaited async callbacks convert crashes into data loss.** `promptResumeIfEnded(fn)` calls `fn()` without awaiting because it can't know whether the action is async. Every async action passed through it loses its error reporting. The persistSet toast was well-designed and completely bypassed.
- **Optimistic in-memory mutation before the persist call hides the failure for the whole session.** `sl.done = true` ran before the throw, so the UI kept showing the set as logged. Failing writes should either mutate after the await or roll back on catch.
- **"Works with a plan, fails without" is a null-object smell.** The plan-active case passed through the same buggy line and short-circuited harmlessly on a string key. A code path that's accidentally safe in the common configuration will not be exercised by ordinary use.

## 2026-05-10 — History-edit modal silently freezes after the first edit (v3.6.6)

### Symptoms

After v3.6.3 added `+ Add Set` / × delete to history-edit mode, the user reported: "the edit history modal is having a bit of trouble — it either takes very long to check the new set. Something is getting hung up." Reproducer: open a historical workout, hit **Edit**, tap `+ Add Set`, then tap the check (`·`) on the newly-added set. The first tap appeared to do nothing. Subsequent taps on anything in the modal — toggle done on a different set, edit a weight value, the Edit toggle itself — all silently failed too, until the modal was closed and re-opened (or another path re-populated the detail cache).

### Root cause

`invalidateHistoryCache()` ([js/ui.js:6943](js/ui.js#L6943)) wipes **three** in-memory caches:

```js
function invalidateHistoryCache() {
  historyWeekCache = {};
  historyDetails = {};        // <-- wipes the open modal's cached detail!
  earliestWorkoutDate = null;
}
```

That function was designed for paths that legitimately drop the detail (workout discard, complete/resume, ad-hoc delete, duration-edit which re-fetches). But over time **every** in-modal history-edit handler started calling it for week-summary freshness — 7 sites: toggle done, +Add Set (v3.6.3), × delete (v3.6.3), value edit, RPE, exercise note, workout notes.

Each in-modal handler's pattern:

```js
historyUpdateSetDone(sl.setId, newDone, ...).then(function() {
    sl.done = newDone;
    // ... mutate sl ...
    invalidateHistoryCache();        // wipes historyDetails entirely
    renderHistoryDetail(detail);     // still works — uses local `detail` closure
});
```

The visible re-render kept working because `detail` was held in the closure. But the **next** click into the modal:

```js
function onHistorySetCheckClick(btnEl) {
  var widCheck = _historyDetailWorkoutId();      // reads from DOM toggle button — fine
  var detail = widCheck && historyDetails[widCheck];   // <-- undefined after wipe
  if (!detail) return;                                  // <-- bails silently
  // ... rest of handler never runs
}
```

Click → bail at the guard → user sees nothing happen. Hence "hung up."

The bug had been latent across all in-modal value edits since v2.5.13 — users probably never noticed because value-edit handlers don't re-render (focus preservation) and the typed value lives in the DOM. The v3.6.3 +Add Set flow exposed it sharply because the user immediately clicks the new set's check button, which IS a click handler that needs `historyDetails[wid]` to fire.

### What was fixed

Added a narrower `invalidateHistoryWeekCache()` that wipes only the week-summary state, preserving `historyDetails`:

```js
function invalidateHistoryWeekCache() {
  historyWeekCache = {};
  earliestWorkoutDate = null;
  // NOTE: historyDetails intentionally preserved so the open modal
  // stays interactive across edits.
}
```

All 7 in-modal handlers swapped to this. Paths that legitimately need a full detail-drop (workout discard, complete/resume, ad-hoc delete, duration-edit which re-fetches) keep the original `invalidateHistoryCache`. Idempotent — in-modal handlers had already mutated the in-memory detail before calling the helper, so dropping `historyDetails` was always redundant noise anyway.

### Debugging path

Took ~10 minutes once the symptom was reproduced — clean root-cause investigation:
1. Read the v3.6.3 `onHistoryAddSet` + `onHistorySetCheckClick` handlers end-to-end.
2. Traced `_historyDetailWorkoutId()` to confirm `widCheck` resolves from the toggle button's `data-workout-id` attr (still in DOM after a wipe).
3. Spotted the `var detail = widCheck && historyDetails[widCheck]; if (!detail) return;` pattern in `onHistorySetCheckClick` — would silently bail if the entry was gone.
4. Grepped `invalidateHistoryCache\b` for all call sites — saw 7 in-modal callers, all in handlers that had already mutated the in-memory detail.
5. Read `invalidateHistoryCache` itself, confirmed it wiped `historyDetails`.

### Lessons

- **Silent-bail guards turn cache invalidation into UI freeze.** When a click handler reads from a cache that another handler can wipe, the cache wipe propagates as "click did nothing." If you must keep the bail, also re-hydrate the cache entry before bailing.
- **Co-location of mutation and invalidation hides bugs.** The pattern of "mutate state → invalidate cache → re-render" looked correct in each individual handler. The bug was visible only by looking at what `invalidateHistoryCache` actually did to *unrelated* state.
- **A monolithic invalidate function gets misused.** `invalidateHistoryCache` was designed for full-detail-drop paths but read like a generic "freshen up after a change" helper. Splitting it into `invalidateHistoryWeekCache()` (narrow) + `invalidateHistoryCache()` (full) makes the right choice at each call site obvious. Lesson generalizes: a helper that does multiple things gets called from contexts that only need one of them.
- **v3.6.3 didn't introduce the bug; it lit it up.** The latent failure had been there for value edits since v2.5.13. The interactive feedback loop on +Add Set / check-toggle was just the first surface where the silent failure was sharp enough to notice. Always worth checking whether a "new feature broke X" report is actually "new feature exposed a pre-existing X."

## 2026-04-20 — AI plan generation: intermittent 55s+ timeouts after adding user inputs (v2.0.25)

### Symptoms

After Part 2c.6 shipped the pre-generate inputs form (start date / target duration / notes), plan generation started timing out intermittently on the same payload that had previously succeeded in 30s. Two consecutive calls with identical inputs: one at 29.8s success, the next hanging past 90s until user-canceled. Console test and UI call both affected. Earlier part of Session B (before 2c.6) had been consistent at 30-35s on Sonnet.

### Mis-diagnosis loop (what wasted time)

Before reaching the actual root cause, the debugging path detoured through:
1. **"It's just Anthropic latency variability"** — plausible but unfalsifiable; dismissed too long.
2. **"Switch to Haiku"** — offered repeatedly as a workaround; user rejected: they wanted Sonnet-quality output, not a model downgrade masking the real issue.
3. **"Upgrade to Vercel Pro for 300s timeouts"** — valid workaround but doesn't explain *why* generation got slower.
4. **"Maybe the cache TTL isn't honoring the 1h setting"** — ruled out by direct evidence of cache hits (`cache_read_input_tokens: 8634`) on successful calls.

The breakthrough came when the user pointed out the correlation bluntly: *"Before manual inputs = fast. After adding manual inputs = slow. Wouldn't it stand to reason the issue is in how the inputs are being injected into the prompt?"*

### Root cause

Two independent prompt-design problems combined to push generation time over a 55s hard timeout:

**1. Instructional text in the user message caused longer reasoning.** Part 2c.6 added a new instruction to the generation prompt:

> *"Respect any user inputs above when programming — adjust volume, intensity, or exercise selection as needed."*

This one sentence pushed Claude into longer reasoning chains and more verbose output. Measured impact after removing it: **output dropped from ~2600 to ~1500 tokens (-40%), latency from ~30s to ~23s.** On Anthropic slow-response days, the extra ~6s of generation was what tipped otherwise-fine calls over the 55s abort threshold.

**2. No explicit handling rules for runtime inputs in the system prompt.** The prompt had no section on what to do with `start_date`, `target_duration`, or `notes`. When inputs appeared in the user message, Claude had to reason per-call about:
- Is `start_date` overriding the "increment week number by one" rule elsewhere in the prompt?
- Does `target_duration` replace the generic "55-65 min" guideline?
- Should `notes` override other programming rules?

Every ambiguity = reasoning tokens = latency. And those reasoning tokens happened in the *uncached* user-message part of the prompt, so they recurred on every call.

### What was fixed

**Removed the instruction sentence from dynText.** One-line change in [api/generate-plan.js](api/generate-plan.js). Eliminates the "think harder about inputs" directive entirely.

**Added a cached USER INPUTS section to the system prompt** ([system-prompt.md](system-prompt.md)). Explicit rules with defaults and priority:
- `Plan intended start date` (YYYY-MM-DD): default to Sunday-after-today if absent. Use for phase-awareness grounding.
- `Target session duration`: default 60 minutes. Overrides the generic 55-65 min target.
- `Notes from client`: default to no special considerations. Notes override other rules verbatim.
- **Priority rule**: user inputs override generic guidance. Do NOT spend reasoning effort reconciling inputs with other sections.

Because this lives in the *cached* system prompt (with `cache_control: { type: "ephemeral", ttl: "1h" }`), Claude sees the handling rules once at cache write and reads them cached on every subsequent call. Zero per-request reasoning overhead.

**Simplified the `week` field rule.** Previously: *"emit 'Week 5' and increment the number by one"* (forcing Claude to reason about current week number from context). Now: *"any concise label works; the app normalizes to Sun-Sat range on save via `savePlanAsActive`."*

**Added a 55s AbortController timeout** on the Anthropic fetch with a Cancel UI button so stuck upstream calls surface as clean 504 errors rather than infinite spinners. (Separate hardening — doesn't fix the latency, just makes failure graceful.)

### Measured results after fix

| Metric | Pre-fix | Post-fix |
|---|---|---|
| Output tokens (same payload) | ~2600 | ~1500 |
| Elapsed (cache hit) | 29.8s → timeout | 22.5s |
| Coaching notes length | 282 chars | 241 chars |
| Exercise notes present/omitted | — | 6 / 23 |
| Timeout rate | intermittent | zero |

### Debugging learnings (for future AI/prompt work)

- **Trust the user's correlation hypothesis.** "Before X = fast, after X = slow" is high-signal data even when the mechanism is non-obvious. Don't blame "variability" for observations the user says are systematic.
- **Instruction text in prompts has real latency cost.** A single "think carefully about X and adjust" sentence can add ~1000 output tokens on reasoning-capable models. Even when constraints (word caps, hard rules) are already present, directives that nudge toward more reasoning compound on top.
- **Put rules in the cached system prompt, not the per-request user message.** Anything that requires consistent reasoning across calls belongs in the cached prefix. Runtime *data* (what the user typed) goes in dynText; runtime *rules* (how to interpret it) go in the cached system prompt.
- **Set defaults explicitly, even for optional inputs.** A prompt that says "if absent, default to X" removes per-call decision work. Without it, Claude re-derives defaults every time.
- **Always have a hard client-side timeout on LLM calls.** Our 55s `AbortController` is what kept the UI from hanging indefinitely during the bad runs. In production with Vercel Hobby's 60s function cap, the timeout also ensures we return a clean error envelope before Vercel hard-kills the function.
- **Measure output tokens before blaming the model.** `usage.output_tokens` is the single best signal for "why is this slow?" — Sonnet generates at ~70-90 tok/s, so a call producing 3500 tokens is inherently 40-50s of generation time regardless of Anthropic load.

### Leftover concerns (not fixed this session)

- **Anthropic service-tier variance** is real but orthogonal. Same input can return in 25s or 40s depending on their routing (`inference_geo: "global"`). Our 55s timeout has headroom for normal variance but not for extreme slow-spell + bloated-output combined.
- **Vercel Hobby 60s function cap** remains the hard ceiling. If output tokens ever creep back up (e.g., prompt changes that again invite verbosity), we'd see timeouts return. Defense: keep the `[generate-plan] claude call: X ms · usage: {...}` server log watchable; if `output_tokens` crosses ~2500 on a regular basis, re-tighten the prompt before it tips over.

## 2026-04-19 — "View Recent" modal: doubled sets + blank exercises (v2.0.15)

### Symptoms

Per-exercise View Recent modal showed two independent issues:
1. **Doubled sets on historical sessions.** Pull-ups on April 12 displayed `0 × 12 · 0 × 12 · 0 × 12 · 0 × 12 · 0 × 7 · 0 × 7` when only 3 sets were actually performed (2×12, 1×7). Same pattern across the entire "Fitbod Import" history (every exercise, every imported session).
2. **Blank modal for exercises with known prior history.** DB Romanian Deadlift opened the modal but rendered "No prior sessions logged" despite 10+ weekly Fitbod sessions on record.

### Root causes

**Bug 1 — Fitbod Import script ran twice.** Historical Fitbod CSV data was imported via SQL scripts pasted into the Supabase SQL Editor. One of the import batches was executed twice, silently double-inserting every set. Evidence: identical `completed_at` timestamps to the second across all duplicate pairs, and duplicate `(workout_id, exercise_id, exercise_order, set_order)` tuples across ~22 "Fitbod Import" workouts. Roughly 1107 extra rows total.

**Bug 2 — Orphan user-custom exercise row intercepted `resolveLibraryRow`.** A `db romanian deadlift` row in `exercises` with `user_id = <uid>` and `is_custom = true` existed from pre-`v2.0.10` `ensureExerciseId` behavior (before the resolver landed, every plan exercise name was upserted as a user-custom row). [resolveLibraryRow](js/resolver.js) tries raw-normalized candidates before applying the alias map, so for "DB Romanian Deadlift" it hit the orphan (4 sets, all from today's workout) *before* the alias `'db romanian deadlift' → 'dumbbell romanian deadlift'` got a chance. All 4 orphan sets then got filtered out by `todayState.workoutId` exclusion in `openExerciseHistory` → blank modal. Meanwhile the ~40 Fitbod Import sessions stayed stranded on the canonical seed row.

### What was fixed

**Data cleanup (SQL run in Supabase dashboard, one-off, not a migration):**

- **Deduped Fitbod Import sets** — kept one row per `(workout_id, exercise_id, exercise_order, set_order, done)` tuple. ~1107 duplicate rows deleted.
- **Merged orphan `db romanian deadlift`** → canonical `dumbbell romanian deadlift` via `UPDATE sets SET exercise_id = <canonical>` then `DELETE FROM exercises WHERE id = <orphan>`.
- **Deleted empty orphan `db bench press`** — 0 sets, safe straight delete.
- **Merged `cable crossover` → `cable fly`** for this user's sets (19 sets moved). Fitbod used "cable crossover" where the plan uses "Cable Chest Fly"; merging onto `cable fly` lands them on the same canonical.
- **Plan JSON clean-up** — renamed "Weighted Reverse Crunch" → "Reverse Crunch" (so the resolver finds the canonical where Fitbod history lives, since both names exist as distinct seed rows and raw-normalized wins over alias); removed vestigial "VO2 Max 4×4 Intervals (Saturday)" and "Zone 2 Walk (Friday)" entries.

**Code changes ([v2.0.15](js/app.js)):**

- Added `'db bench press' → 'dumbbell bench press'` to [EXERCISE_ALIASES](js/resolver.js#L17-L37) so future logging under the "DB Bench Press" plan name doesn't create a new orphan (the existing `db flat bench press` alias didn't cover the plain form).

**Schema hardening ([new migration](supabase/migrations/20260419010000_sets_unique_position.sql)):**

- Partial unique index `sets_unique_position_per_workout` on `sets (workout_id, exercise_id, exercise_order, set_order) where done = true`. Would have 23505'd the Fitbod Import re-run. Applied after data cleanup so existing duplicates don't block it.

### Debugging path (for future sessions)

Query progression that isolated the bugs:
1. Q1 — `count(sets)` per workout on affected date → **one workout, 6 sets** (not two workouts).
2. Q2 — raw set rows → **identical `completed_at` across duplicates, duplicate `set_order` pairs**.
3. Q3 — user-custom exercises with done counts → found 2 orphans.
4. Q4 — where DB RDL history lives (orphan vs canonical) → confirmed 10 Fitbod sessions on canonical, 4 orphan sets all on today's workout.
5. Q5 — scope check across all Fitbod Imports → `done_rows = 2 × distinct_positions` uniformly.
6. Q6 — all exercises matching affected names → confirmed orphan was intercepting resolver.
7. Q (b) — all Fitbod Import exercise names → used to cross-reference plan coverage and identify mismatches.

### Known leftover concerns (not fixed this session)

- **Pseudo-seed rows from Fitbod Import script.** Several Fitbod exercise names that aren't in the app's seed library (`kettlebell sumo squat`, `stability ball roll out`, `tuck crunch`, `cable chest press`, `hammerstrength incline chest press`, `hammerstrength chest press`, `balance trainer reverse hyperextension`, `exercise ball crunch`, `bench dip`, `tricep push up`, `vertical leg raise`, `calf press`, `tricep push up`) were inserted with `user_id = NULL` and `is_custom = false` — pseudo-seeds that pollute the global library. Harmless for a single-user app; cleanup deferred. If multi-user support ever ships, these need to be either promoted to real seeds or moved to user-custom.
- **Resolver ordering: raw-normalized wins over alias.** The `weighted reverse crunch` case exposed that when a seed and an alias target both exist, the raw-normalized candidate short-circuits before the alias runs. Worked around by renaming the plan entry; a deeper fix would be a separate "override" map or re-ordering the candidate generation. Not urgent — the resolver is scheduled to be replaced by plan-import-time resolution (see ROADMAP.md → "Resolve plan exercise names at import time").
- **Migration application.** `20260419010000_sets_unique_position.sql` must be applied against the live Supabase database (the file in the repo is forward-only but not auto-applied). Apply via the SQL editor or Supabase CLI if not already done.
