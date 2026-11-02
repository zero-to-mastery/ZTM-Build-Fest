-- Optional scheduled social publishing, the delivery queue (ADRs 0316 to 0318): the functions
-- a hosted worker calls to claim due announcements atomically, hold them under a lease, record what
-- the provider answered, and recover from a crash. Run once in the Supabase SQL editor, after
-- social.sql, only if the site opts in to delivery. Until then announcements wait in the queue and
-- nothing is sent. Running it twice changes nothing.
--
-- Additive only: it adds four nullable or defaulted columns, one index and four functions. It
-- rewrites no row and drops nothing. To undo it, see social-queue-rollback.sql.
--
-- Why functions: PostgREST cannot say `for update skip locked`, and a claim that is a read followed
-- by a write lets two workers take one row. Each function is one unit of work in one transaction.
-- They run as the caller (security invoker), so they can do nothing the table grants do not
-- already allow, and only service_role may execute them.
--
-- The rules they keep (ADR 0316, 0317, 0318):
--   * claim_due takes at most a bounded batch of due, scheduled rows with `for update skip locked`,
--     moves them to `claimed` with a lease, counts the attempt and opens its attempt row, all at once.
--   * mark_sending records the moment before the provider call, and only while the lease is valid.
--   * reap_leases finds claims whose lease ran out. A claim that never reached "sending" goes back to
--     the queue; one that did is `unknown` (the provider may have posted), never blindly retried.
--   * settle records an outcome fenced by the row's version, so a worker that lost its lease cannot
--     overwrite whoever holds it. `published` needs the provider's own post id.

begin;

insert into public.openblog_social_schema (version) values (2) on conflict do nothing;

alter table public.openblog_social_posts
  add column if not exists next_attempt_at timestamptz,
  add column if not exists attempt_floor integer not null default 0 check (attempt_floor >= 0),
  add column if not exists reconcile_count integer not null default 0 check (reconcile_count >= 0);
alter table public.openblog_social_attempts
  add column if not exists sending_at timestamptz;
alter table public.openblog_social_accounts
  add column if not exists paused_until timestamptz;

create index if not exists openblog_social_posts_reconcile
  on public.openblog_social_posts (site_id, next_attempt_at)
  where status = 'unknown';

-- Expired leases. A claim whose attempt never reached the provider call goes back to `scheduled`
-- (or `failed` when its attempts are used up); one that did is `unknown`. Returns how many it moved.
create or replace function public.openblog_social_reap_leases(
  p_site_id text,
  p_limit integer default 50,
  p_max_attempts integer default 5
) returns integer
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_row public.openblog_social_posts;
  v_sent boolean;
  v_max integer := least(greatest(coalesce(p_max_attempts, 5), 1), 10);
  v_count integer := 0;
begin
  if p_site_id is null or p_site_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' then
    raise exception 'invalid site' using errcode = '22023';
  end if;
  for v_row in
    select * from public.openblog_social_posts
    where site_id = p_site_id and status = 'claimed' and lease_expires_at <= now()
    order by lease_expires_at
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  loop
    select coalesce(bool_or(a.sending_at is not null), false) into v_sent
      from public.openblog_social_attempts a
      where a.post_id = v_row.id and a.site_id = v_row.site_id
        and a.attempt_no = v_row.attempt_count and a.finished_at is null;
    update public.openblog_social_attempts
      set finished_at = now(),
          outcome = case when v_sent then 'unknown' else 'failed' end,
          error_code = 'lease-expired'
      where post_id = v_row.id and site_id = v_row.site_id
        and attempt_no = v_row.attempt_count and finished_at is null;
    update public.openblog_social_posts
      set status = case
            when v_sent then 'unknown'
            when v_row.attempt_count - v_row.attempt_floor >= v_max then 'failed'
            else 'scheduled' end,
          claimed_by = null, claimed_at = null, lease_expires_at = null,
          next_attempt_at = case
            when v_sent then now() + interval '5 minutes'
            when v_row.attempt_count - v_row.attempt_floor >= v_max then null
            else now() end,
          last_error_code = case
            when v_sent then 'lease-expired'
            when v_row.attempt_count - v_row.attempt_floor >= v_max then 'attempts-exhausted'
            else 'lease-expired' end,
          version = version + 1, updated_at = now()
      where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$fn$;

-- Claim due work. Returns the rows it claimed, each with a lease and a fresh attempt row.
-- p_skip_providers lists providers this deployment knows but has no adapter for yet: their rows
-- wait in the queue untouched instead of failing.
create or replace function public.openblog_social_claim_due(
  p_site_id text,
  p_worker text default '@worker',
  p_limit integer default 5,
  p_lease_seconds integer default 300,
  p_max_attempts integer default 5,
  p_per_account integer default 3,
  p_skip_providers text[] default '{}'
) returns setof public.openblog_social_posts
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 25);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
  v_max integer := least(greatest(coalesce(p_max_attempts, 5), 1), 10);
  v_per integer := least(greatest(coalesce(p_per_account, 3), 1), 25);
  v_skip text[] := coalesce(p_skip_providers, '{}');
begin
  if p_site_id is null or p_site_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' then
    raise exception 'invalid site' using errcode = '22023';
  end if;
  if p_worker is null or p_worker !~ '^(@worker|[a-z0-9_.-]{1,32})$' then
    raise exception 'invalid worker' using errcode = '22023';
  end if;
  perform public.openblog_social_reap_leases(p_site_id, 50, v_max);
  return query
  with due as (
    select p.id
    from public.openblog_social_posts p
    where p.site_id = p_site_id
      and p.status = 'scheduled'
      and p.scheduled_for <= now()
      and coalesce(p.next_attempt_at, p.scheduled_for) <= now()
      and p.attempt_count - p.attempt_floor < v_max
      and p.id in (
        select r.id from (
          select q.id,
                 row_number() over (partition by q.account_id order by q.scheduled_for, q.id) as rn
          from public.openblog_social_posts q
          join public.openblog_social_accounts a on a.id = q.account_id and a.site_id = q.site_id
          where q.site_id = p_site_id
            and q.status = 'scheduled'
            and q.scheduled_for <= now()
            and coalesce(q.next_attempt_at, q.scheduled_for) <= now()
            and q.attempt_count - q.attempt_floor < v_max
            and (a.paused_until is null or a.paused_until <= now())
            and not (a.provider = any (v_skip))
        ) r where r.rn <= v_per
      )
    order by p.scheduled_for, p.id
    limit v_limit
    for update of p skip locked
  ),
  claimed as (
    update public.openblog_social_posts p
      set status = 'claimed',
          claimed_by = p_worker,
          claimed_at = now(),
          lease_expires_at = now() + make_interval(secs => v_lease),
          attempt_count = p.attempt_count + 1,
          next_attempt_at = null,
          version = p.version + 1,
          updated_at = now()
      from due
      where p.id = due.id
      returning p.*
  ),
  logged as (
    insert into public.openblog_social_attempts (site_id, post_id, attempt_no, worker)
    select c.site_id, c.id, c.attempt_count, p_worker from claimed c
  )
  select * from claimed;
end
$fn$;

-- The moment before the provider call. True only while this attempt still holds a valid lease; a
-- worker that gets false must not call the provider.
create or replace function public.openblog_social_mark_sending(
  p_site_id text,
  p_post_id uuid,
  p_attempt_no integer
) returns boolean
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_rows integer;
begin
  update public.openblog_social_attempts a
    set sending_at = now()
    from public.openblog_social_posts p
    where a.site_id = p_site_id and a.post_id = p_post_id and a.attempt_no = p_attempt_no
      and a.finished_at is null and a.sending_at is null
      and p.id = a.post_id and p.site_id = a.site_id
      and p.status = 'claimed' and p.attempt_count = p_attempt_no
      and p.lease_expires_at > now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$fn$;

-- Records an outcome. Fenced by `p_version`: nothing happens (no row returned) unless the row is
-- still the one the caller read. From `claimed`: published, retry, failed or unknown. From
-- `unknown`: published, failed, or unknown again (a reconciliation that learned nothing).
create or replace function public.openblog_social_settle(
  p_site_id text,
  p_post_id uuid,
  p_version integer,
  p_result text,
  p_provider_post_id text default null,
  p_http_status integer default null,
  p_request_id text default null,
  p_error_code text default null,
  p_error_detail text default null,
  p_next_at timestamptz default null
) returns setof public.openblog_social_posts
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_row public.openblog_social_posts;
begin
  if p_site_id is null or p_site_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' then
    raise exception 'invalid site' using errcode = '22023';
  end if;
  if p_result is null or p_result not in ('published', 'retry', 'failed', 'unknown') then
    raise exception 'invalid result' using errcode = '22023';
  end if;
  if p_result = 'published' and coalesce(p_provider_post_id, '') = '' then
    raise exception 'a published post needs the provider post id' using errcode = '22023';
  end if;
  select * into v_row from public.openblog_social_posts
    where id = p_post_id and site_id = p_site_id and version = p_version
      and status in ('claimed', 'unknown')
    for update;
  if not found then
    return;
  end if;
  if v_row.status = 'unknown' and p_result = 'retry' then
    raise exception 'an unknown outcome resolves only to published or failed' using errcode = '22023';
  end if;

  if v_row.status = 'claimed' or p_result <> 'unknown' then
    update public.openblog_social_attempts
      set finished_at = coalesce(finished_at, now()),
          outcome = case p_result when 'published' then 'published' when 'unknown' then 'unknown' else 'failed' end,
          http_status = coalesce(p_http_status, http_status),
          provider_request_id = coalesce(p_request_id, provider_request_id),
          provider_post_id = case when p_result = 'published' then p_provider_post_id else provider_post_id end,
          error_code = case when p_result = 'published' then null else coalesce(p_error_code, error_code) end,
          error_detail = case when p_result = 'published' then null else left(coalesce(p_error_detail, error_detail), 500) end
      where post_id = v_row.id and site_id = v_row.site_id and attempt_no = v_row.attempt_count
        and (finished_at is null or outcome = 'unknown');
  end if;

  if p_result = 'published' then
    update public.openblog_social_posts
      set status = 'published', published_at = now(), provider_post_id = p_provider_post_id,
          claimed_by = null, claimed_at = null, lease_expires_at = null, next_attempt_at = null,
          last_error_code = null, version = version + 1, updated_at = now()
      where id = v_row.id returning * into v_row;
  elsif p_result = 'retry' then
    update public.openblog_social_posts
      set status = 'scheduled', claimed_by = null, claimed_at = null, lease_expires_at = null,
          next_attempt_at = coalesce(p_next_at, now()), last_error_code = p_error_code,
          attempt_floor = attempt_floor + case when p_error_code = 'deferred' then 1 else 0 end,
          version = version + 1, updated_at = now()
      where id = v_row.id returning * into v_row;
  elsif p_result = 'failed' then
    update public.openblog_social_posts
      set status = 'failed', claimed_by = null, claimed_at = null, lease_expires_at = null,
          next_attempt_at = null, last_error_code = p_error_code,
          version = version + 1, updated_at = now()
      where id = v_row.id returning * into v_row;
  else
    update public.openblog_social_posts
      set status = 'unknown', claimed_by = null, claimed_at = null, lease_expires_at = null,
          next_attempt_at = p_next_at,
          reconcile_count = reconcile_count + case when v_row.status = 'unknown' then 1 else 0 end,
          last_error_code = coalesce(p_error_code, last_error_code),
          version = version + 1, updated_at = now()
      where id = v_row.id returning * into v_row;
  end if;

  -- A provider that said "slow down" pauses the whole account, not just this post.
  if p_error_code = 'rate-limited' and p_next_at is not null then
    update public.openblog_social_accounts
      set paused_until = greatest(coalesce(paused_until, p_next_at), p_next_at), updated_at = now()
      where id = v_row.account_id and site_id = v_row.site_id;
  end if;
  return next v_row;
end
$fn$;

revoke all on function public.openblog_social_reap_leases(text, integer, integer) from public, anon, authenticated;
revoke all on function public.openblog_social_claim_due(text, text, integer, integer, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.openblog_social_mark_sending(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.openblog_social_settle(text, uuid, integer, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_social_reap_leases(text, integer, integer) to service_role;
grant execute on function public.openblog_social_claim_due(text, text, integer, integer, integer, integer, text[]) to service_role;
grant execute on function public.openblog_social_mark_sending(text, uuid, integer) to service_role;
grant execute on function public.openblog_social_settle(text, uuid, integer, text, text, integer, text, text, text, timestamptz) to service_role;

commit;
