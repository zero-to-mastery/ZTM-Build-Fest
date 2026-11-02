-- Roll back the social delivery schedule (ADR 0317): stop the cron job and drop the ping function.
-- Run in the Supabase SQL editor. After this nothing wakes the worker; announcements wait.
--
-- It leaves the pg_cron and pg_net extensions (other things may use them) and the two Vault
-- secrets. Remove the secrets when you retire the feature:
--
--   delete from vault.secrets where name in ('openblog_social_worker_url', 'openblog_social_worker_key');
--
-- and rotate OPENBLOG_SOCIAL_WORKER_KEY on the hosted function.

begin;

select cron.unschedule(jobid) from cron.job where jobname = 'openblog-social-worker';
drop function if exists public.openblog_social_worker_ping();

commit;
