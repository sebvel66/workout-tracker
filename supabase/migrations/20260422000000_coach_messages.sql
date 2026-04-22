-- Persistent coach chat history.
--
-- Replaces the in-memory chatHistory array (cleared on sign-out / session
-- start / plan save) with a durable per-user log of every coaching
-- interaction across three contexts: ad-hoc chat, exercise swap, and plan
-- generation. Used by all three Edge Functions to inject a "RECENT
-- COACHING CONVERSATIONS" block into the user message — gives Claude
-- continuity across sessions ("As we discussed Tuesday...") and lets it
-- honor prior advice (don't re-prescribe a weight you told the client
-- to drop last week).
--
-- Window for both query + display is 2 full weeks back from last Sunday
-- + current week to date. Display is silently capped at the most-recent
-- 50 messages; pagination ("Load earlier") deferred to a follow-up.
--
-- context_type values:
--   'chat'             — coach panel ad-hoc question
--   'swap'             — exercise swap request / suggestion / accept-reject
--   'plan_generation'  — plan-gen request / accept-reject (no rich AI
--                        commentary; the analyze flow carries that)
--   NULL               — legacy / pre-migration rows; treated as 'chat'
--
-- exercise_name: populated for context_type='swap' so the chat history
-- block can render "[exercise swap: Cable Row]" inline. NULL otherwise.

create table coach_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  context_type text check (context_type in ('chat', 'swap', 'plan_generation')),
  exercise_name text,
  created_at timestamptz not null default now()
);

-- Time-range query index: every read filters by user_id + a created_at
-- window. DESC matches the natural newest-first scan; the window query
-- still benefits because Postgres can scan either direction.
create index coach_messages_user_time_idx
  on coach_messages (user_id, created_at desc);

-- RLS: every read/write must come from the row owner. Service-role
-- (used by the Edge Functions) bypasses RLS but still filters by
-- user_id explicitly in queries — defense in depth.
alter table coach_messages enable row level security;

create policy "own_coach_messages_select"
  on coach_messages for select
  using (auth.uid() = user_id);

create policy "own_coach_messages_insert"
  on coach_messages for insert
  with check (auth.uid() = user_id);
