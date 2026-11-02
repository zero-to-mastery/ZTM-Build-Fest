-- Roll back engagement protection (ADRs 0107 and 0108). Run in the Supabase
-- SQL editor, before moderation-rollback.sql if you are undoing that too. If
-- the site takes Third Perspectives, run third-perspective-rollback.sql
-- first: they need receipts, and their moderation reads purged_at.
--
-- First remove OPENBLOG_PROTECTION_ENABLED from the Netlify environment and
-- redeploy, so the function stops issuing receipts, taking abuse reports
-- and purging. If you want to keep abuse reports or their record, export
-- them first, for example with:
--
--   select * from public.openblog_abuse_reports order by received_at;
--   select * from public.openblog_abuse_report_events order by at;
--
-- This drops only what protection.sql added, and what feedback.sql added
-- for protection: the report, purge and deletion functions, the two abuse
-- report tables (their rows are deleted with them), the purge columns and
-- checks, the receipt column and its index, the service role's right to
-- delete audit events, the triggers that keep the last day's events, and
-- the column that links an upheld-report removal to its report. Every
-- comment and feedback item keeps its state, and no comment or note becomes
-- public: a purged item is rejected, removed or withdrawn, and stays so
-- with a placeholder for its text. Text that was purged is gone and cannot
-- be restored. Readers' receipts stop working.

begin;

drop function if exists public.openblog_purge_report(text, uuid, integer, text, text, timestamptz);
drop function if exists public.openblog_purge_comment(text, uuid, integer, text, text, timestamptz);
drop function if exists public.openblog_uphold_report(text, uuid, integer, integer, text, text, text, timestamptz);
drop function if exists public.openblog_moderate_report(text, uuid, integer, text, text, text, text, text, text, timestamptz);
drop function if exists public.openblog_erase_feedback(text, uuid, integer, boolean, text, text, timestamptz);
drop table if exists public.openblog_abuse_report_events;
drop table if exists public.openblog_abuse_reports;
do $$
begin
  if to_regclass('public.openblog_comment_events') is not null then
    revoke delete on public.openblog_comment_events from service_role;
    drop trigger if exists openblog_comment_events_keep_recent on public.openblog_comment_events;
    alter table public.openblog_comment_events drop column if exists related;
  end if;
  if to_regclass('public.openblog_feedback_events') is not null then
    revoke delete on public.openblog_feedback_events from service_role;
    drop trigger if exists openblog_feedback_events_keep_recent on public.openblog_feedback_events;
    alter table public.openblog_feedback_events drop column if exists related;
  end if;
end $$;
drop function if exists public.openblog_keep_recent_audit_events();
alter table public.openblog_comments drop constraint if exists openblog_comments_purged_never_public;
alter table public.openblog_comments drop column if exists purged_at;
alter table if exists public.openblog_feedback drop constraint if exists openblog_feedback_purged_never_public;
alter table if exists public.openblog_feedback drop column if exists purged_at;
drop index if exists public.openblog_feedback_receipt;
alter table if exists public.openblog_feedback drop column if exists receipt_hash;

commit;
