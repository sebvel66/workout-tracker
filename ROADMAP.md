# Roadmap

Consolidated from HANDOFF.md and DECISIONS.md as of 2026-04-16. Nothing new here — just every forward-looking item collected and grouped. Each entry notes whether an explicit design exists (→ `DECISIONS.md`) or it's just a recorded idea.

## AI / Coaching (v2)

- **AI-generated workouts from historical performance.** The core v2 goal. Referenced throughout HANDOFF.md (v1 goal section, "v2 AI planner reads the active plan," "v2 progression models depend on `completed_at` semantics"). *Idea only* — no design doc. The v1 schema was built to support it: per-set RPE, prescribed-vs-actual columns, and timestamps are already in place specifically so this migration isn't needed later.
- **Progression / PR / volume-over-time analytics** as inputs to the AI planner. Listed as query shapes the v1 indexes target ("all sets for exercise X over time"). *Idea only* as a surfaced feature; the query substrate exists.

## UX improvements

- **Ad-hoc exercises (extras).** Log exercises performed but not in the imported plan. *Has design* — see `DECISIONS.md` → "Ad-hoc exercises (extras)". Client-side `extras` array pre-Supabase; server-side `sets` rows with `exercise_order > plan_length` and null prescribed fields.
- **"Done = did as prescribed" shortcut.** On done-tap with empty weight/reps inputs, auto-populate from the prescribed placeholder values. *Idea only*, proposal documented in HANDOFF.md → "Deferred features." Edge case flagged: partial fills should only auto-fill the empty field, not overwrite. **Priority: high** — eliminates the most common unnecessary data entry at the gym.
- **Adjustable rest timer in the UI.** Timer currently uses `exercise.rest` or a 90s fallback with no in-app control. Add +/- controls or tap-to-edit. *Idea only.*
- **Session pause/resume.** Ability to pause the session timer (bathroom breaks, waiting for equipment, taking a call) and resume it, so total session duration reflects actual training time rather than wall-clock. Fitbod has a similar feature with a 3-hour auto-log timeout. Currently the timer runs continuously. *Idea only* — post-Session A enhancement.
- **Surface old-plan sessions on import day.** When a user imports a new plan mid-day, any sets logged earlier that day against the previous plan become invisible in the UI until the calendar rolls over (they're preserved in the DB, just not rendered on the active plan's tabs). Show a banner or a separate card for those sets so they stay visible during the import-day transition rather than hiding them until tomorrow. *Idea only* — post-v1 enhancement.
- **Ad-hoc sessions without an active plan.** Right now the tab strip (including the "+ New Session" button) only renders when an active plan exists, so a user without a plan can't start an ad-hoc. Rework the empty-state flow so ad-hoc is always accessible. *Idea only.*
- **Rename and delete ad-hoc sessions.** Title can be set once via the input at the top of the session, but there's no way to rename after first save other than re-editing, and no way to delete an accidentally-created ad-hoc session. Add explicit rename/delete affordances. *Idea only.*
- **Undoable toast for delete.** Set and exercise delete currently use a blocking `confirm()` dialog for persisted items. An undoable-toast pattern ("Set deleted — Undo") would be nicer mobile UX but adds complexity (queue, re-insert with original set_order, fan-out restore). *Idea only* — post-v1 polish.
- **Plan editing in-app.** Listed as a v1 non-goal. *Idea only* — no design.
- **Historical analytics UI.** Listed as a v1 non-goal. *Idea only* — no design.
- **Custom domain SMTP sender.** Currently using shared `onboarding@resend.dev`. Upgrading to a custom domain is optional polish for post-v1. *Idea only*, noted in HANDOFF.md → "Done."

## Data model upgrades

- **Multi-user features.** Listed as a v1 non-goal. Would require changes to RLS and a sharing/access layer. *Idea only* — no design.
- **Conflict resolution beyond last-write-wins.** Listed as a v1 non-goal (v1 assumes single user, single device at a time). Multi-device sync would need a real merge strategy. *Idea only* — no design.

## Known limitations to fix (v1.1)

*(No open v1.1 limitations right now — all previously documented items have been addressed. Keep adding here as new ones surface.)*
