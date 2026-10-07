-- Standing coaching rules (v3.8.0).
--
-- Adds `data.coaching_rules` (free text, multi-line) to coaching_profile.
-- These are persistent, user-authored directives the coach must honour on
-- EVERY call — plan generation, analyze, swap, refine, and coach chat all
-- splice this verbatim into the CLIENT PROFILE block. Distinct from
-- `special_instructions` (a shorter catch-all): coaching_rules is the
-- explicit standing agreement — progression gates, priority muscles,
-- known skip patterns, tone — that governs how the coach reasons.
--
-- Editable in the Coaching Profile modal as a "Standing coaching rules"
-- textarea. NOT in the AI-editable profile_updates allowlist (the client
-- owns these rules; the coach may propose changes via the update_plan /
-- update_coaching_profile confirm flow but never edits them unprompted).
--
-- jsonb merge via `||` so existing profile fields are untouched. Guarded
-- by `not (data ? 'coaching_rules')` so re-runs never clobber a value the
-- user has since edited. Single-user instance; apply to every row still
-- missing the key (mirrors the original coaching_profile seed migration
-- which seeded all auth.users without an email filter).

update coaching_profile
set data = data || jsonb_build_object(
  'coaching_rules',
  $rules$- Dumbbells are logged in lbs per hand. Smith machine entries are plate weight only; true load is about 15 lbs more. Prescribe in the same conventions I log.
- Load increases only after a flat completion of all prescribed sets at the top of the range at the current weight. Weighted pull-ups need two consecutive clean sessions.
- Ramping within a session is flagged; the next prescription is a flat scheme at one weight.
- Stagnation of 3+ weeks at the same load with completed sets: push reps to the top of the range or change the stimulus, and say which.
- After a layoff of 2+ weeks: re-enter at 80 to 85 percent of last loads with reduced volume for the first week.
- Side delts (target 14 to 16 sets per week) and upper chest are priority groups; side delts go on every training day, never only in finisher slots.
- Dead hangs twice a week. Farmer's carry is permanently out.
- Leg days start with knee prehab: stationary bike 2 to 3 min, foam roll quads and IT band, TKE 2x20 per leg, banded clamshells 2x20. Squat cues: pause, knees out, flat soles. Leg extensions at shortened ROM.
- Known skip pattern: end-of-session calf raises, dead hangs, rear delt work, Copenhagen plank. Flag it honestly when it appears.
- Prefer a plan I will finish over a longer one I execute at 70 percent. I set volume targets; do not editorialise on whether they are enough.
- Be direct. I know RP volume landmarks (MV, MEV, MAV, MRV) and fractional set counting; argue with evidence and expect pushback.$rules$
)
where not (data ? 'coaching_rules');
