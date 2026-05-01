-- Drop sets, supersets, giant sets — schema (Phase 1 of the advanced
-- set-types feature). Drop sets ship in the next two commits (UI +
-- AI prompt extension). Supersets and giant sets are deferred to a
-- later phase but the schema accepts them now so we don't have to
-- alter the CHECK constraint when those land.
--
-- set_type:
--   'standard' — normal independent set (current behavior, default)
--   'drop'     — drop-set segment; parent_set_id points at the first
--                set of the chain, subsequent drops at the same parent
--   'superset' — paired set across a different exercise; parent_set_id
--                points at the partner exercise's set (FUTURE)
--   'giant'    — same as superset but for 3+ exercise pairings (FUTURE)
--
-- parent_set_id:
--   For 'standard' rows: NULL (the default).
--   For the FIRST segment of a chain: also NULL (it IS the parent).
--   For subsequent segments: points at the first set of the chain.
--   ON DELETE CASCADE so wiping the parent wipes the chain — drop sets
--   are atomic units, no orphans.
--
-- All existing data: set_type defaults to 'standard', parent_set_id
-- stays NULL. Non-breaking add.

alter table sets
  add column set_type text not null default 'standard',
  add column parent_set_id uuid references sets(id) on delete cascade;

alter table sets
  add constraint sets_set_type_check
  check (set_type in ('standard', 'drop', 'superset', 'giant'));

-- Partial index on parent_set_id so "fetch all segments for this parent"
-- queries (used when a parent set is edited / deleted) hit an index
-- rather than scanning. Most rows have parent_set_id null, so the
-- partial index keeps it tiny.
create index sets_parent_set_id_idx
  on sets (parent_set_id)
  where parent_set_id is not null;
