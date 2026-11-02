-- Optional: engagement protection (ADRs 0107 and 0108): reader receipts,
-- abuse reports, deletion requests and the retention job. Run once in the
-- Supabase SQL editor, after openblog.sql and moderation.sql. If the site
-- takes passage feedback, run feedback.sql again first, which adds the
-- receipt and purge columns and functions to the feedback tables. Then set
-- OPENBLOG_PROTECTION_ENABLED=true in Netlify (with
-- OPENBLOG_MODERATION_ENABLED=true) and redeploy. Until then nothing here
-- is used, and Admin's inbox works as before.
--
-- Additive only: it adds one nullable column and one check to
-- openblog_comments, creates the private abuse report table and its audit
-- table, and creates the functions that purge, delete on request and
-- uphold reports. It lets the service role delete audit events, which only
-- the retention job does, once they are older than the site's audit period,
-- and adds a trigger to each audit table that refuses to delete any event
-- recorded in the last day, whoever asks. It adds one nullable column to
-- openblog_comment_events, naming the abuse report an upheld-report removal
-- came from.
-- It does not rename, drop or rewrite any existing table, column, function
-- or row: every comment keeps its text and state, and public reads, which
-- use `status`, see exactly what they saw before. Running it twice changes
-- nothing. To undo it, see protection-rollback.sql.
--
-- Nothing here stores an IP address, a user agent, an e-mail address or any
-- identifier of a reader: an abuse report names only the item reported, and
-- a receipt is kept only as the SHA-256 digest of a random secret the
-- reader holds.

begin;

create extension if not exists pgcrypto;

-- When retention or a deletion request purged a comment's text and name.
-- The row stays, so its state and audit trail stay explainable; the text and
-- name are overwritten with a fixed placeholder that is never shown.
alter table public.openblog_comments
  add column if not exists purged_at timestamptz;
-- A purged comment can never be approved, whatever a caller sends.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'openblog_comments_purged_never_public') then
    alter table public.openblog_comments
      add constraint openblog_comments_purged_never_public check (purged_at is null or status <> 'approved');
  end if;
end $$;

-- Abuse reports (ADR 0107): a reader's report that a public comment or
-- passage feedback item is abusive. Never public, never counted, and never
-- changes its target by itself. It holds the item reported, the reader's
-- ground (a reason code) and up to 1,000 characters they wrote; never a
-- name, contact, address or device detail.
create table if not exists public.openblog_abuse_reports (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (char_length(site_id) between 1 and 200),
  target_source text not null check (target_source in ('comment', 'feedback')),
  target_id uuid not null,
  work text not null check (char_length(work) between 2 and 500),
  ground text not null check (ground ~ '^[a-z][a-z-]{0,31}$'),
  body text check (char_length(body) between 1 and 1000),
  status text not null default 'pending' check (status ~ '^[a-z][a-z-]{0,31}$'),
  version integer not null default 1 check (version >= 1),
  received_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderation_reason text check (moderation_reason ~ '^[a-z][a-z-]{0,31}$'),
  purged_at timestamptz,
  constraint openblog_abuse_reports_purged_has_no_text check (purged_at is null or body is null)
);

create index if not exists openblog_abuse_reports_moderation
  on public.openblog_abuse_reports (site_id, status, received_at);
create index if not exists openblog_abuse_reports_target
  on public.openblog_abuse_reports (site_id, target_source, target_id);

alter table public.openblog_abuse_reports enable row level security;
revoke all on public.openblog_abuse_reports from public, anon, authenticated, service_role;
grant select, insert, update on public.openblog_abuse_reports to service_role;

-- The abuse report audit trail: who decided which report, in which role,
-- from which state to which, why, when, the version it produced, and the
-- item it named. Never the report's text.
create table if not exists public.openblog_abuse_report_events (
  id bigint generated always as identity primary key,
  site_id text not null check (char_length(site_id) between 1 and 200),
  report_id uuid not null references public.openblog_abuse_reports (id),
  action text not null check (action ~ '^[a-z][a-z-]{0,31}$'),
  from_status text not null check (from_status ~ '^[a-z][a-z-]{0,31}$'),
  to_status text not null check (to_status ~ '^[a-z][a-z-]{0,31}$'),
  reason text check (reason ~ '^[a-z][a-z-]{0,31}$'),
  actor text not null check (char_length(actor) between 1 and 80),
  actor_role text not null check (actor_role ~ '^[a-z][a-z-]{0,31}$'),
  at timestamptz not null,
  version integer not null check (version >= 1),
  related uuid
);

create index if not exists openblog_abuse_report_events_item
  on public.openblog_abuse_report_events (site_id, report_id, at);

alter table public.openblog_abuse_report_events enable row level security;
revoke all on public.openblog_abuse_report_events from public, anon, authenticated, service_role;
grant select, insert, delete on public.openblog_abuse_report_events to service_role;

-- The abuse report an upheld-report removal came from, so the comment's
-- audit event and the report's name each other (ADR 0104). Null on every
-- other event, and on every event recorded before the column existed.
alter table public.openblog_comment_events
  add column if not exists related uuid;

-- The retention job deletes audit events older than the site's audit
-- period (ADR 0104); nothing else deletes them. The service role may
-- delete rows, so a trigger on each audit table refuses to delete any event
-- recorded in the last day, whatever a caller sends: no run, mistaken or
-- not, can erase today's record. The function runs with its caller's
-- rights (ADR 0108).
create or replace function public.openblog_keep_recent_audit_events()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.at > now() - interval '1 day' then
    raise exception 'audit events recorded in the last day cannot be deleted'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;
revoke all on function public.openblog_keep_recent_audit_events() from public, anon, authenticated;

grant delete on public.openblog_comment_events to service_role;
create or replace trigger openblog_comment_events_keep_recent
  before delete on public.openblog_comment_events
  for each row execute function public.openblog_keep_recent_audit_events();
create or replace trigger openblog_abuse_report_events_keep_recent
  before delete on public.openblog_abuse_report_events
  for each row execute function public.openblog_keep_recent_audit_events();
do $$
begin
  if to_regclass('public.openblog_feedback_events') is not null then
    grant delete on public.openblog_feedback_events to service_role;
    create or replace trigger openblog_feedback_events_keep_recent
      before delete on public.openblog_feedback_events
      for each row execute function public.openblog_keep_recent_audit_events();
  end if;
end $$;

-- One decision on a report other than upholding it (dismissing, reopening,
-- expiring), with its audit event, only while the report still has the
-- state and version both Admin and the function saw. It returns the
-- changed row, or nothing.
create or replace function public.openblog_moderate_report(
  p_site_id text,
  p_id uuid,
  p_expected_version integer,
  p_from text,
  p_to text,
  p_action text,
  p_reason text,
  p_actor text,
  p_actor_role text,
  p_at timestamptz
)
returns setof public.openblog_abuse_reports
language sql
set search_path = public
as $$
  with changed as (
    update public.openblog_abuse_reports
       set status = p_to,
           moderated_at = p_at,
           moderation_reason = p_reason,
           version = version + 1
     where id = p_id
       and site_id = p_site_id
       and status = p_from
       and version = p_expected_version
       and purged_at is null
       and p_action in ('reject', 'reopen', 'expire')
       and p_to in ('pending', 'rejected')
    returning *
  ), logged as (
    insert into public.openblog_abuse_report_events
      (site_id, report_id, action, from_status, to_status, reason, actor, actor_role, at, version, related)
    select site_id, id, p_action, p_from, p_to, p_reason, p_actor, p_actor_role, p_at, version, target_id from changed
  )
  select * from changed;
$$;

-- Upholding a report (ADR 0104), in one transaction: the report becomes
-- upheld and, while the item it names is still approved, that item is
-- removed with reason upheld-report, each audit event naming the other. It
-- changes nothing unless the report has the version Admin saw and the item
-- is exactly as Admin saw it: approved at p_target_version (then removed),
-- or out of public view with p_target_version null (then left alone). So an
-- upheld report always leaves its item out of public view, or changes
-- nothing at all. It returns {"report": row, "target": row or null}, or
-- {"conflict": "report" | "target"}.
create or replace function public.openblog_uphold_report(
  p_site_id text,
  p_id uuid,
  p_expected_version integer,
  p_target_version integer,
  p_reason text,
  p_actor text,
  p_actor_role text,
  p_at timestamptz
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  report public.openblog_abuse_reports;
  target_status text;
  target_version integer;
  removed jsonb := null;
begin
  select * into report from public.openblog_abuse_reports
   where id = p_id and site_id = p_site_id
   for update;
  if not found or report.status <> 'pending' or report.version <> p_expected_version or report.purged_at is not null then
    return jsonb_build_object('conflict', 'report');
  end if;
  if report.target_source = 'comment' then
    select status, version into target_status, target_version from public.openblog_comments
     where id = report.target_id and site_id = p_site_id for update;
  else
    select status, version into target_status, target_version from public.openblog_feedback
     where id = report.target_id and site_id = p_site_id for update;
  end if;
  if coalesce(target_status, '') = 'approved' then
    if p_target_version is distinct from target_version then
      return jsonb_build_object('conflict', 'target');
    end if;
  elsif p_target_version is not null then
    return jsonb_build_object('conflict', 'target');
  end if;
  update public.openblog_abuse_reports
     set status = 'approved', moderated_at = p_at, moderation_reason = p_reason, version = version + 1
   where id = p_id
  returning * into report;
  insert into public.openblog_abuse_report_events
    (site_id, report_id, action, from_status, to_status, reason, actor, actor_role, at, version, related)
  values (p_site_id, p_id, 'uphold-report', 'pending', 'approved', p_reason, p_actor, p_actor_role, p_at, report.version, report.target_id);
  if coalesce(target_status, '') = 'approved' then
    if report.target_source = 'comment' then
      with changed as (
        update public.openblog_comments
           set moderation_state = 'removed', status = 'rejected', moderated_at = p_at,
               moderation_reason = 'upheld-report', version = version + 1
         where id = report.target_id and site_id = p_site_id
        returning *
      )
      select to_jsonb(changed) into removed from changed;
      insert into public.openblog_comment_events
        (site_id, comment_id, action, from_status, to_status, reason, actor, actor_role, at, version, related)
      values (p_site_id, report.target_id, 'remove', 'approved', 'removed', 'upheld-report', p_actor, p_actor_role, p_at, (removed->>'version')::integer, p_id);
    else
      with changed as (
        update public.openblog_feedback
           set status = 'removed', moderated_at = p_at, moderation_reason = 'upheld-report',
               version = version + 1, approved_revision = null
         where id = report.target_id and site_id = p_site_id
        returning *
      )
      select to_jsonb(changed) into removed from changed;
      insert into public.openblog_feedback_events
        (site_id, feedback_id, action, from_status, to_status, reason, actor, at, version, kind, item_revision, actor_role, related)
      values (p_site_id, report.target_id, 'remove', 'approved', 'removed', 'upheld-report', p_actor, p_at,
              (removed->>'version')::integer, removed->>'kind', (removed->>'item_revision')::integer, p_actor_role, p_id);
    end if;
  end if;
  return jsonb_build_object('report', to_jsonb(report), 'target', removed);
end;
$$;

-- Purging a comment (retention, or the site Admin on a reader's request):
-- its text and name are overwritten with a placeholder that is never shown,
-- purged_at is set and the version raised, with a purge-content event, only
-- while it is closed (stored as rejected), not yet purged and at the
-- version both Admin and the function saw. It returns the row, or nothing.
create or replace function public.openblog_purge_comment(
  p_site_id text,
  p_id uuid,
  p_expected_version integer,
  p_actor text,
  p_actor_role text,
  p_at timestamptz
)
returns setof public.openblog_comments
language sql
set search_path = public
as $$
  with changed as (
    update public.openblog_comments
       set author_name = '-', body = '-', purged_at = p_at, version = version + 1
     where id = p_id
       and site_id = p_site_id
       and status = 'rejected'
       and purged_at is null
       and version = p_expected_version
    returning *
  ), logged as (
    insert into public.openblog_comment_events
      (site_id, comment_id, action, from_status, to_status, reason, actor, actor_role, at, version)
    select site_id, id, 'purge-content', coalesce(moderation_state, status), coalesce(moderation_state, status),
           null, p_actor, p_actor_role, p_at, version from changed
  )
  select * from changed;
$$;

-- Purging a report: its text is deleted, only while it is dismissed or
-- upheld, not yet purged and at the version both saw.
create or replace function public.openblog_purge_report(
  p_site_id text,
  p_id uuid,
  p_expected_version integer,
  p_actor text,
  p_actor_role text,
  p_at timestamptz
)
returns setof public.openblog_abuse_reports
language sql
set search_path = public
as $$
  with changed as (
    update public.openblog_abuse_reports
       set body = null, purged_at = p_at, version = version + 1
     where id = p_id
       and site_id = p_site_id
       and status in ('rejected', 'approved')
       and purged_at is null
       and version = p_expected_version
    returning *
  ), logged as (
    insert into public.openblog_abuse_report_events
      (site_id, report_id, action, from_status, to_status, reason, actor, actor_role, at, version, related)
    select site_id, id, 'purge-content', status, status, null, p_actor, p_actor_role, p_at, version, null from changed
  )
  select * from changed;
$$;

revoke all on function public.openblog_moderate_report(text, uuid, integer, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_moderate_report(text, uuid, integer, text, text, text, text, text, text, timestamptz) to service_role;
revoke all on function public.openblog_uphold_report(text, uuid, integer, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_uphold_report(text, uuid, integer, integer, text, text, text, timestamptz) to service_role;
revoke all on function public.openblog_purge_comment(text, uuid, integer, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_purge_comment(text, uuid, integer, text, text, timestamptz) to service_role;
revoke all on function public.openblog_purge_report(text, uuid, integer, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_purge_report(text, uuid, integer, text, text, timestamptz) to service_role;

commit;
