# Roadmap

Consolidated from HANDOFF.md and DECISIONS.md as of 2026-04-16. Nothing new here — just every forward-looking item collected and grouped. Each entry notes whether an explicit design exists (→ `DECISIONS.md`) or it's just a recorded idea.

## AI / Coaching (v2)

- **AI-generated workouts from historical performance.** The core v2 goal. Referenced throughout HANDOFF.md (v1 goal section, "v2 AI planner reads the active plan," "v2 progression models depend on `completed_at` semantics"). *Idea only* — no design doc. The v1 schema was built to support it: per-set RPE, prescribed-vs-actual columns, and timestamps are already in place specifically so this migration isn't needed later.
- **Progression / PR / volume-over-time analytics** as inputs to the AI planner. Listed as query shapes the v1 indexes target ("all sets for exercise X over time"). *Idea only* as a surfaced feature; the query substrate exists.
- **Configurable AI context window.** User-editable setting controlling how many weeks of workout history are sent to the AI planner when generating a new plan. Default 4 weeks. Tiered compression still applies (recent weeks verbatim, older weeks summarized). Stored as a user preference in Supabase. **Use case:** if the user takes time off, they can expand the window so the AI sees pre-break performance rather than interpreting the gap as detraining. *Idea only.*
- **Proactive program re-evaluation.** The AI coach should not just generate week-to-week progressions within a fixed program structure. It should periodically re-evaluate exercise selection, rep ranges, split design, volume distribution, and periodization phase. Roughly every 4–6 weeks, or when the data suggests a plateau or phase transition, the AI should proactively recommend structural changes and explain the reasoning in coaching notes. **This is a system-prompt directive, not a code feature.** *Idea only.*
- **Physique photo integration.** Two photo types feed into AI plan generation:
  - **Goal physique photo:** uploaded once, rarely changed. AI identifies visual priorities (which muscle groups are emphasized) and biases exercise selection and volume toward matching the goal.
  - **Progress photos:** uploaded every 2–4 weeks, same pose. AI compares current to goal, identifies lagging muscle groups, and adjusts programming accordingly.

  **Architecture:** Supabase Storage for the image files, a `physique_photos` table for metadata, photos sent as image content blocks in the Claude API call during plan generation.

  **Layered rollout:**
  - **Layer 1** — upload / storage / gallery UI. Ships independently before the AI planner exists.
  - **Layer 2** — include the photos in the plan-generation prompt. Extends the Edge Function.
  - **Layer 3** — visual progress tracking with AI commentary over time. v2.1+ enhancement.

  **Why it matters:** genuine differentiator — no commercial fitness app uses multimodal AI to visually assess physique and adjust programming. Fitbod, Hevy, and others are purely data-driven with no visual component. *Idea only.*

## UX improvements

- **Ad-hoc exercises (extras).** Log exercises performed but not in the imported plan. *Has design* — see `DECISIONS.md` → "Ad-hoc exercises (extras)". Client-side `extras` array pre-Supabase; server-side `sets` rows with `exercise_order > plan_length` and null prescribed fields.
- **"Done = did as prescribed" shortcut.** On done-tap with empty weight/reps inputs, auto-populate from the prescribed placeholder values. *Idea only*, proposal documented in HANDOFF.md → "Deferred features." Edge case flagged: partial fills should only auto-fill the empty field, not overwrite. **Priority: high** — eliminates the most common unnecessary data entry at the gym.
- **Session pause/resume.** Ability to pause the session timer (bathroom breaks, waiting for equipment, taking a call) and resume it, so total session duration reflects actual training time rather than wall-clock. Fitbod has a similar feature with a 3-hour auto-log timeout. Currently the timer runs continuously. *Idea only* — post-Session A enhancement.
- **Surface old-plan sessions on import day.** When a user imports a new plan mid-day, any sets logged earlier that day against the previous plan become invisible in the UI until the calendar rolls over (they're preserved in the DB, just not rendered on the active plan's tabs). Show a banner or a separate card for those sets so they stay visible during the import-day transition rather than hiding them until tomorrow. *Idea only* — post-v1 enhancement.
- **Ad-hoc sessions without an active plan.** Right now the tab strip (including the "+ New Session" button) only renders when an active plan exists, so a user without a plan can't start an ad-hoc. Rework the empty-state flow so ad-hoc is always accessible. *Idea only.*
- **Rename ad-hoc sessions.** Title can be set once via the input at the top of the session, but there's no way to rename after first save other than re-editing the input. Add an explicit rename affordance. *Idea only.* (Delete shipped in `v2.0.8`.)
- **Undoable toast for delete.** Set and exercise delete currently use a blocking `confirm()` dialog for persisted items. An undoable-toast pattern ("Set deleted — Undo") would be nicer mobile UX but adds complexity (queue, re-insert with original set_order, fan-out restore). *Idea only* — post-v1 polish.
- **Plan editing in-app.** Listed as a v1 non-goal. *Idea only* — no design.
- **Historical analytics UI.** Listed as a v1 non-goal. *Idea only* — no design.
- **Custom domain SMTP sender.** Currently using shared `onboarding@resend.dev`. Upgrading to a custom domain is optional polish for post-v1. *Idea only*, noted in HANDOFF.md → "Done."
- **Resolve plan exercise names at import time (replace the runtime `EXERCISE_ALIASES` map).** The current resolver + alias map is reactive — a new plan name that doesn't hit seed, alias, paren-strip, hyphen-swap, or depluralize silently creates an orphan user-custom row and siloes history. Cleaner: when a plan is imported, run every exercise through the resolver against the library; for any that don't match, surface a one-time linking modal ("pick from library, or mark as new custom exercise"); persist the canonical `exercise_id` directly in the plan JSON alongside the display label. Runtime `ensureExerciseId` then just reads the pre-resolved id. Benefits: no orphan creation at random tap-done moments, the alias map becomes a *suggestion engine* for the linking UI (best-guess pre-fill) and can eventually be deleted, explicit user control over ambiguous cases. Plays nicely with the v2 AI planner — Claude-generated plans can emit canonical names directly and skip the linking step entirely for most exercises. *Idea only* — needs a spec before touching code. Follow-up from the 2026-04-19 View Recent debugging (see `MAJOR-BUGS.md`).

## Data model upgrades

- **Multi-user features.** Listed as a v1 non-goal. Would require changes to RLS and a sharing/access layer. *Idea only* — no design.
- **Conflict resolution beyond last-write-wins.** Listed as a v1 non-goal (v1 assumes single user, single device at a time). Multi-device sync would need a real merge strategy. *Idea only* — no design.

## Known limitations to fix (v1.1)

*(No open v1.1 limitations right now — all previously documented items have been addressed. Keep adding here as new ones surface.)*
