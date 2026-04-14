-- Initial schema for workout tracker v1 (Supabase migration).
-- See DECISIONS.md and HANDOFF.md for rationale.

create table plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  week text,
  data jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create index on plans (user_id, created_at desc);
create unique index plans_one_active_per_user on plans (user_id) where is_active;

create table exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references plans(id) on delete set null,
  day_index int,
  performed_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  notes text
);
create index on workouts (user_id, performed_at desc);

create table sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workout_id uuid not null references workouts(id) on delete cascade,
  exercise_id uuid not null references exercises(id),
  exercise_order int not null,
  set_order int not null,
  weight numeric,
  reps int,
  rpe int,
  prescribed_weight numeric,
  prescribed_reps int,
  substitution text,
  note text,
  done boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  constraint sets_completed_at_required_when_done
    check (done = false or completed_at is not null)
);
create index on sets (user_id, exercise_id, completed_at desc);
create index on sets (workout_id, exercise_order, set_order);
create index on sets (workout_id, completed_at);

alter table plans     enable row level security;
alter table exercises enable row level security;
alter table workouts  enable row level security;
alter table sets      enable row level security;

create policy "own_plans"     on plans     for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_exercises" on exercises for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_workouts"  on workouts  for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_sets"      on sets      for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
