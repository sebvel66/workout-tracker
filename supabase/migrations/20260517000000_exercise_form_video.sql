-- Web-grounded form-video link per (user × exercise), v3.6.26.
-- Sits alongside the existing AI/user form notes in exercise_form_notes.
-- Populated on demand via /api/coach-chat mode:'form_video' (Anthropic
-- server-side web search), re-read across future sessions like ai_note.
--
-- No new RLS: the composite PK (user_id, exercise_id) and the existing
-- owner-only select/insert/update/delete policies already cover these
-- columns. Nullable: a row may have notes but no video, or vice versa.

alter table exercise_form_notes
  add column ai_video_url text,
  add column ai_video_title text,
  add column ai_video_generated_at timestamptz;
