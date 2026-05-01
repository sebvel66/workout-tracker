-- Cardio logging (v2.5 Phase 1, lean schema).
--
-- Extends the sets table with two nullable columns so cardio sets can be
-- logged alongside resistance training. The existing weight / reps /
-- prescribed_weight / prescribed_reps columns stay nullable on cardio
-- rows — the UI conditionally renders duration / distance fields when
-- the exercise's muscle_group = 'cardio' (single source of truth, looked
-- up via the library at render / persist time).
--
-- Lean v1 covers ~80% of cardio logging (treadmill, run, bike, rower).
-- Phase 1.5 will add incline / speed / resistance_level / distance_unit
-- when we want them surfaced in the UI; nullable columns are forward-
-- compatible so the schema cost is zero either way.
--
-- Distance unit is currently implicit 'mi' (miles). When kg/km support
-- ships in the kg/lbs toggle's cardio extension, distance_unit will get
-- its own column.

alter table sets
  add column duration_seconds integer,
  add column distance numeric;

-- Five new cardio exercises distinct from existing strength rows:
--   - sprint intervals: HIIT outdoor sprints (vs steady-state outdoor run)
--   - sled push conditioning: cardio variant (existing 'sled push' is the
--     strength compound — high load, low rep)
--   - farmer's walk conditioning: cardio variant (existing 'farmer's carry'
--     is the strength compound — heavy + traps targeted)
--   - ski erg: distinct machine, no existing entry
--   - versa climber: distinct machine, no existing entry
--
-- Existing seed library already covers: treadmill run/walk, incline
-- treadmill walk, stairmaster, elliptical, stationary bike, rowing
-- machine, assault bike, jump rope, outdoor run/walk, cycling, battle
-- rope (13 cardio rows total). Skipping the user-proposed "intervals"
-- variants of those (battle rope intervals, bike intervals, rowing
-- intervals, stair climbing) since interval framing is captured per-set
-- by individual duration entries — separate exercise rows would just
-- clutter the picker.

insert into exercises (user_id, name, equipment, muscle_group, movement_pattern, weight_mode, is_custom) values
  (null, 'sprint intervals',               'bodyweight',    'cardio',    'cardio',           'none',       false),
  (null, 'sled push conditioning',         'other',         'cardio',    'cardio',           'none',       false),
  (null, 'farmer''s walk conditioning',    'dumbbell',      'cardio',    'carry',            'per_side',   false),
  (null, 'ski erg',                        'machine',       'cardio',    'cardio',           'none',       false),
  (null, 'versa climber',                  'machine',       'cardio',    'cardio',           'none',       false)
on conflict (name) where user_id is null do nothing;

-- Battle rope's original seed had muscle_group = 'full body' (with
-- movement_pattern = 'cardio'). In practice it's logged as interval
-- cardio — nobody types weight or reps for it — so we surface it
-- under the same UI branch as treadmill / bike / rower by promoting
-- it to muscle_group = 'cardio'. The cardio UI branch (Commit 2)
-- detects cardio via muscle_group === 'cardio' (single source of
-- truth from the library), so this UPDATE is the data signal that
-- gates UI rendering for any historical battle rope sets.
update exercises
  set muscle_group = 'cardio'
  where name = 'battle rope' and user_id is null;
