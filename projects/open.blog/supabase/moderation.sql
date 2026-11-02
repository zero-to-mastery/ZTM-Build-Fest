-- Optional: the moderation inbox's full schema (ADR 0106). Run once in the
-- Supabase SQL editor, after openblog.sql. If the site takes passage
-- feedback, run feedback.sql again too, which adds what the inbox needs to
-- the feedback tables. Then set OPENBLOG_MODERATION_ENABLED=true in Netlify
-- and redeploy. Until then Admin's inbox still lists comments and feedback,
-- and offers only what the older schema can store.
--
-- Additive only: it adds three columns to openblog_comments, each with a
-- default or nullable, and creates the private comment audit table
-- openblog_comment_events and one moderation function. It does not rename,
-- drop or rewrite any existing table, column, function or row. Public
-- comment reads keep using `status`, which still holds only pending,
-- approved or rejected: every state that is not public is stored there as a
-- value that is not public (removed as rejected, ADR 0102), so readers see
-- exactly what they saw before. Running it twice changes nothing. To undo
-- it, see moderation-rollback.sql.

begin;

-- Every inbox decision names the version it saw and raises it (ADR 0102).
-- Existing comments start at version 1.
alter table public.openblog_comments
  add column if not exists version integer not null default 1 check (version >= 1);
-- The full moderation state (pending, approved, rejected or removed for a
-- comment), kept beside the three-value `status`. Null on a comment no inbox
-- decision has touched: its state is its `status`.
alter table public.openblog_comments
  add column if not exists moderation_state text check (moderation_state ~ '^[a-z][a-z-]{0,31}$');
-- The reason code of the last rejection or removal; never free text.
alter table public.openblog_comments
  add column if not exists moderation_reason text check (moderation_reason ~ '^[a-z][a-z-]{0,31}$');

-- The comment moderation audit trail: who changed which comment, in which
-- role, from which state to which, why (a reason code), when, and the
-- version it produced. Never the comment's text or its author's name. Rows
-- are only ever inserted, except that with engagement protection
-- (protection.sql, ADR 0108) the retention run may delete events older than
-- the site's audit period, and never one recorded in the last day.
create table if not exists public.openblog_comment_events (
  id bigint generated always as identity primary key,
  site_id text not null check (char_length(site_id) between 1 and 200),
  comment_id uuid not null references public.openblog_comments (id),
  action text not null check (action ~ '^[a-z][a-z-]{0,31}$'),
  from_status text not null check (from_status ~ '^[a-z][a-z-]{0,31}$'),
  to_status text not null check (to_status ~ '^[a-z][a-z-]{0,31}$'),
  reason text check (reason ~ '^[a-z][a-z-]{0,31}$'),
  -- An Admin account name, or @moderation-token for the token itself.
  actor text not null check (char_length(actor) between 1 and 80),
  actor_role text not null check (actor_role ~ '^[a-z][a-z-]{0,31}$'),
  at timestamptz not null,
  version integer not null check (version >= 1)
);

create index if not exists openblog_comment_events_item
  on public.openblog_comment_events (site_id, comment_id, at);

alter table public.openblog_comment_events enable row level security;
revoke all on public.openblog_comment_events from public, anon, authenticated, service_role;
grant select, insert on public.openblog_comment_events to service_role;

-- One inbox decision on a comment, with its audit event, in one statement,
-- only while the comment still has the state and version both Admin and the
-- function saw. Which changes are allowed is the code's decision
-- (netlify/lib/participation-moderation.mjs); a comment never waits for
-- clarification and is never withdrawn, so only its four states are
-- written. It returns the changed row, or nothing.
create or replace function public.openblog_moderate_comment(
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
returns setof public.openblog_comments
language sql
set search_path = public
as $$
  with changed as (
    update public.openblog_comments
       set moderation_state = p_to,
           status = case p_to when 'pending' then 'pending' when 'approved' then 'approved' else 'rejected' end,
           moderated_at = p_at,
           moderation_reason = p_reason,
           version = version + 1
     where id = p_id
       and site_id = p_site_id
       -- The full state counts only while `status` still holds its legacy
       -- value: a write made without OPENBLOG_MODERATION_ENABLED changes
       -- `status` alone, and then `status` is the comment's state.
       and (case
              when moderation_state is not null
               and status = case moderation_state
                              when 'pending' then 'pending'
                              when 'clarification' then 'pending'
                              when 'approved' then 'approved'
                              else 'rejected'
                            end
              then moderation_state
              else status
            end) = p_from
       and version = p_expected_version
       and p_to in ('pending', 'approved', 'rejected', 'removed')
    returning *
  ), logged as (
    insert into public.openblog_comment_events
      (site_id, comment_id, action, from_status, to_status, reason, actor, actor_role, at, version)
    select site_id, id, p_action, p_from, p_to, p_reason, p_actor, p_actor_role, p_at, version from changed
  )
  select * from changed;
$$;

revoke all on function public.openblog_moderate_comment(text, uuid, integer, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.openblog_moderate_comment(text, uuid, integer, text, text, text, text, text, text, timestamptz) to service_role;

commit;
