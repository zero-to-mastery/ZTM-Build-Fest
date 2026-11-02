-- Roll back the moderation inbox's full schema (ADR 0106). Run in the
-- Supabase SQL editor. If the site takes Third Perspectives, run
-- third-perspective-rollback.sql first: their moderation uses these columns.
--
-- First remove OPENBLOG_MODERATION_ENABLED from the Netlify environment and
-- redeploy, so the function stops using what this drops; Admin's inbox then
-- offers only what the older schema can store. If you want to keep the
-- moderation record, export it first, for example with:
--
--   select * from public.openblog_comment_events order by at;
--   select * from public.openblog_feedback_events order by at;
--
-- This drops only what moderation.sql added to comments, and what
-- feedback.sql added for the inbox, leaving every comment, every feedback
-- item and its state in place. No comment becomes public: a removed
-- comment's `status` is already rejected, and stays so. Feedback the inbox
-- asked a reader to clarify keeps its state; the older schema can only
-- reject it. Older audit events in openblog_feedback_events are kept.

begin;

drop function if exists public.openblog_moderate_comment(text, uuid, integer, text, text, text, text, text, text, timestamptz);
drop table if exists public.openblog_comment_events;
alter table public.openblog_comments drop column if exists moderation_reason;
alter table public.openblog_comments drop column if exists moderation_state;
alter table public.openblog_comments drop column if exists version;

-- The correction decision function (ADR 0117) reads item_revision, which is dropped below:
-- corrections-rollback.sql drops its columns too, and this only makes sure it is gone first.
drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);
drop function if exists public.openblog_moderate_feedback_item(text, uuid, integer, text, text, text, text, text, text, timestamptz, text, jsonb);
alter table if exists public.openblog_feedback_events drop column if exists actor_role;
alter table if exists public.openblog_feedback_events drop column if exists item_revision;
alter table if exists public.openblog_feedback_events drop column if exists kind;
alter table if exists public.openblog_feedback drop column if exists clarification_consent;
alter table if exists public.openblog_feedback drop column if exists clarification_asked;
alter table if exists public.openblog_feedback drop column if exists approved_revision;
alter table if exists public.openblog_feedback drop column if exists item_revision;

commit;
