-- Plan templates. A template is a plans row with is_template = true,
-- is_active = false, and optionally a user-facing template_name. Template
-- rows are never activated directly — they're copied into ad-hoc sessions
-- via the Template picker (new 4th card in the start-session modal).
--
-- Single-day templates have a one-entry `days` array; multi-day templates
-- mirror the full plan shape. Same consumers (start modal, templates
-- management modal) handle both.
--
-- No RLS changes: templates are owned by user_id like any other plan and
-- the existing "own_plans" policy covers them. The existing active-plan
-- unique index (plans_one_active_per_user WHERE is_active) is unaffected
-- since templates always have is_active = false.

alter table plans
  add column is_template boolean not null default false,
  add column template_name text;

-- Accelerates "list this user's templates newest first" for the templates
-- management modal and picker. The existing plans (user_id, created_at desc)
-- index covers this, but a partial index keyed to template rows only is
-- tighter and avoids scanning non-template rows.
create index plans_user_templates_recent
  on plans (user_id, created_at desc)
  where is_template = true;
