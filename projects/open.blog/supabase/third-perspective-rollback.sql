-- Roll back Third Perspectives' storage (ADR 0113). Run in the Supabase SQL
-- editor, before moderation-rollback.sql or protection-rollback.sql if you
-- are undoing those too.
--
-- First remove OPENBLOG_THIRD_PERSPECTIVES_ENABLED from the Netlify
-- environment and redeploy, so the function stops taking Third Perspectives
-- and stops deciding on them; readers then get the copy-and-send path. If
-- you want to keep what readers sent, export it first, for example with:
--
--   select * from public.openblog_feedback where kind = 'third-perspective' order by received_at;
--
-- This drops only what feedback.sql added for Third Perspectives: their
-- moderation function and the column naming the consent record an approval
-- covers. Every Third Perspective row stays, with its state, text, details
-- and receipt, and nothing becomes public: what was approved stays approved
-- at its revision, but without the record of which consent the approval
-- covered, so a later approval needs this file's counterpart in feedback.sql
-- again. Comments, passage feedback and every other table are untouched.

begin;

drop function if exists public.openblog_moderate_third_perspective(text, uuid, integer, text, text, text, text, text, text, timestamptz, integer);
alter table if exists public.openblog_feedback drop column if exists approved_consent;

commit;
