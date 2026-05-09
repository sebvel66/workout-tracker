-- Per-(user × exercise) form notes (v3.5.8). Stores BOTH the user's own
-- free-text notes ("My Notes") and an AI-generated form-coaching summary
-- ("AI Coach Notes") so the user has a quick reference per exercise
-- without having to re-ask the coach every time.
--
-- One row per user × exercise. Composite PK enforces the uniqueness
-- without a separate unique index. ai_generated_at lets the UI show
-- "Last generated: <date>" and decide whether to suggest a refresh.
--
-- Owner-only RLS. Service-role bypasses RLS but Edge Functions filter
-- by user_id explicitly when reading (defense in depth).

create table exercise_form_notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  user_note text,
  ai_note text,
  ai_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

-- Most queries filter by user_id; PK already covers (user_id, exercise_id)
-- lookups (the modal-open path), so no additional index needed.

alter table exercise_form_notes enable row level security;

create policy "own_form_notes_select"
  on exercise_form_notes for select
  using (user_id = auth.uid());

create policy "own_form_notes_insert"
  on exercise_form_notes for insert
  with check (user_id = auth.uid());

create policy "own_form_notes_update"
  on exercise_form_notes for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "own_form_notes_delete"
  on exercise_form_notes for delete
  using (user_id = auth.uid());
