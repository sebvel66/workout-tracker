# Roadmap

Forward-looking scope for the workout tracker. Updated 2026-04-20 at end of Session B. Each entry notes whether an explicit design exists (→ `DECISIONS.md`) or it's just a recorded idea.

## Shipped — Session B (2026-04-20)

Everything in this block is **live at www.sebvel.app** as of `v2.0.25`. For the debugging narrative behind the Sonnet-latency tuning, see `MAJOR-BUGS.md` (2026-04-20 entry).

- **Weekly History browser (`v2.0.19`).** Sun-Sat week navigator, summary stats (days trained/planned, total volume, avg RPE, plan completion), skipped-exercise callout, workout cards with drill-down. Reusable `fetchWeekSummary(userId, weekStart, weekEnd)` primitive powering both the History UI and the AI Edge Function's `formatVerbatimHistory`.
- **Physique photos (`v2.0.20`).** Goal + progress photos in a three-view modal (gallery / upload / viewer). Private Supabase Storage bucket with path-prefix RLS (`{user_id}/{uuid}.{ext}`), signed URLs cached in memory for 1h. Photos feed the AI planner as multimodal image blocks.
- **AI plan generator.** End-to-end: Vercel Node serverless function at `api/generate-plan.js`, Claude Sonnet 4.6 with prompt caching (2 breakpoints, 1h TTL), `repeat: N` shorthand for identical sets with server-side expansion, 55s `AbortController` timeout. 22-30s per generation on cache hit, ~$0.035 per call.
- **Generate + Review UI (`v2.0.21`).** Hamburger entry → inputs form → loading spinner → review overlay with coaching notes card and day-by-day breakdown → Accept/Cancel. Accept calls `savePlanAsActive` which stamps `plan.start_date` client-side and normalizes `plan.week` to Sun-Sat.
- **Plans management (`v2.0.22`).** Hamburger entry listing all plans with Active badge, workout count, Activate (disabled on currently-active), Delete (disabled if workout count > 0). Enables recovering from accidental mid-week plan accepts — just re-activate the old plan.
- **Week-label fix + historical auto-load on hydrate (`v2.0.24`).** Tracker header now shows Sun-Sat labels matching the History browser; plans saved before start_date stamping self-heal via `ensureStartDate(blob, dbRow)` injecting `plans.created_at` at render time. On fresh page load, Day 1 tab auto-loads the most recent historical workout for that day_index regardless of `plan_id`.
- **Pre-generate inputs form + cached USER INPUTS guidance (`v2.0.25`).** User can set start date, target session duration, and notes to coach before generation fires. System prompt gains a cached USER INPUTS section with defaults (next Sunday / 60 min / no special notes) and priority rules (user inputs override generic guidance, don't reconcile, just apply). Moving interpretation rules into the cached prefix eliminated the 55s timeouts we were hitting from instruction-text in dynText.
- **Cold-start UX + photo parallelization (`v2.0.26`).** Silent client-side retry on network / 5xx / 504 makes the Anthropic prompt-cache miss invisible. Loading copy swaps to "Still generating — warming up the AI…" on attempt 2. 4xx errors pass through immediately. Server-side goal + progress photo downloads now run in parallel via `Promise.all` (~200-500ms saved). Rejected alternatives — query parallelization (already shipped), history-scope reduction (wrong diagnosis), cron warm-up (deferred) — documented in [DECISIONS.md](DECISIONS.md) 2026-04-20 entry.
- **User-controlled plan inputs + system prompt cleanup (`v2.0.27`).** Generate form gains Training days (1-6, default 5), History context (1-12 weeks, default 4), and Include physique photos (checkbox, default off — opt in when photos are new). Server clamps + validates, `validatePlan` enforces exact day-count match, and the system prompt is rewritten so USER INPUTS is the single source of truth for day count. Four residual COACHING-PHILOSOPHY phrases audited and scoped to the new inputs so generic coaching guidance can't conflict. Photo-handling section intentionally unchanged — already conditional on image presence. Closes two ROADMAP items: "Configurable AI context window" and the day-count flexibility implied by replan-remainder mode (though replan-specific behavior is still future).
### Shipped — v2.1.0 (2026-04-20)

First v2.1 bundle. Three features as one minor-version bump.

- **Plan templates.** Templates are `plans` rows with `is_template = true` + `template_name`. Single hamburger entry "Save as template" opens a modal with a scope picker (Whole plan vs Just "[focused day]"). "Templates" management modal lists all saved templates. Start-session modal gets a 4th card "Use a template" — single-day templates create the session immediately, multi-day templates expand inline to show day rows. Plans-modal rows get a "Template" button for historical plans. Migration `20260420010000_plan_templates.sql` adds `is_template bool` + `template_name text` + a partial index keyed to template rows.
- **AI exercise swap.** Small ⇄ icon on plan exercise cards (editable mode only) opens a modal that finds an AI-suggested replacement for one exercise via `POST /api/generate-plan { mode: "swap", ... }`. Server early-dispatches to `handleSwap` with its own inline system prompt (1h cache, 500 max tokens, ~8-15s warm). Optional reason input ("different gym", "knee pain", etc.) factors into selection. On Accept, mutates `plan.days[di].exercises[ei]` and writes `plans.data`. Already-logged sets stay attached to their original `exercise_id` in the sets table.
- **View Recent enhancements.** Exercise-level notes now surface below RPE in the View Recent modal (muted italic). Gym location tag gets an "@" prefix for clarity. Both lines render only when data exists — no empty placeholders.

### Shipped — v2.3.2 (2026-04-21)

- **Core prompt audit — strip dangling plan-input references.** v2.3.0's three-way split left four spots in `system-prompt-core.md` that still referenced `Training days` / `Target session duration` (plan-only inputs). In analyze mode those references dangle because the inputs aren't in the user message. Stripped all four; verified plan suffix already covers every removed directive. Core is now cleanly mode-neutral.

### Shipped — v2.3.1 (2026-04-21)

- **Multi-photo comparison in analyze mode.** Analyze now fetches up to 4 progress photos (previously 1) and emits them chronologically with explicit date + sequence labels. Prompt requires two photo comparisons: latest-vs-goal (which muscle groups are close / which lag) and progress-over-time (what changed / what stagnated). Observations weave into the existing four sections. `fetchPhysiquePhotos` parameterized so plan-gen keeps its 1-photo default (no token bloat there).

### Shipped — v2.3.0 (2026-04-21)

- **Training analysis split off from plan generation.** Plan-gen now returns structure only — `coaching_notes` removed from the contract and every "flag in coaching notes" directive stripped from the prompt. Expected 5-10s faster plan generation from dropped reasoning overhead. New `mode: 'analyze'` branch on `/api/generate-plan` produces a four-section structured written assessment (`trends` / `progressing` / `concerns` / `next_week`) on Sonnet with the same history window + photo context as plan-gen. ~15-25s warm per analyze call, ~$0.03.
- **Shared-core prompt architecture.** System prompt split into three bundled files via `system-prompt-*.md` glob: `core.md` (shared CLIENT PROFILE + COACHING PHILOSOPHY + EXERCISE LIBRARY), `plan.md` (plan-mode suffix), `analyze.md` (analyze-mode suffix). Cold start assembles two final strings, each with its own `cache_control` 1h TTL.
- **Analyze → plan chaining.** "Use for next plan" button on the analyze review formats the four sections with labels and pre-fills the plan-gen notes field, switching back to inputs with all other inputs preserved. One click to feed analysis forward as coaching guidance for plan-gen.
- **Generate form UX:** three buttons (Cancel / Analyze / Generate Plan). Loading + review copy adapt to the selected mode.

### Shipped — v2.2.6 (2026-04-21)

- **Day-dropdown completion dot hotfix.** The `●` on each plan day in the dropdown now renders correctly on first paint (hard reload). Previously it required selecting a day to trigger the lazy `historicalCache[i]` populate; non-focused days with prior workouts showed no dot. Fix: new `daysWithHistory` eager map populated by one cheap query at hydrate; dot check uses it alongside `historicalCache[i]` as a fallback. Reset + reloaded on plan switch and sign-in.

### Shipped — v2.2.5 (2026-04-21)

- **Drag-to-reorder exercise cards.** Long-press (400ms) → SortableJS lift → drop within the same sort zone. Two zones on plan days (prescribed / extras, can't cross); one zone on ad-hoc. Plan-zone reorder mutates `plan.data` (same scope as Swap — *"for the rest of the week"*); extras / ad-hoc reorder is session-only. Current workout's sets are remapped so each stays attached to its exercise across the drag; remap is two-phase (`+10000` temp shift) to dodge the partial unique index on `(workout_id, exercise_id, exercise_order, set_order) WHERE done = true`. SortableJS 1.15.2 via CDN.

### Shipped — v2.2.4 (2026-04-21)

- **Manual session duration adjustment.** `✎` button next to every duration display (running timer, completed-today, historical day view, ad-hoc running/completed, history detail). Prompts for minutes (0-600 validated), back-computes `started_at = (ended_at || now) - minutes*60000` and zeros `paused_ms`. Context-aware refresh — today patches in-memory state + re-renders; history invalidates cache + re-opens detail. No schema changes.

### Shipped — v2.2.3 (2026-04-21)

Hotfix for three v2.2.2 regressions surfaced during local-dev testing.

- **PostgREST FK ambiguity (PGRST201)** — v2.2.1's migration added `sets.prescribed_exercise_id` as a second FK from `sets` to `exercises`. Broke `fetchWeekSummary` ("couldn't load week"), coach context's recent-performance block, `runExport`, and the Edge Function's history fetch (which is shared with swap mode — this was the real cause of "swap not working"). Fix: disambiguate each embed as `exercises!exercise_id(...)`.
- **"Bring to today" did nothing visible** — `reactivateWorkout` updated `performed_on` but not `performed_at`. Hydrate filters today's workouts by `performed_at`, so the reactivated workout was excluded → `todayPlanStates` empty → session-start modal popped up instead. Fix: add `performed_at: now` to the UPDATE.
- **Discard typo** — called `renderHistory()` instead of `renderHistoryWeek()`. DB delete actually succeeded but the ReferenceError surfaced as a misleading error toast requiring hard-reload. Fix: typo corrected.

### Shipped — v2.2.2 (2026-04-21)

- **Session lifecycle recovery.** History detail modal gains "Bring to today" (moves a past workout to today with timer reset, sets preserved) and "Discard session" (deletes the workout + cascades sets). Today's 0-set in-progress plan-day session gets a dashed "Cancel session" affordance under the session bar. Closes the midnight-trap bug where accidentally-started-and-paused sessions couldn't be recovered.
- **Swap regression fix.** v2.2.1's `updateExerciseFanOut` was erasing pre-swap sets' exercise_id on any RPE/note tap. Reverted fan-out to rpe+note only; substitution retargeting moved into `logSubstitute` with a precise filter that only touches sets currently matching the pre-change actual.
- **Toast × close button.** Explicit dismiss affordance on every toast. `stopPropagation` ensures × on a retry toast doesn't accidentally fire the retry callback.

### Shipped — v2.2.1 (2026-04-21)

- **Structured per-session substitutions.** Free-text SUB field on plan exercise cards replaced with a library picker. `sets.exercise_id` now means "what actually happened"; new `sets.prescribed_exercise_id` column records the plan's ask. Substituted sets file under the substitute's history automatically; plan adherence and v2.2.2's AI substitution-pattern query become trivial. Scope callouts (toasts on both swap accept and substitute apply + warning in the swap review modal) make the plan-durable-vs-session-only distinction explicit. Weight-mode + display-name track the substitute. Legacy free-text values render read-only with a re-link affordance. AI weight/rep recommendation for substitutes → v2.2.2.

### Shipped — v2.2.0 (2026-04-20)

- **Coach Chat.** Real-time AI coaching via floating chat button. Haiku 4.5 on a new endpoint at [api/coach-chat.js](api/coach-chat.js); ~1-2s warm response. Four-layer context (system prompt / semi-static per-session / live per-message / ephemeral history). Plan prescription inline in live context so standardization comparisons land in one line. Cron warmup runs daily at 5am ET for both endpoints — Vercel Hobby caps crons at once-per-day max, blocking the original `*/5` / `*/10` design. Narrow benefit (warms for ~15-45 min after the ping); external pinger or Pro upgrade would unlock per-minute crons. Chat history intentionally ephemeral for v1 — persistence is a candidate follow-up.

## AI / Coaching (v2.3+)

Next-tier AI features not yet built. Order is rough priority.

- **Adaptive coaching profile — three layers:**

  1. **Manual coaching profile (v2.5):** A `coaching_profile` table with user-editable fields: current weight, current goal (bulk/cut/maintain), active injuries, equipment access notes, training preferences, special instructions. Editable via a "Coaching Profile" screen in the hamburger menu. The Edge Function reads this on every plan generation and chat call, injecting it into the prompt alongside the static system prompt. This replaces hardcoded values in the system prompt (like body weight, injury list, and cut timeline) with live data the user can update anytime.

  2. **AI-generated behavioral observations (v2.6):** After each plan generation, Claude also produces 3-5 short behavioral observations about patterns in the data. Stored in a `coaching_observations` table (user_id, observation, observed_at, category). The most recent 8-12 observations are included in future prompts as "COACH'S RUNNING NOTES" — giving the AI continuity between sessions. Examples: "Client hit 3×12 on cable row 2 weeks running — ready to progress", "Rear delt work consistently completed — no longer a skip risk", "Knee pain not mentioned in 4 weeks — may be resolved."

  3. **Periodic prompt self-revision (v3):** Every 4-6 weeks, a special "coaching review" call where Claude reviews the full system prompt against 6 weeks of data and proposes updates to the behavioral and injury sections. User reviews a diff before changes take effect. The coach effectively rewrites its own instructions based on evidence.

- **Persistent chat history.** Store coach messages in a new `coach_messages` table so past conversations survive reloads and the plan generator can reference coaching advice across sessions. ~15 min of code on each side plus schema. Revisit if ephemeral feels wrong in practice.
- **Replan-remainder mode.** User generates Wed evening after completing Days 1-3; Edge Function detects completed days this week and generates only the remaining 2 days. Scope hinted at in the Part 2 spec but deferred for MVP. Would require: a new API mode field, detection of completed days in the request handler, and a prompt addition describing "replan" context.
- **Automatic deload detection.** AI proactively suggests a deload without the user requesting a plan. Triggered by: RPE trending up for 3+ weeks, session completion rate dropping, pain notes in session data. Could surface as a banner in the tracker: *"Your RPE has climbed for 4 weeks — consider a deload this week. Generate a deload plan?"*
- **Iterative-refine: diff visualization on the review screen.** Follow-up to the v2.5.3 iterative refine loop. Right now each refinement replaces the displayed plan and shows a "WHAT CHANGED" banner in Claude's words; visually, the day cards just re-render with no per-exercise diff. Worth adding: highlighted borders on changed exercises (added in green, removed crossed out, weight/rep changes annotated inline like "↑ 65→70"). Diff would be computed against the prior iteration's plan blob (`iterationHistory[length-1].plan`) at render time. Estimate: ~1.5-2 days. Defer until the change-notes-only UX feels insufficient — for short refinements ("move pull-ups to Day 3") the banner alone is usually clear enough.
- **Iterative-refine: routing templates through the refinement loop.** Follow-up to v2.5.3. Currently "Use a template" expands a saved plan into an ad-hoc session immediately; there's no way to tweak a template before activating. Worth adding: a "Modify before using" path that opens the template in the plan-gen review screen with the existing iteration loop available, then activates the refined plan. Touches the templates flow + the review screen's plan source. Defer until there's a real use case (today, the workaround is to activate the template as-is and swap exercises afterward).
- **Side-by-side progress photo comparison with AI commentary.** Layer 3 of the photo feature. Chronological grid view with AI-generated observations on visible changes ("delts have filled in since March, quads slightly leaner"). Requires: a batch-photo-analysis Edge Function, UI for the grid + callouts.
- **PR detection.** Automatic flagging when a logged set is a personal record (most weight at rep count, most reps at weight). Indexed queries on the `sets` table already support this. Could show as a badge on the set row, a toast on save, or a dedicated PR list in the History browser.
- **Progression charts.** Weight/volume/RPE trends over time per exercise. `openExerciseHistory` already queries the data; needs a chart rendering layer (chart library choice: probably Chart.js for zero-dependency inline usage, or recharts if we ever add a build step).
- **Exercise substitution intelligence (v2.2.2 split).** Two pieces now that the v2.2.1 schema captures substitutions structurally:
  - **Per-session recommendation:** new `mode: "substitute_recommend"` branch on `/api/generate-plan`. After the user picks a substitute, a post-pick sheet offers *"Get AI weight/rep recommendation?"* — Yes / No (manual) / Cancel. AI calibrates against the substitute's history. Suppressed when the user has no history on the substitute yet.
  - **Cross-week substitution patterns in the planner prompt:** aggregate `WHERE prescribed_exercise_id != exercise_id` over the last N weeks; surface consistent swaps to Claude so future plans propose the substitute directly (e.g., *"you swapped BSS for leg press 3 weeks running — consider programming leg press instead"*). Already has a dedicated partial index (`sets_substitutions_by_user`) from v2.2.1's migration.
- **Multi-week periodization.** Generate a 4-week mesocycle in one call rather than week-by-week. Harder prompt-engineering — Claude would need to plan progressions across all 4 weeks coherently. Feasible but adds significant output length; probably needs Vercel Pro for the longer call.

## Infrastructure / scaling

- **GitHub Actions warmup workflow — two layers.** The `vercel.json` cron at `0 9 * * *` is **decorative** in practice: Vercel Hobby caps crons at once-per-day, and by the time the user actually opens the app (not at 5am EDT), the Fluid Compute instance has recycled and the Anthropic cache has expired (1h TTL). Two targeted upgrades, both deferred until cold-start pain is measurable:
  - **(a) Replace the Vercel cron with a GitHub Actions workflow pinging `?warmup=true`** on every ~10 min. Free for public repos; for a private repo, scope the schedule to 6am-11pm local to stay under the 2000-min/mo free budget. Fifteen-line YAML file. Only warms the Fluid Compute instance (the `?warmup=true` branch returns early without touching Anthropic), so this buys ~500-1500ms of saved JS/module cold-start time per call. Known gotcha: GitHub Actions schedules can be delayed 15-30 min under load — fine for our use case but not guaranteed timing.
  - **(b) Keep the Anthropic prompt cache warm too (huge maybe).** Modify the warmup handler to make a minimal Anthropic call on the warmup path — same cached system prompt, trivial user message, `max_tokens: 10`. This actually keeps the 1h Anthropic TTL refreshed. Estimated cost at every-50-min cadence: ~$3/mo of extra input tokens (cache hits are ~$0.003/call). Only worth doing if the ~30-35s cold-start Anthropic cache-miss is genuinely painful — the v2.0.26 silent-retry already hides it for plan-gen, and analyze is rare enough that paying the miss once per session is tolerable. Per-mode: the Anthropic cache is per-system-prompt-prefix, so warming only helps the mode the warmup call uses — would need two warmup variants to keep both plan-gen and analyze caches hot.
  - Both layers supersede the current Vercel cron, which would be removed from `vercel.json` once GH Actions takes over. Pro upgrade ($20/mo) is an alternative to both but costs 6-7x more than the GH Actions + ~$3 Anthropic cost with less flexibility.
- **Vercel Pro upgrade ($20/mo).** Function timeout goes from 60s to 300s. Would eliminate the 55s timeout concern entirely and open space for multi-week periodization, streaming, bigger output windows. Low-priority as long as Sonnet + 1h cache stays within 30s typical.
- **Anthropic SDK swap.** Currently using raw `fetch` in `api/generate-plan.js` for zero-dep deployment. Could swap to `@anthropic-ai/sdk` for typed responses, retry handling, streaming support. Only worth it if we move to chat/streaming UX.
- **System prompt admin UI.** Currently edit `system-prompt.md` + commit + redeploy. If prompt iteration becomes frequent, a Supabase-backed prompt row + hamburger-menu editor would let the user tweak without a deploy loop. Deferred per DECISIONS.md — current flow is fine for weekly iteration cadence.

## UX improvements

- **"Done = did as prescribed" shortcut.** On done-tap with empty weight/reps inputs, auto-populate from the prescribed placeholder values. Edge case: partial fills should only auto-fill the empty field, not overwrite. **Priority: high** — eliminates the most common unnecessary data entry at the gym.
- **Surface old-plan sessions on import day.** When a user imports/generates a new plan mid-day, sets logged earlier that day against the previous plan become invisible in the tracker tabs until the calendar rolls over (preserved in DB, just not rendered on the active plan's tabs). Show a banner or separate card for those sets during the import-day transition. The new Plans modal already lets the user re-activate the old plan as a workaround; a cleaner UX would surface the orphaned sessions inline.
- **Coaching notes visible from Plans modal / History detail.** When the user taps a past plan in the Plans modal, show that plan's `coaching_notes` so they can review past AI decisions.
- **Rename ad-hoc sessions.** Title can be set once via the input at the top of the session, but no rename affordance after first save. *Idea only.*
- **Undoable toast for delete.** Set and exercise delete currently use a blocking `confirm()` dialog for persisted items. An undoable-toast pattern ("Set deleted — Undo") would be nicer mobile UX but adds complexity. *Idea only.*
- **Plan editing in-app.** Listed as a non-goal; the edit surface is accept/regenerate/import. Could add inline weight/rep overrides on individual exercises if the AI gets something wrong and the user wants to adjust without a full regenerate.
- **Custom domain SMTP sender.** Currently using shared `onboarding@resend.dev`. Upgrading to a custom domain is optional polish. *Idea only.*
- **Resolve plan exercise names at import time.** The current resolver + alias map is reactive — a new plan name that doesn't hit seed, alias, paren-strip, hyphen-swap, or depluralize silently creates an orphan user-custom row and siloes history. Cleaner: run every exercise through the resolver at plan-import/accept time; for any that don't match, surface a one-time linking modal; persist the canonical `exercise_id` directly in the plan JSON. Runtime `ensureExerciseId` then just reads the pre-resolved id. Plays nicely with AI-generated plans — Claude emits canonical names from the library dump and skips the linking step for most exercises. *Idea only — needs a spec.*
- **Calories per session.** Optional `calories` (int) per workout, entered manually. Schema: new `workouts.calories int null` column. Feeds the AI planner as a secondary recovery/volume signal. *Idea only.*
- **Adjustable rest timer in the UI.** Timer has ±15s buttons but no persistent override per exercise. Could add a tap-to-edit on the rest display. *Idea only.*

## Data model upgrades

- **Multi-user features.** Listed as a non-goal. Would require changes to RLS and a sharing/access layer. *Idea only — no design.*
- **Conflict resolution beyond last-write-wins.** Listed as a non-goal (app assumes single user, single device at a time). Multi-device sync would need a real merge strategy. *Idea only — no design.*

## Known limitations to fix

*(No open v1.1 or v2 limitations right now — all previously documented items have been addressed. Keep adding here as new ones surface.)*
