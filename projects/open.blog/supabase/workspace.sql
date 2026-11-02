-- Separate from engagement.sql: apply once in the Supabase SQL editor.
-- Only the trusted server's service_role may read/write editorial state.
begin;

create table if not exists public.openblog_workspaces (
    namespace text primary key check (namespace ~ '^[A-Za-z0-9_-]{1,80}$'),
    revision bigint not null default 0 check (revision >= 0),
    manifest jsonb not null default '{}'::jsonb
        check (jsonb_typeof(manifest) = 'object'
               and octet_length(manifest::text) <= 8388608),
    updated_at timestamptz not null default now()
);
alter table public.openblog_workspaces enable row level security;
revoke all on public.openblog_workspaces from public, anon, authenticated;
grant select, insert, update on public.openblog_workspaces to service_role;

create or replace function public.openblog_workspace_read(p_namespace text)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
    select coalesce(
        (select jsonb_build_object('revision', revision, 'manifest', manifest)
         from public.openblog_workspaces where namespace = p_namespace),
        jsonb_build_object('revision', 0, 'manifest', '{}'::jsonb)
    );
$$;

create or replace function public.openblog_workspace_commit(
    p_namespace text, p_revision bigint, p_manifest jsonb
)
returns bigint
language plpgsql security invoker
set search_path = ''
as $$
declare
    next_revision bigint;
begin
    if p_revision < 0 or jsonb_typeof(p_manifest) <> 'object'
       or (select count(*) from jsonb_object_keys(p_manifest)) > 2048 then
        raise exception 'invalid workspace manifest';
    end if;
    insert into public.openblog_workspaces(namespace) values (p_namespace)
        on conflict (namespace) do nothing;
    update public.openblog_workspaces
       set manifest = p_manifest, revision = revision + 1, updated_at = now()
     where namespace = p_namespace and revision = p_revision
     returning revision into next_revision;
    if not found then
        raise exception 'stale workspace revision' using errcode = '40001';
    end if;
    return next_revision;
end;
$$;

revoke all on function public.openblog_workspace_read(text) from public, anon, authenticated;
revoke all on function public.openblog_workspace_commit(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.openblog_workspace_read(text) to service_role;
grant execute on function public.openblog_workspace_commit(text, bigint, jsonb) to service_role;

-- No anon/authenticated object policies are created. Supabase's service role
-- bypasses Storage RLS; keep this credential on the private admin host only.
insert into storage.buckets(id, name, public, file_size_limit)
values ('openblog-workspace', 'openblog-workspace', false, 16777216)
on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit;

-- A restrictive policy also protects this bucket when the project already has
-- broad authenticated Storage policies for unrelated buckets.
drop policy if exists openblog_workspace_service_only on storage.objects;
create policy openblog_workspace_service_only on storage.objects
    as restrictive for all to anon, authenticated
    using (bucket_id <> 'openblog-workspace')
    with check (bucket_id <> 'openblog-workspace');

commit;
