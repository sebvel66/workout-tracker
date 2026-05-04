-- Adds per-workout superset block structure.
--
-- Each entry: {exercise_orders: [int, ...], rest: int_seconds}
-- Empty array = no supersets in this workout (rendered as flat list,
-- preserving pre-v3.4 behavior).
--
-- Why workout-level (not plan-level) persistence: history detail must
-- survive plan deactivation, deletion, or post-workout structural
-- changes (Swap, Merge, Separate after a session ended). Plan.data is
-- the canonical structure for live render; workouts.superset_groups
-- is the historical record.

alter table workouts
  add column superset_groups jsonb not null default '[]';
