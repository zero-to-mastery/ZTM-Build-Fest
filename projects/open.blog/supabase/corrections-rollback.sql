-- Roll back evidence submissions and correction decisions (ADRs 0116 and
-- 0117), what feedback.sql added for them. Run in the Supabase SQL editor,
-- before moderation-rollback.sql or feedback-rollback.sql if you are undoing
-- those too.
--
-- First remove OPENBLOG_CORRECTIONS_ENABLED from the Netlify environment
-- and redeploy, so the function stops taking evidence and recording
-- decisions, and set `engagement.evidence` back to false in openblog.json
-- so the form stops offering it. If you want to keep readers' evidence
-- blocks or your decisions, export them first, for example with:
--
--   select id, kind, evidence, decisions from public.openblog_feedback
--    where evidence is not null or decisions is not null order by received_at;
--
-- This drops only what was added: the decision function, the trigger that
-- deletes evidence with a purged note, its check and the two columns. Every
-- feedback item keeps its text, kind, state and version, and nothing becomes
-- public. A note sent with evidence keeps the reader's note but loses its
-- evidence block, and is read as the version 1 submission it then is. The
-- audit events of decisions stay in openblog_feedback_events.

begin;

drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);
drop trigger if exists openblog_feedback_purge_evidence on public.openblog_feedback;
drop function if exists public.openblog_feedback_purge_evidence();
alter table if exists public.openblog_feedback drop constraint if exists openblog_feedback_evidence_needs_version_2;
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'openblog_feedback' and column_name = 'evidence') then
    update public.openblog_feedback set format_version = 1 where format_version = 2;
  end if;
end $$;
alter table if exists public.openblog_feedback drop column if exists evidence;
alter table if exists public.openblog_feedback drop column if exists decisions;

commit;
