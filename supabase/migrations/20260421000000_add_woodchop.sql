-- Add 'woodchop' to the seed exercise library.
--
-- Context: the `cable woodchop → woodchop` alias in js/resolver.js pointed at
-- a non-existent row, so every "Cable Woodchop" plan emission from the AI
-- fell through ensureExerciseId's orphan-create path (or, in the case of
-- historical Fitbod CSV imports, was silently skipped because the import
-- script only inserted sets whose exercise name resolved to a library row).
-- View Recent for Cable Woodchop returned empty; the AI planner never saw
-- woodchop in AVAILABLE EXERCISES either, so weight prescriptions collapsed
-- to 0 and the exercise was effectively ungrounded.
--
-- This migration adds the canonical row so the resolver's alias resolves
-- correctly and the AI can emit it from AVAILABLE EXERCISES going forward.
-- Historical cable woodchop sets from the Fitbod CSV (Feb-Apr 2026) are
-- restored via a separate one-off SQL script run in the Supabase dashboard,
-- not via this migration (user-specific data, not schema).
--
-- Weight mode = 'total' because cable stack weight is a single number, even
-- though the exercise is performed one side at a time.
--
-- Idempotent: ON CONFLICT on the partial unique index does nothing on re-run.

insert into exercises (user_id, name, equipment, muscle_group, movement_pattern, weight_mode, is_custom) values
  (null, 'woodchop',                         'cable',         'core',      'isolation',        'total',      false)
on conflict (name) where user_id is null do nothing;
