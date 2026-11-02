-- Run once in the Supabase SQL editor. Tables are private: the Netlify
-- Function uses the service role and public pages never receive a Supabase key.

create extension if not exists pgcrypto;

create table if not exists public.openblog_comments (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  path text not null,
  author_name text not null check (char_length(author_name) between 1 and 80),
  body text not null check (char_length(body) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  moderated_at timestamptz
);
create index if not exists openblog_comments_public on public.openblog_comments (site_id, path, status, created_at);

create table if not exists public.openblog_daily_views (
  site_id text not null,
  day date not null,
  path text not null,
  views bigint not null default 0,
  uniques bigint not null default 0,
  primary key (site_id, day, path)
);
create table if not exists public.openblog_daily_visitors (
  site_id text not null,
  day date not null,
  path text not null,
  visitor_hash text not null,
  primary key (site_id, day, path, visitor_hash)
);
create table if not exists public.openblog_daily_referrers (
  site_id text not null,
  day date not null,
  host text not null,
  views bigint not null default 0,
  primary key (site_id, day, host)
);
create table if not exists public.openblog_rate_limits (
  site_id text not null,
  bucket text not null,
  window_start timestamptz not null,
  subject_hash text not null,
  requests integer not null default 0,
  primary key (site_id, bucket, window_start, subject_hash)
);

alter table public.openblog_comments enable row level security;
alter table public.openblog_daily_views enable row level security;
alter table public.openblog_daily_visitors enable row level security;
alter table public.openblog_daily_referrers enable row level security;
alter table public.openblog_rate_limits enable row level security;

create or replace function public.openblog_consume_rate_limit(
  p_site_id text,
  p_bucket text,
  p_window_start timestamptz,
  p_subject_hash text,
  p_subject_limit integer,
  p_site_limit integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare subject_count integer; site_count integer;
begin
  if p_subject_limit < 1 or p_site_limit < 1 or p_subject_hash = '*' then
    raise exception 'invalid rate limit request';
  end if;
  delete from openblog_rate_limits where window_start < p_window_start - interval '48 hours';
  insert into openblog_rate_limits(site_id, bucket, window_start, subject_hash, requests)
  values (p_site_id, p_bucket, p_window_start, p_subject_hash, 1)
  on conflict (site_id, bucket, window_start, subject_hash) do update
    set requests = openblog_rate_limits.requests + 1
  returning requests into subject_count;
  insert into openblog_rate_limits(site_id, bucket, window_start, subject_hash, requests)
  values (p_site_id, p_bucket, p_window_start, '*', 1)
  on conflict (site_id, bucket, window_start, subject_hash) do update
    set requests = openblog_rate_limits.requests + 1
  returning requests into site_count;
  return jsonb_build_object('allowed', subject_count <= p_subject_limit and site_count <= p_site_limit);
end $$;

create or replace function public.openblog_record_view(p_site_id text, p_day date, p_path text, p_visitor_hash text, p_referrer text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inserted_count bigint; is_unique boolean; total bigint;
begin
  delete from openblog_daily_visitors where site_id = p_site_id and day < p_day - 400;
  insert into openblog_daily_visitors(site_id, day, path, visitor_hash)
  values (p_site_id, p_day, p_path, p_visitor_hash) on conflict do nothing;
  get diagnostics inserted_count = row_count;
  is_unique := inserted_count = 1;
  insert into openblog_daily_views(site_id, day, path, views, uniques)
  values (p_site_id, p_day, p_path, 1, case when is_unique then 1 else 0 end)
  on conflict (site_id, day, path) do update set
    views = openblog_daily_views.views + 1,
    uniques = openblog_daily_views.uniques + case when is_unique then 1 else 0 end;
  if p_referrer <> '' then
    insert into openblog_daily_referrers(site_id, day, host, views) values (p_site_id, p_day, p_referrer, 1)
    on conflict (site_id, day, host) do update set views = openblog_daily_referrers.views + 1;
  end if;
  select sum(views) into total from openblog_daily_views where site_id = p_site_id and path = p_path;
  return jsonb_build_object('views', coalesce(total, 0));
end $$;

create or replace function public.openblog_page_views(p_site_id text, p_path text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('views', coalesce(sum(views), 0)) from openblog_daily_views where site_id = p_site_id and path = p_path;
$$;

create or replace function public.openblog_analytics_summary(p_site_id text, p_days integer)
returns jsonb language sql security definer set search_path = public as $$
with bounds as (
  select current_date - (greatest(1, least(p_days, 365)) - 1) as from_day, current_date as to_day
), series as (
  select d::date as day, coalesce(sum(v.views), 0)::bigint as views, coalesce(sum(v.uniques), 0)::bigint as uniques
  from bounds, generate_series(from_day, to_day, interval '1 day') d
  left join openblog_daily_views v on v.site_id = p_site_id and v.day = d::date group by d order by d
), top_posts as (
  select path, sum(views)::bigint views, sum(uniques)::bigint uniques,
    (select coalesce(sum(allv.views), 0) from openblog_daily_views allv where allv.site_id = p_site_id and allv.path = v.path)::bigint all_time
  from openblog_daily_views v, bounds where site_id = p_site_id and day between from_day and to_day group by path order by views desc limit 50
), refs as (
  select host, sum(views)::bigint views from openblog_daily_referrers, bounds
  where site_id = p_site_id and day between from_day and to_day group by host order by views desc limit 50
)
select jsonb_build_object(
  'days', greatest(1, least(p_days, 365)), 'from', (select from_day from bounds), 'to', (select to_day from bounds),
  'views', (select coalesce(sum(views), 0) from series), 'uniques', (select coalesce(sum(uniques), 0) from series),
  'allTimeViews', (select coalesce(sum(views), 0) from openblog_daily_views where site_id = p_site_id),
  'firstDay', (select min(day) from openblog_daily_views where site_id = p_site_id),
  'series', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'views', views, 'uniques', uniques)), '[]') from series),
  'topPosts', (select coalesce(jsonb_agg(jsonb_build_object('path', path, 'views', views, 'uniques', uniques, 'allTime', all_time)), '[]') from top_posts),
  'referrers', (select coalesce(jsonb_agg(jsonb_build_object('host', host, 'views', views)), '[]') from refs),
  'agentRequests', 0, 'agents', '[]'::jsonb, 'agentPages', '[]'::jsonb
);
$$;

revoke all on public.openblog_comments, public.openblog_daily_views, public.openblog_daily_visitors, public.openblog_daily_referrers, public.openblog_rate_limits from public, anon, authenticated;
revoke all on function public.openblog_consume_rate_limit(text,text,timestamptz,text,integer,integer), public.openblog_record_view(text,date,text,text,text), public.openblog_page_views(text,text), public.openblog_analytics_summary(text,integer) from public, anon, authenticated;
grant all on public.openblog_comments, public.openblog_daily_views, public.openblog_daily_visitors, public.openblog_daily_referrers, public.openblog_rate_limits to service_role;
grant execute on function public.openblog_consume_rate_limit(text,text,timestamptz,text,integer,integer), public.openblog_record_view(text,date,text,text,text), public.openblog_page_views(text,text), public.openblog_analytics_summary(text,integer) to service_role;
