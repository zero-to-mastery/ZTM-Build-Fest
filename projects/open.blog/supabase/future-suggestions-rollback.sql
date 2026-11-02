-- Roll back Suggestions for future work's storage (ADR 0154). Run in the
-- Supabase SQL editor, before feedback-rollback.sql if you are undoing that
-- too (it drops the table, and with it the check this file restores).
--
-- First remove OPENBLOG_SUGGESTIONS_ENABLED from the Netlify environment and
-- redeploy, so the function stops taking suggestions; readers then get the
-- copy-and-send path. If you want to keep what readers sent, export it first,
-- for example with:
--
--   select * from public.openblog_feedback where kind = 'future-suggestion' order by received_at;
--
-- This restores the check feedback.sql loosened: a row has its page, passage
-- revision and passage target together, or none of them. It cannot do that
-- while a row has a page and no passage, which is what every suggestion is,
-- so it refuses and changes nothing until you have dealt with those rows
-- yourself: export them, then delete them with
--
--   delete from public.openblog_feedback
--    where work is not null and (revision is null or target is null);
--
-- (an audit event of a deleted row blocks the delete; delete the events of
-- those rows from public.openblog_feedback_events first). Comments, passage
-- feedback, Third Perspectives and every other table are untouched.
--
-- protection.sql's `openblog_feedback_events_keep_recent` trigger refuses to
-- delete an audit event recorded less than a day ago (it raises
-- check_violation). If you must remove events of suggestions received in the
-- last day, wait until they are a day old, then delete them; do not drop the
-- trigger to get round it, which would remove the protection for every other
-- event. Until the events and rows are gone, this file refuses and changes
-- nothing.
--
-- Running feedback.sql again, for any reason, loosens the check again: it
-- drops and re-adds openblog_feedback_passage_complete in its loosened form.
-- Run this file after the last time you run feedback.sql, and run it again if
-- you ever run feedback.sql afterwards.

begin;

do $$
begin
  if exists (
    select 1 from public.openblog_feedback
     where work is not null and (revision is null or target is null)
  ) then
    raise exception 'openblog_feedback still has rows with a page and no passage (suggestions for future work); export and delete them, as the header of this file says, then run it again';
  end if;
end $$;

alter table public.openblog_feedback drop constraint if exists openblog_feedback_passage_complete;
alter table public.openblog_feedback add constraint openblog_feedback_passage_complete check (
  (work is null and revision is null and target is null)
  or (work is not null and revision is not null and target is not null)
);

commit;
