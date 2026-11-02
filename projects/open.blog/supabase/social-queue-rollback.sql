-- Roll back the social delivery queue (ADRs 0316 to 0318): the claim, lease and settle functions and
-- the columns social-queue.sql added. Run in the Supabase SQL editor, after removing the scheduled
-- worker (social-cron-rollback.sql) so nothing calls the functions while you undo.
--
-- Announcements and their delivery history stay. Rows that are `claimed` keep their lease columns
-- and nothing will release them: set them back with
--   update public.openblog_social_posts set status = 'scheduled', claimed_by = null, claimed_at = null,
--     lease_expires_at = null where status = 'claimed';
-- only if you are sure no worker is mid-delivery. Rows that are `unknown` may already be on the
-- provider: check there before you retry them. social-rollback.sql drops everything, this file
-- included, so this one is only for going back to "announcements wait and nothing sends".

begin;

drop function if exists public.openblog_social_settle(text, uuid, integer, text, text, integer, text, text, text, timestamptz);
drop function if exists public.openblog_social_mark_sending(text, uuid, integer);
drop function if exists public.openblog_social_claim_due(text, text, integer, integer, integer, integer, text[]);
drop function if exists public.openblog_social_reap_leases(text, integer, integer);
drop index if exists public.openblog_social_posts_reconcile;

alter table if exists public.openblog_social_posts
  drop column if exists next_attempt_at,
  drop column if exists attempt_floor,
  drop column if exists reconcile_count;
alter table if exists public.openblog_social_attempts drop column if exists sending_at;
alter table if exists public.openblog_social_accounts drop column if exists paused_until;

delete from public.openblog_social_schema where version = 2;

commit;
