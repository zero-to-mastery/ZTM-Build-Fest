-- Roll back feedback.sql (ADR 0080). Run in the Supabase SQL editor.
--
-- First turn the feature off: remove OPENBLOG_FEEDBACK_ENABLED from the
-- Netlify environment and redeploy, so nothing writes to the table. Then, if
-- you want to keep what readers sent, export it, for example from the Table
-- Editor (openblog_feedback, Export to CSV) or with:
--
--   select * from public.openblog_feedback order by received_at;
--
-- This drops only what feedback.sql created: the moderation, deletion and
-- correction decision functions (Third Perspectives' among them), the
-- evidence purge trigger, the audit table and the feedback table, with their
-- indexes and the moderation inbox's, protection's, Third Perspectives' and
-- evidence's columns on them (ADRs 0106, 0108, 0113 and 0117). Comments, analytics, rate
-- limits and every other table are untouched. Feedback rows are deleted with
-- it and cannot be recovered without your export. To keep feedback and undo
-- only the moderation inbox, run moderation-rollback.sql instead; to undo
-- only evidence and correction decisions, corrections-rollback.sql.

begin;

drop function if exists public.openblog_record_feedback_decision(text, uuid, integer, integer, jsonb, text, text, timestamptz);
drop trigger if exists openblog_feedback_purge_evidence on public.openblog_feedback;
drop function if exists public.openblog_feedback_purge_evidence();
drop function if exists public.openblog_moderate_third_perspective(text, uuid, integer, text, text, text, text, text, text, timestamptz, integer);
drop function if exists public.openblog_erase_feedback(text, uuid, integer, boolean, text, text, timestamptz);
drop function if exists public.openblog_moderate_feedback_item(text, uuid, integer, text, text, text, text, text, text, timestamptz, text, jsonb);
drop function if exists public.openblog_moderate_feedback(text, uuid, integer, text, text, text, text, text, timestamptz);
drop table if exists public.openblog_feedback_events;
drop table if exists public.openblog_feedback;

commit;
