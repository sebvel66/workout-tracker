# Roadmap

Consolidated from HANDOFF.md and DECISIONS.md as of 2026-04-16. Nothing new here — just every forward-looking item collected and grouped. Each entry notes whether an explicit design exists (→ `DECISIONS.md`) or it's just a recorded idea.

## AI / Coaching (v2)

- **AI-generated workouts from historical performance.** The core v2 goal. Referenced throughout HANDOFF.md (v1 goal section, "v2 AI planner reads the active plan," "v2 progression models depend on `completed_at` semantics"). *Idea only* — no design doc. The v1 schema was built to support it: per-set RPE, prescribed-vs-actual columns, and timestamps are already in place specifically so this migration isn't needed later.
- **Progression / PR / volume-over-time analytics** as inputs to the AI planner. Listed as query shapes the v1 indexes target ("all sets for exercise X over time"). *Idea only* as a surfaced feature; the query substrate exists.

## UX improvements

- **Ad-hoc exercises (extras).** Log exercises performed but not in the imported plan. *Has design* — see `DECISIONS.md` → "Ad-hoc exercises (extras)". Client-side `extras` array pre-Supabase; server-side `sets` rows with `exercise_order > plan_length` and null prescribed fields.
- **"Done = did as prescribed" shortcut.** On done-tap with empty weight/reps inputs, auto-populate from the prescribed placeholder values. *Idea only*, proposal documented in HANDOFF.md → "Deferred features." Edge case flagged: partial fills should only auto-fill the empty field, not overwrite. **Priority: high** — eliminates the most common unnecessary data entry at the gym.
- **Browse historical weeks.** Week-picker or date-based navigation so past weeks are reviewable (current UI only surfaces most recent workout per `day_index`). *Idea only* — schema supports it (`workouts.performed_at` is indexed), purely a UI addition. **Priority: high** — prerequisite for meaningful AI coaching context. The AI planner needs a clean view of recent weeks to generate intelligent progressions.
- **Adjustable rest timer in the UI.** Timer currently uses `exercise.rest` or a 90s fallback with no in-app control. Add +/- controls or tap-to-edit. *Idea only.*
- **Longer toast persistence.** Bump auto-dismiss from 9s to ~20s, or make error toasts sticky-until-dismissed. *Idea only.* **Quick fix** — one constant change. Error toasts specifically should persist until manually dismissed rather than auto-dismissing.
- **Plan editing in-app.** Listed as a v1 non-goal. *Idea only* — no design.
- **Historical analytics UI.** Listed as a v1 non-goal. *Idea only* — no design.
- **Custom domain SMTP sender.** Currently using shared `onboarding@resend.dev`. Upgrading to a custom domain is optional polish for post-v1. *Idea only*, noted in HANDOFF.md → "Done."

## Data model upgrades

- **Multi-user features.** Listed as a v1 non-goal. Would require changes to RLS and a sharing/access layer. *Idea only* — no design.
- **Conflict resolution beyond last-write-wins.** Listed as a v1 non-goal (v1 assumes single user, single device at a time). Multi-device sync would need a real merge strategy. *Idea only* — no design.

## Known limitations to fix (v1.1)

All four are documented in HANDOFF.md → "Known v1 limitations" with the specific fix named.

- **Multi-tab duplicate workouts.** Two tabs can each create a `workouts` row for the same day before either persists. *Fix specified:* generated `performed_on date` column on `workouts` plus a partial unique index on `(user_id, day_index, performed_on)`.
- **First-insert retry dup.** Network flake on the first `workouts` insert can't distinguish "never persisted" from "response lost," so retry can dup. *Fix specified:* same unique index as multi-tab — one fix resolves both.
- **Midnight boundary drift.** "Today" is computed on every write/hydrate via `new Date()`, so a session straddling midnight can log late sets under a new day. *Fix specified:* snapshot `todayStart` on hydration and hold it steady in memory for the session.
- **One editable tab per calendar day.** `todayState` is pinned to the first `day_index` the user taps "done" on, blocking logging of two different `day_index` workouts on the same calendar date. *Fix specified:* loosen to one editable tab per `(date, day_index)` pair — ~10-line change to `hydrate()` and `viewModeFor()`.
