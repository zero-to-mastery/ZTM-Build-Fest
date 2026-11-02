-- Optional update subscriptions for continuations (ADR 0225). Run once in the
-- Supabase SQL editor, only if the site opts in to update subscriptions. A
-- site that does not opt in never needs it, and every continuation link works
-- without it.
--
-- Additive only: it creates one private table and nine functions. It does not
-- rename, drop or rewrite any existing table, column, function or row, so
-- comments, feedback and analytics keep working exactly as before. It does
-- not touch openblog_feedback, so no address can reach a moderation export.
-- Running it twice changes nothing. To undo it, see subscriptions-rollback.sql.
--
-- Nothing here is used until OPENBLOG_SUBSCRIPTIONS_ENABLED is set to `true`
-- in the Netlify environment AND a mail provider is configured for the
-- function; with either missing the page offers links only.
--
-- The table is private: row level security is on with no policies, the public
-- roles have no access, and only the Netlify Function (service_role) calls
-- the functions below. Tokens are made here by pgcrypto's gen_random_bytes (a
-- secure random source) and only a SHA-256 digest of each is stored. An
-- address is kept only for a pending or active subscription; unsubscribing,
-- deleting and expiry delete the whole row.
--
-- The caller's order of work (ADR 0225):
--   subscribe:  openblog_subscribe -> send the confirmation message. If the
--               send fails, call openblog_cancel_subscription_request with the
--               confirmation token, so no address stays stored for a message
--               that never left and a retry is not turned away as a repeat.
--   an update:  openblog_queue_subscription_update when a later work is
--               published (nothing is sent); then, from a scheduled run,
--               openblog_subscription_recipients -> send one message with the
--               waiting updates -> openblog_mark_subscription_sent only if the
--               send worked. A failed send marks nothing, so the updates wait
--               for the next run.

begin;

create extension if not exists pgcrypto;

create table if not exists public.openblog_subscriptions (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (char_length(site_id) between 1 and 200),
  -- What is followed: one page's questions, or one series. Never a person.
  scope_kind text not null check (scope_kind in ('page', 'series')),
  scope_value text not null check (char_length(scope_value) between 1 and 500),
  address text not null check (char_length(address) between 3 and 254),
  active boolean not null default false,
  requested_at timestamptz not null default now(),
  -- Digest of the single-use confirmation token; null once used.
  confirm_digest text check (confirm_digest ~ '^[0-9a-f]{64}$'),
  -- Digests of the unsubscribe tokens mailed, newest last, at most 8.
  unsubscribe_digests text[] not null default '{}'
    check (cardinality(unsubscribe_digests) between 1 and 8),
  last_sent_at timestamptz,
  -- Later works waiting for the next message: [{"title":..,"url":..}], oldest
  -- first, at most 10.
  pending_updates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(pending_updates) = 'array' and jsonb_array_length(pending_updates) <= 10)
);

create unique index if not exists openblog_subscriptions_one_per_address
  on public.openblog_subscriptions (site_id, scope_kind, scope_value, lower(address));
create unique index if not exists openblog_subscriptions_confirm
  on public.openblog_subscriptions (confirm_digest) where confirm_digest is not null;
create index if not exists openblog_subscriptions_scope
  on public.openblog_subscriptions (site_id, scope_kind, scope_value) where active;

alter table public.openblog_subscriptions enable row level security;
revoke all on public.openblog_subscriptions from public, anon, authenticated;

create or replace function public.openblog_subscription_digest(p_token text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(p_token, 'sha256'), 'hex');
$$;

-- Take a request. Returns the confirmation and unsubscribe tokens to mail, or
-- no row when nothing is to be sent (already active, or asked within the last
-- hour); the caller answers the reader the same way in every case.
create or replace function public.openblog_subscribe(
  p_site text, p_scope_kind text, p_scope_value text, p_address text
) returns table (confirm_token text, unsubscribe_token text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_confirm text := translate(encode(gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
  v_unsub text := translate(encode(gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
  v_row public.openblog_subscriptions;
begin
  select * into v_row from public.openblog_subscriptions
   where site_id = p_site and scope_kind = p_scope_kind and scope_value = p_scope_value
     and lower(address) = lower(p_address);
  if found then
    if v_row.active or v_row.requested_at > now() - interval '1 hour' then
      return;
    end if;
    delete from public.openblog_subscriptions where id = v_row.id;
  end if;
  insert into public.openblog_subscriptions
    (site_id, scope_kind, scope_value, address, confirm_digest, unsubscribe_digests)
  values
    (p_site, p_scope_kind, p_scope_value, p_address,
     public.openblog_subscription_digest(v_confirm),
     array[public.openblog_subscription_digest(v_unsub)]);
  return query select v_confirm, v_unsub;
end $$;

-- The confirmation message could not be sent: erase the pending request it
-- made, address included, so nothing waits for a message that never left.
-- Only a pending row can be cancelled; true when one was erased.
create or replace function public.openblog_cancel_subscription_request(p_confirm_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count integer;
begin
  delete from public.openblog_subscriptions
   where not active
     and confirm_digest = public.openblog_subscription_digest(p_confirm_token);
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- Follow a confirmation link: once, and within 48 hours. Any other token,
-- used, late or unknown, is the same false.
create or replace function public.openblog_confirm_subscription(p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.openblog_subscriptions;
begin
  select * into v_row from public.openblog_subscriptions
   where confirm_digest = public.openblog_subscription_digest(p_token) for update;
  if not found then
    return false;
  end if;
  update public.openblog_subscriptions set confirm_digest = null where id = v_row.id;
  if v_row.requested_at < now() - interval '48 hours' then
    return false;
  end if;
  update public.openblog_subscriptions set active = true where id = v_row.id;
  return true;
end $$;

-- Unsubscribe or delete: the whole row, address included. No account.
create or replace function public.openblog_unsubscribe(p_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count integer;
begin
  delete from public.openblog_subscriptions
   where public.openblog_subscription_digest(p_token) = any (unsubscribe_digests);
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;

-- Note a later work for every active subscription it reaches: the page whose
-- question it takes up, or its series. Nothing is sent. An update already
-- waiting for the same url is not added twice; past 10 the oldest is dropped.
-- Returns how many subscriptions it was noted for.
create or replace function public.openblog_queue_subscription_update(
  p_site text, p_page text, p_series text, p_title text, p_url text
) returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count integer;
begin
  if p_title is null or char_length(p_title) not between 1 and 200
     or p_url is null or char_length(p_url) not between 1 and 500 then
    return 0;
  end if;
  update public.openblog_subscriptions as t
     set pending_updates = (
       select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb)
         from jsonb_array_elements(t.pending_updates || jsonb_build_array(
                jsonb_build_object('title', p_title, 'url', p_url)))
              with ordinality as e(value, ord)
        where e.ord > jsonb_array_length(t.pending_updates) + 1 - 10)
   where t.site_id = p_site and t.active
     and ((t.scope_kind = 'page' and t.scope_value = p_page)
       or (t.scope_kind = 'series' and p_series is not null and t.scope_value = p_series))
     and not exists (
       select 1 from jsonb_array_elements(t.pending_updates) as w(value)
        where w.value ->> 'url' = p_url);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The subscriptions due a message: active, with updates waiting, and none
-- sent in the last day (at most one message a day, however many updates wait).
-- Each comes with the waiting updates and a fresh unsubscribe token to put in
-- the message. Nothing is changed here: call openblog_mark_subscription_sent
-- only after the send worked.
create or replace function public.openblog_subscription_recipients(p_site text)
returns table (id uuid, address text, updates jsonb, unsubscribe_token text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.openblog_subscriptions;
begin
  for v_row in
    select * from public.openblog_subscriptions s
     where s.site_id = p_site and s.active
       and jsonb_array_length(s.pending_updates) > 0
       and (s.last_sent_at is null or s.last_sent_at <= now() - interval '1 day')
  loop
    id := v_row.id;
    address := v_row.address;
    updates := v_row.pending_updates;
    unsubscribe_token := translate(encode(gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
    return next;
  end loop;
end $$;

-- A message left: remember when, keep the unsubscribe token it carried (the
-- last eight stay valid) and clear the p_count updates it held, oldest first;
-- any queued since stay waiting. True when the subscription was still there.
create or replace function public.openblog_mark_subscription_sent(
  p_id uuid, p_unsubscribe_token text, p_count integer
) returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.openblog_subscriptions;
  v_digests text[];
begin
  select * into v_row from public.openblog_subscriptions s
   where s.id = p_id and s.active for update;
  if not found or p_count is null or p_count < 0 then
    return false;
  end if;
  v_digests := v_row.unsubscribe_digests || public.openblog_subscription_digest(p_unsubscribe_token);
  if cardinality(v_digests) > 8 then
    v_digests := v_digests[cardinality(v_digests) - 7:cardinality(v_digests)];
  end if;
  update public.openblog_subscriptions as t
     set last_sent_at = now(),
         unsubscribe_digests = v_digests,
         pending_updates = (
           select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb)
             from jsonb_array_elements(t.pending_updates) with ordinality as e(value, ord)
            where e.ord > p_count)
   where t.id = v_row.id;
  return true;
end $$;

-- Erase every pending request whose 48 hours have passed. Run it on a
-- schedule (for example from the retention job).
create or replace function public.openblog_purge_subscriptions()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  v_count integer;
begin
  delete from public.openblog_subscriptions
   where not active and requested_at < now() - interval '48 hours';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.openblog_subscription_digest(text) from public, anon, authenticated;
revoke all on function public.openblog_subscribe(text, text, text, text) from public, anon, authenticated;
revoke all on function public.openblog_confirm_subscription(text) from public, anon, authenticated;
revoke all on function public.openblog_unsubscribe(text) from public, anon, authenticated;
revoke all on function public.openblog_cancel_subscription_request(text) from public, anon, authenticated;
revoke all on function public.openblog_queue_subscription_update(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.openblog_subscription_recipients(text) from public, anon, authenticated;
revoke all on function public.openblog_mark_subscription_sent(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.openblog_purge_subscriptions() from public, anon, authenticated;
grant execute on function public.openblog_subscribe(text, text, text, text) to service_role;
grant execute on function public.openblog_confirm_subscription(text) to service_role;
grant execute on function public.openblog_unsubscribe(text) to service_role;
grant execute on function public.openblog_cancel_subscription_request(text) to service_role;
grant execute on function public.openblog_queue_subscription_update(text, text, text, text, text) to service_role;
grant execute on function public.openblog_subscription_recipients(text) to service_role;
grant execute on function public.openblog_mark_subscription_sent(uuid, text, integer) to service_role;
grant execute on function public.openblog_purge_subscriptions() to service_role;

commit;
