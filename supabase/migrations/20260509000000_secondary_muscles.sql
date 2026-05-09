-- Phase 1b of volume-by-muscle analytics. Adds an optional secondary_muscles
-- text[] column to the exercises table so a single set can contribute to
-- multiple muscle groups (e.g., bench press: chest primary; triceps + shoulders
-- secondary). Phase 1a (v3.5.0) counted only the primary muscle_group; with
-- this column populated, the app counts secondaries at 0.5 (standard
-- Schoenfeld-style fractional counting).
--
-- Seed rows (user_id IS NULL) get backfilled below via heuristic UPDATEs
-- grouped by (muscle_group, movement_pattern). Custom user rows (user_id NOT
-- NULL) stay at the default '{}' until the user explicitly tags them — there
-- is no UI for that yet, so existing custom exercises just contribute their
-- primary muscle until that lands.
--
-- Re-runs: each backfill UPDATE narrows on `secondary_muscles = '{}'` so a row
-- already tagged (manually or in a prior run) is left alone. The name-pattern
-- override block at the end DOES rewrite (it intentionally replaces an empty
-- default with a sharper assignment for special cases).

alter table exercises
  add column secondary_muscles text[] not null default '{}';

-- CHECK: every element must be a valid muscle_group enum value. The <@
-- operator tests "left array's elements are all in the right array".
alter table exercises
  add constraint exercises_secondary_muscles_valid
  check (
    secondary_muscles <@ array[
      'chest', 'back', 'shoulders', 'biceps', 'triceps',
      'quads', 'hamstrings', 'glutes', 'calves', 'core',
      'traps', 'forearms', 'lower back', 'full body',
      'cardio', 'mobility'
    ]::text[]
  );

-- ---------------------------------------------------------------------------
-- Per-category backfill: heuristic UPDATEs grouped by (muscle_group,
-- movement_pattern). Each narrows on secondary_muscles = '{}' so re-runs
-- are idempotent and any prior manual override is preserved.
-- ---------------------------------------------------------------------------

-- Compound chest press (horizontal): triceps + shoulders (front delts).
-- Bench variants, machine press, push-ups, neutral-grip db press, floor press.
update exercises
   set secondary_muscles = '{triceps,shoulders}'
 where user_id is null
   and muscle_group = 'chest'
   and movement_pattern = 'horizontal press'
   and secondary_muscles = '{}';

-- Chest dips (vertical press tagged chest): triceps + shoulders.
update exercises
   set secondary_muscles = '{triceps,shoulders}'
 where user_id is null
   and muscle_group = 'chest'
   and movement_pattern = 'vertical press'
   and secondary_muscles = '{}';

-- Compound back vertical pull (pull-up, pulldown variants): biceps.
update exercises
   set secondary_muscles = '{biceps}'
 where user_id is null
   and muscle_group = 'back'
   and movement_pattern = 'vertical pull'
   and secondary_muscles = '{}';

-- Compound back horizontal pull (rows): biceps + shoulders (rear delts).
update exercises
   set secondary_muscles = '{biceps,shoulders}'
 where user_id is null
   and muscle_group = 'back'
   and movement_pattern = 'horizontal pull'
   and secondary_muscles = '{}';

-- Deadlift variants tagged as back (hip hinge): glutes, hamstrings, lower back.
-- Trap bar / sumo also recruit quads heavily but heuristic stays at three
-- secondaries; per-exercise overrides can land later.
update exercises
   set secondary_muscles = '{glutes,hamstrings,lower back}'
 where user_id is null
   and muscle_group = 'back'
   and movement_pattern = 'hip hinge'
   and secondary_muscles = '{}';

-- Compound shoulder press (OHP variants): triceps.
update exercises
   set secondary_muscles = '{triceps}'
 where user_id is null
   and muscle_group = 'shoulders'
   and movement_pattern = 'vertical press'
   and secondary_muscles = '{}';

-- Squat variants (back squat, front squat, hack squat, leg press): glutes,
-- hamstrings.
update exercises
   set secondary_muscles = '{glutes,hamstrings}'
 where user_id is null
   and muscle_group = 'quads'
   and movement_pattern = 'squat'
   and secondary_muscles = '{}';

-- Lunge / split squat / step-up variants (still tagged quads, varied movement
-- patterns): glutes, hamstrings.
update exercises
   set secondary_muscles = '{glutes,hamstrings}'
 where user_id is null
   and muscle_group = 'quads'
   and (name like '%lunge%' or name like '%split squat%' or name like '%step-up%')
   and secondary_muscles = '{}';

-- Hip hinge / extension tagged as hamstrings (RDLs, good morning variants):
-- glutes + lower back.
update exercises
   set secondary_muscles = '{glutes,lower back}'
 where user_id is null
   and muscle_group = 'hamstrings'
   and movement_pattern in ('hip hinge', 'hip extension')
   and secondary_muscles = '{}';

-- Hip thrust / glute bridge tagged as glutes (hip extension): hamstrings.
update exercises
   set secondary_muscles = '{hamstrings}'
 where user_id is null
   and muscle_group = 'glutes'
   and movement_pattern in ('hip extension', 'hip hinge')
   and secondary_muscles = '{}';

-- Compound triceps movements (close grip bench, dips): chest + shoulders.
update exercises
   set secondary_muscles = '{chest,shoulders}'
 where user_id is null
   and muscle_group = 'triceps'
   and movement_pattern in ('horizontal press', 'vertical press')
   and secondary_muscles = '{}';

-- Diamond push-up etc. (triceps primary, but compound by name): chest + shoulders.
update exercises
   set secondary_muscles = '{chest,shoulders}'
 where user_id is null
   and muscle_group = 'triceps'
   and name like '%push-up%'
   and secondary_muscles = '{}';

-- Bicep curls (isolation): forearms (grip is always assistive on a curl).
update exercises
   set secondary_muscles = '{forearms}'
 where user_id is null
   and muscle_group = 'biceps'
   and movement_pattern = 'isolation'
   and secondary_muscles = '{}';

-- Lower back movements (good morning, hyperextension): glutes, hamstrings.
update exercises
   set secondary_muscles = '{glutes,hamstrings}'
 where user_id is null
   and muscle_group = 'lower back'
   and secondary_muscles = '{}';

-- ---------------------------------------------------------------------------
-- Name-pattern overrides: special cases that the per-category defaults miss
-- because their muscle_group + movement_pattern would otherwise leave them
-- at '{}'. These OMIT the secondary_muscles = '{}' gate when the category
-- default was empty (so the override is not a no-op) — but they're keyed
-- on a unique enough name that re-runs still produce the same end state.
-- ---------------------------------------------------------------------------

-- Face pull / band pull-apart: traps + rhomboids assist (we don't have
-- "rhomboids" as a muscle_group, so traps captures the trap+rhomboid
-- contribution).
update exercises
   set secondary_muscles = '{traps}'
 where user_id is null
   and muscle_group = 'shoulders'
   and (name like '%face pull%' or name = 'band pull-apart');

-- Upright row: traps primary co-mover + biceps grip/pull.
update exercises
   set secondary_muscles = '{traps,biceps}'
 where user_id is null
   and name = 'upright row';
