-- Roll back optional scheduled social publishing (ADRs 0293 to 0295). Run in
-- the Supabase SQL editor.
--
-- First remove OPENBLOG_SOCIAL_ENABLED from the Netlify environment and
-- redeploy, and stop the scheduled worker, so nothing writes while you undo.
-- If you want to keep the schedule or the delivery history, export them first:
--
--   select * from public.openblog_social_posts order by scheduled_for;
--   select * from public.openblog_social_attempts order by started_at;
--
-- This drops only what social.sql and social-queue.sql added: the connection, credential, attempt,
-- queue and account tables (their rows go with them) and the schema version
-- table. It touches no comment, feedback, subscription or workspace table, and
-- no post. Nothing already published to LinkedIn or Facebook is removed there.
-- Revoke the app's access in each provider's own settings as well: stored
-- tokens are deleted here but stay valid at the provider until revoked.
-- Delete OPENBLOG_SOCIAL_TOKEN_KEYS afterwards.
--
-- It leaves the pgcrypto extension, which other files in this folder use.

begin;

-- The delivery queue functions (social-queue.sql) return the queue table's row type, so they go first.
drop function if exists public.openblog_social_settle(text, uuid, integer, text, text, integer, text, text, text, timestamptz);
drop function if exists public.openblog_social_mark_sending(text, uuid, integer);
drop function if exists public.openblog_social_claim_due(text, text, integer, integer, integer, integer, text[]);
drop function if exists public.openblog_social_reap_leases(text, integer, integer);

drop table if exists public.openblog_social_connections;
drop table if exists public.openblog_social_credentials;
drop table if exists public.openblog_social_attempts;
drop table if exists public.openblog_social_posts;
drop table if exists public.openblog_social_accounts;
drop table if exists public.openblog_social_schema;

commit;
