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

## AI / Coaching (v2.1+)

Next-tier AI features not yet built. Order is rough priority.

- **Replan-remainder mode.** User generates Wed evening after completing Days 1-3; Edge Function detects completed days this week and generates only the remaining 2 days. Scope hinted at in the Part 2 spec but deferred for MVP. Would require: a new API mode field, detection of completed days in the request handler, and a prompt addition describing "replan" context.
- **Chat-based mid-week coaching.** Ask the coach questions outside the plan-generation flow ("should I deload?", "why is my bench stalled?", "can I swap squat for leg press today?"). Requires: a chat UI, message history persistence, streaming response handling (since latency matters more in chat than in weekly plan generation). Significant scope — likely v2.2 or later.
- **Automatic deload detection.** AI proactively suggests a deload without the user requesting a plan. Triggered by: RPE trending up for 3+ weeks, session completion rate dropping, pain notes in session data. Could surface as a banner in the tracker: *"Your RPE has climbed for 4 weeks — consider a deload this week. Generate a deload plan?"*
- **Regenerate with feedback.** On the review screen, a "Regenerate with adjustments" input ("less quad volume this week, my knee is bothering me") that appends to the prompt and re-calls the API. Simpler than full chat but still mid-week-adjustable. The first-generation flow already has a `notes` field; regenerate-with-feedback is the same mechanism on the review screen.
- **Side-by-side progress photo comparison with AI commentary.** Layer 3 of the photo feature. Chronological grid view with AI-generated observations on visible changes ("delts have filled in since March, quads slightly leaner"). Requires: a batch-photo-analysis Edge Function, UI for the grid + callouts.
- **PR detection.** Automatic flagging when a logged set is a personal record (most weight at rep count, most reps at weight). Indexed queries on the `sets` table already support this. Could show as a badge on the set row, a toast on save, or a dedicated PR list in the History browser.
- **Progression charts.** Weight/volume/RPE trends over time per exercise. `openExerciseHistory` already queries the data; needs a chart rendering layer (chart library choice: probably Chart.js for zero-dependency inline usage, or recharts if we ever add a build step).
- **Exercise substitution intelligence.** AI notices consistent swaps (e.g., "you swapped BSS for leg press 3 weeks running") and asks if it should just program leg press instead. Mid-week coaching feature — depends on chat scope.
- **Multi-week periodization.** Generate a 4-week mesocycle in one call rather than week-by-week. Harder prompt-engineering — Claude would need to plan progressions across all 4 weeks coherently. Feasible but adds significant output length; probably needs Vercel Pro for the longer call.

## Infrastructure / scaling

- **Cron warm-up ping for `/api/generate-plan`.** Vercel cron hitting the function every 5 min (with an early-return `warmup=true` branch) keeps a Fluid Compute instance hot. Limited upside: doesn't warm the Anthropic prompt cache (the dominant 15s latency delta), and Fluid Compute's instance-reuse already covers most of the function-warmth gap. Revisit only if the v2.0.26 silent-retry UX still feels bad in practice. Uses Hobby-plan cron quota. Defer → probably not worth building unless data says otherwise.
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
