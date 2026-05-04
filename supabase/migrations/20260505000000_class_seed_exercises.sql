-- Seed library entries for popular workout classes (Barry's, Pilates,
-- SoulCycle, Yoga, etc.) so they can be logged as ad-hoc sessions
-- without going the custom-exercise route every time.
--
-- These are configured as cardio rows: muscle_group = 'cardio',
-- weight_mode = 'none', movement_pattern = 'cardio'. The v2.5.7 cardio
-- UI branch (isCardioExerciseName lookup) detects them by muscle_group
-- and renders the duration + (optional) distance set row instead of
-- weight + reps. equipment = 'other' since most classes do not fit a
-- specific equipment slot.
--
-- Naming convention follows existing seeds: lowercase, branded names
-- as written. User can always create a custom row via the picker's
-- "+ Create Custom Exercise" button for niche studios.
--
-- on conflict (name) where user_id is null do nothing handles idempotency
-- on re-run — same pattern as the v2.5.7 cardio seed migration.

insert into exercises (user_id, name, equipment, muscle_group, movement_pattern, weight_mode, is_custom) values
  (null, 'barry''s bootcamp',   'other', 'cardio', 'cardio', 'none', false),
  (null, 'pilates',             'other', 'cardio', 'cardio', 'none', false),
  (null, 'soulcycle',           'other', 'cardio', 'cardio', 'none', false),
  (null, 'yoga',                'other', 'cardio', 'cardio', 'none', false),
  (null, 'spin class',          'other', 'cardio', 'cardio', 'none', false),
  (null, 'crossfit',            'other', 'cardio', 'cardio', 'none', false),
  (null, 'orangetheory',        'other', 'cardio', 'cardio', 'none', false),
  (null, 'f45',                 'other', 'cardio', 'cardio', 'none', false),
  (null, 'hiit class',          'other', 'cardio', 'cardio', 'none', false),
  (null, 'group fitness class', 'other', 'cardio', 'cardio', 'none', false)
on conflict (name) where user_id is null do nothing;
