-- Adaptive coaching profile (v2.5 Layer 1).
--
-- Replaces hardcoded values in system-prompt-core.md (CLIENT PROFILE,
-- Injury-aware programming, Phase awareness) and the inline CLIENT
-- PROFILE in api/coach-chat.js with a per-user editable row the Edge
-- Functions read on every plan-gen / analyze / swap / coach-chat call.
-- Edits happen via a "Coaching Profile" modal in the hamburger menu
-- (built in a separate commit).
--
-- One row per user, keyed by user_id. jsonb data column holds the full
-- profile so we can add/remove/rename fields without migrations while
-- iterating on shape. Current field set (v2.5 minimal):
--
-- data.sex                     string ('male' | 'female' | 'other')
-- data.height_ft               integer
-- data.height_in               integer
-- data.weight_lbs              number
-- data.experience_level        string ('beginner' | 'intermediate' | 'advanced')
-- data.environment             free text — gym equipment / access
-- data.split_preference        free text — preferred split + training cadence
-- data.goal_type               string ('bulk' | 'cut' | 'maintain' | 'recomp')
-- data.goal_detail             free text — target physique / muscle / BF goals
-- data.phase                   string ('accumulation' | 'pre-cut' | 'cut' | 'reverse' | 'maintain')
-- data.phase_start_date        date or null (planned or actual start of current phase)
-- data.phase_notes             free text — phase-specific directives (macros, tapering, etc.)
-- data.injuries                array of { name: string, notes: string }
-- data.special_instructions    free text — anything else the coach should know
--
-- The Edge Functions build a CLIENT PROFILE block from this data and
-- inject it into dynText (uncached user-message section) on every call,
-- leaving the cached system prompt unchanged. Missing profile -> fall
-- back to a one-line "client hasn't filled in profile yet" note.
--
-- Seed the current user's row with values matching today's hardcoded
-- prompt so day-1 behavior is identical. Single-user instance; look up
-- the row dynamically from auth.users rather than hardcoding a uuid
-- that might differ between prod/preview/dev. Email filter omitted
-- because there's only one auth.users row and the email has changed
-- hands in the past (early-development stale account was cleaned up).

create table coaching_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table coaching_profile enable row level security;

create policy "own_coaching_profile_select"
  on coaching_profile for select
  using (auth.uid() = user_id);

create policy "own_coaching_profile_insert"
  on coaching_profile for insert
  with check (auth.uid() = user_id);

create policy "own_coaching_profile_update"
  on coaching_profile for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Seed the existing user's row with values mirroring today's hardcoded
-- prompt. on conflict do nothing so re-runs are idempotent.
insert into coaching_profile (user_id, data)
select
  u.id,
  jsonb_build_object(
    'sex', 'male',
    'height_ft', 5,
    'height_in', 11,
    'weight_lbs', 170,
    'experience_level', 'intermediate',
    'environment', 'commercial gym with full equipment access (barbells, dumbbells, cables, machines, smith machine, pull-up bar)',
    'split_preference', '5-day Upper/Lower split, Sunday-anchored. Non-training days are active recovery (walking, light mobility). The actual day count may differ for a given week.',
    'goal_type', 'bulk',
    'goal_detail', 'lean, muscular physique — roughly 8-12 lbs of additional muscle over 12-18 months, eventual body fat reduction to approximately 10-12%',
    'phase', 'accumulation',
    'phase_start_date', null,
    'phase_notes', 'Cut phase planned for approximately July. Two to three weeks before the cut begins, transition from volume accumulation to strength maintenance: reduce total volume by 20-30%, maintain or slightly increase intensity (weight), reduce accessories, focus on retaining strength on primary compound lifts. During the cut itself (approximately 8-10 weeks, targeting ~1 lb/week fat loss at ~2,000-2,200 kcal, ~165-175g protein daily): program for strength retention, not growth. After the cut: reverse diet phase, gradual volume reintroduction over 2-3 weeks.',
    'injuries', jsonb_build_array(
      jsonb_build_object(
        'name', 'Patellofemoral knee pain',
        'notes', 'Avoid deep knee flexion under heavy load. Prefer knee-friendly squat variants, control eccentric tempo, ensure adequate quad/VMO activation in warm-ups. If knee pain is reported in session notes, reduce quad-dominant volume for the following week and add targeted prehab.'
      ),
      jsonb_build_object(
        'name', 'Lower back sensitivity on Bulgarian Split Squats',
        'notes', 'Use cues for upright torso and controlled descent. If pain persists, substitute with another unilateral quad movement (step-ups, lunges, leg press single-leg). Do not remove unilateral training — address the form issue.'
      ),
      jsonb_build_object(
        'name', 'Grip as limiter on RDLs and heavy pulls',
        'notes', 'Lifting straps are approved. Program grip-intensive exercises (deadlifts, RDLs, heavy rows) earlier in the session when grip is fresh. Grip training (dead hangs) is programmed separately, not as a limiter on primary movements.'
      )
    ),
    'special_instructions', null
  )
from auth.users u
on conflict (user_id) do nothing;
