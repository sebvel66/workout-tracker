-- Adds the partial unique index that was intended for the initial migration
-- but never landed in the live database due to a re-run failure.
-- See DECISIONS.md → "Active plan uniqueness" for rationale.

create unique index plans_one_active_per_user
  on plans (user_id) where is_active = true;
