-- Optional scheduled social publishing, the schedule that wakes the delivery worker (ADR 0317).
-- Run once in the Supabase SQL editor, after social.sql and social-queue.sql, only if the site opts
-- in to delivery. It makes Supabase call the hosted worker (netlify/functions/social-worker.mjs)
-- once a minute with pg_cron and pg_net. Until it runs, announcements wait and nothing is sent.
-- Running it twice leaves one job.
--
-- The worker's address and key are NOT in this file or in any table you can read back. Put them in
-- Supabase Vault first, once, from the SQL editor (the key is the same value as
-- OPENBLOG_SOCIAL_WORKER_KEY on the hosted function; replace the placeholders):
--
--   select vault.create_secret('https://YOUR-SITE.example/api/social-worker', 'openblog_social_worker_url');
--   select vault.create_secret('THE-WORKER-KEY', 'openblog_social_worker_key');
--
-- Vault encrypts them at rest. The ping function below is the only code that reads them; nobody but
-- the database owner can execute it (anon, authenticated and service_role cannot), and it never
-- returns or logs either value. The worker key is not the anon key, the service_role key or the
-- admin key, and the worker refuses all of those. If either secret is missing the ping does nothing.
-- To rotate the key, change OPENBLOG_SOCIAL_WORKER_KEY and update the secret with vault.update_secret(...).
--
-- Additive: one function and one cron job named openblog-social-worker. To undo it, see
-- social-cron-rollback.sql.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.openblog_social_worker_ping() returns bigint
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'openblog_social_worker_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'openblog_social_worker_key' limit 1;
  -- Not set up yet, or not an https address: do nothing rather than send a key anywhere unsafe.
  if v_url is null or v_key is null or v_url !~ '^https://[^/\s]+(/[^\s?#]*)?$' or length(v_key) < 32 then
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 15000
  );
end
$fn$;

revoke all on function public.openblog_social_worker_ping() from public, anon, authenticated, service_role;

-- Replace any earlier job of this name, then schedule one: every minute.
select cron.unschedule(jobid) from cron.job where jobname = 'openblog-social-worker';
select cron.schedule('openblog-social-worker', '* * * * *', 'select public.openblog_social_worker_ping()');

commit;
