-- Gym profiles: user-defined locations tagged onto workouts so the v2
-- AI planner (and the user reading their own history) can reason about
-- weight in equipment-specific context. Resistance-machine weights don't
-- translate across gyms; knowing "120 lbs on the cable row at Gym A" is
-- materially different from "120 lbs at Gym B" makes progression tracking
-- meaningful rather than noisy.

-- 1. locations table.
--    user_id mandatory (every row is owned). Names are kept as-typed for
--    display but uniqueness is enforced case-insensitively so "Gym A" and
--    "gym a" can't both exist for the same user.
create table locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create unique index locations_user_name_ci_unique
  on locations (user_id, lower(name));
create index on locations (user_id, created_at desc);

-- 2. RLS: locations are private per user, same policy shape as every
--    other user-owned table in this schema.
alter table locations enable row level security;

create policy "own_locations" on locations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. workouts.location_id FK.
--    Nullable so historical workouts (and users who opt out of tagging)
--    remain valid. ON DELETE SET NULL means deleting a gym strips the
--    location tag from its past workouts but keeps the set data intact —
--    the user loses context, not history.
alter table workouts
  add column location_id uuid references locations(id) on delete set null;

create index on workouts (user_id, location_id);
