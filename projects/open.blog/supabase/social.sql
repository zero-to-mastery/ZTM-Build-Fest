-- Optional scheduled social publishing (ADRs 0293 and 0294): connected
-- accounts, the schedule queue and the delivery attempt history. Run once in
-- the Supabase SQL editor, only if the site opts in. A site that does not opt
-- in never needs it; builds, exports and cross-posting do not read it. Then
-- set OPENBLOG_SOCIAL_ENABLED=true and the other OPENBLOG_SOCIAL_* settings
-- (docs/social-publishing.md) and redeploy. Until then nothing here is used.
--
-- Additive only: it creates the schema version table, the account table, the
-- queue table, the attempt table and the credential table with their indexes. It does not rename,
-- drop or rewrite anything that exists, and running it twice changes nothing.
-- To undo it, see social-rollback.sql.
--
-- Private by construction (ADR 0293): row level security is on with no
-- policies, the public roles have no access at all, and only the hosted
-- function, signed in as service_role, reads and writes. There is no
-- auth.users reference and nothing a browser can reach. Every row carries the
-- site (OPENBLOG_SITE_ID) and every relation includes it, so a row can never
-- point at another site's account or post.
--
-- The queue is designed for later stories to claim work atomically: a
-- `version` that every change raises, a lease (`claimed_by`, `lease_expires_at`)
-- that exists only together with a claim, a per-account idempotency key, an
-- attempt counter, and the provider's own response id kept on the post and on
-- the attempt that obtained it. Values of `provider`, `kind` and `error_code`
-- are checked for shape only, so a new provider needs no migration; the
-- account, queue and attempt states are listed because claiming depends on them.

begin;

create extension if not exists pgcrypto;

-- Schema version, so a later migration can tell what it is upgrading.
create table if not exists public.openblog_social_schema (
  version integer primary key check (version >= 1),
  applied_at timestamptz not null default now()
);
insert into public.openblog_social_schema (version) values (1) on conflict do nothing;

-- A connected LinkedIn identity or Facebook Page. Disconnecting keeps the row
-- (status 'disconnected') so history stays explainable.
create table if not exists public.openblog_social_accounts (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- What the account is on that provider, such as a member or a page.
  kind text not null check (kind ~ '^[a-z][a-z0-9-]{0,39}$'),
  -- The provider's own id for it (a URN or page id). Not a secret.
  external_id text not null check (char_length(external_id) between 1 and 200),
  display_name text not null check (char_length(display_name) between 1 and 200),
  status text not null default 'connected'
    check (status in ('connected', 'needs-reauth', 'disconnected')),
  -- The Admin user who connected it (a social actor, ADR 0293).
  connected_by text not null check (connected_by ~ '^[a-z0-9_.-]{1,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  constraint openblog_social_accounts_disconnect_stamp
    check ((status = 'disconnected') = (disconnected_at is not null)),
  -- The target of every composite foreign key below.
  constraint openblog_social_accounts_id_site unique (id, site_id)
);
-- One live connection per provider identity per site. A disconnected row does
-- not block connecting the same identity again.
create unique index if not exists openblog_social_accounts_live
  on public.openblog_social_accounts (site_id, provider, external_id)
  where status <> 'disconnected';
create index if not exists openblog_social_accounts_site
  on public.openblog_social_accounts (site_id, status, created_at);

-- One scheduled announcement of one canonical post to one account.
create table if not exists public.openblog_social_posts (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  account_id uuid not null,
  -- The canonical post this announces, and its public address at scheduling.
  work text not null check (char_length(work) between 2 and 500),
  canonical_url text not null
    check (canonical_url ~ '^https://' and char_length(canonical_url) <= 2000),
  body text not null check (char_length(body) between 1 and 3000),
  scheduled_for timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'claimed', 'published', 'failed', 'canceled', 'unknown')),
  -- Every change names the version it expects and raises it, so two writers
  -- can never both act on one post (the moderation pattern, ADR 0083).
  version integer not null default 1 check (version >= 1),
  -- Sent to the provider, or kept next to the request, so a retry of an
  -- unknown outcome can be recognized instead of posting twice.
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- The lease: set only while claimed, so a crashed worker's claim expires.
  claimed_by text check (claimed_by ~ '^(@worker|[a-z0-9_.-]{1,32})$'),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  -- The provider's id for the published post, kept the moment it is known.
  provider_post_id text check (char_length(provider_post_id) between 1 and 300),
  published_at timestamptz,
  last_error_code text check (last_error_code ~ '^[a-z][a-z0-9-]{0,39}$'),
  created_by text not null check (created_by ~ '^[a-z0-9_.-]{1,32}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canceled_at timestamptz,
  -- An account of this site; restrict, so history is never cascaded away.
  constraint openblog_social_posts_account
    foreign key (account_id, site_id)
    references public.openblog_social_accounts (id, site_id) on delete restrict,
  constraint openblog_social_posts_lease_whole check (
    (status = 'claimed') = (claimed_by is not null and claimed_at is not null and lease_expires_at is not null)
  ),
  constraint openblog_social_posts_published_whole check (
    (status = 'published') = (published_at is not null and provider_post_id is not null)
  ),
  constraint openblog_social_posts_canceled_stamp check ((status = 'canceled') = (canceled_at is not null)),
  constraint openblog_social_posts_id_site unique (id, site_id),
  -- The same announcement cannot be queued twice for one account.
  constraint openblog_social_posts_idempotency unique (site_id, account_id, idempotency_key)
);
-- The claim query: due, unclaimed work in time order; and expired leases.
create index if not exists openblog_social_posts_due
  on public.openblog_social_posts (site_id, scheduled_for)
  where status = 'scheduled';
create index if not exists openblog_social_posts_leases
  on public.openblog_social_posts (site_id, lease_expires_at)
  where status = 'claimed';
create index if not exists openblog_social_posts_account
  on public.openblog_social_posts (account_id, status);
create index if not exists openblog_social_posts_work
  on public.openblog_social_posts (site_id, work, scheduled_for);
-- A provider's response id is unique per account when present.
create unique index if not exists openblog_social_posts_provider_post
  on public.openblog_social_posts (site_id, account_id, provider_post_id)
  where provider_post_id is not null;

-- One try to deliver a post. Rows are only added and finished, never deleted,
-- so the history of what was sent stays whole.
create table if not exists public.openblog_social_attempts (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  post_id uuid not null,
  attempt_no integer not null check (attempt_no >= 1),
  worker text not null check (worker ~ '^(@worker|[a-z0-9_.-]{1,32})$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- 'unknown' means the request may have reached the provider; it is never
  -- retried blindly (the epic's no-duplicate rule).
  outcome text check (outcome in ('published', 'failed', 'unknown')),
  http_status integer check (http_status between 100 and 599),
  provider_request_id text check (char_length(provider_request_id) between 1 and 300),
  provider_post_id text check (char_length(provider_post_id) between 1 and 300),
  -- A short code and a redacted message; never a token, header or body.
  error_code text check (error_code ~ '^[a-z][a-z0-9-]{0,39}$'),
  error_detail text check (char_length(error_detail) <= 500),
  constraint openblog_social_attempts_post
    foreign key (post_id, site_id)
    references public.openblog_social_posts (id, site_id) on delete restrict,
  constraint openblog_social_attempts_finished_whole check ((outcome is null) = (finished_at is null)),
  constraint openblog_social_attempts_order unique (post_id, attempt_no)
);
create index if not exists openblog_social_attempts_post
  on public.openblog_social_attempts (post_id, started_at);
create index if not exists openblog_social_attempts_site
  on public.openblog_social_attempts (site_id, started_at);

-- Provider credentials (ADR 0295). Only AES-256-GCM ciphertext: the envelope
-- holds the encrypted tokens and their wrapped data key, and the key that
-- unwraps it (OPENBLOG_SOCIAL_TOKEN_KEYS) is never in this database. Expiry,
-- scopes and status are plain so a refresh can be planned without decrypting.
-- Revoking erases the envelope and keeps the row.
create table if not exists public.openblog_social_credentials (
  account_id uuid primary key,
  site_id text not null check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  key_id text check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  envelope jsonb check (jsonb_typeof(envelope) = 'object' and octet_length(envelope::text) <= 16384),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes text check (char_length(scopes) <= 1000),
  -- Every change names the version it expects and raises it, so a refresh
  -- and a revoke can never both win.
  version integer not null default 1 check (version >= 1),
  -- Single-flight refresh: one caller holds this until the time passes.
  refresh_lease_until timestamptz,
  refresh_failures integer not null default 0 check (refresh_failures >= 0),
  last_refreshed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint openblog_social_credentials_account
    foreign key (account_id, site_id)
    references public.openblog_social_accounts (id, site_id) on delete restrict,
  -- Tokens exist exactly while the credential is active.
  constraint openblog_social_credentials_erased check (
    (status = 'revoked') = (envelope is null and key_id is null and revoked_at is not null)
  )
);

-- A connection in progress or just finished (ADR 0299): the OAuth handshake of
-- one author connecting one provider. `state_hash` is the SHA-256 of the
-- single-use `state` value (the value itself is never stored); `envelope`
-- holds the PKCE verifier while the handshake is pending and the provider's
-- tokens once it is authorized, encrypted like a credential (ADR 0295).
-- `destinations` lists the member, organizations or Pages the grant can reach
-- and why each is or is not usable; it holds no token. A finished or failed
-- row keeps no envelope. Nothing is deleted: rows only change state.
create table if not exists public.openblog_social_connections (
  id uuid primary key default gen_random_uuid(),
  site_id text not null check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  status text not null default 'pending'
    check (status in ('pending', 'exchanging', 'authorized', 'completed', 'failed', 'expired', 'canceled')),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri text not null check (redirect_uri ~ '^https://' and char_length(redirect_uri) <= 500),
  requested_scopes text not null check (char_length(requested_scopes) <= 1000),
  granted_scopes text check (char_length(granted_scopes) <= 1000),
  pkce boolean not null default false,
  -- Set when the author is reconnecting an existing account.
  reauth_account_id uuid,
  created_by text not null check (created_by ~ '^[a-z0-9_.-]{1,32}$'),
  expires_at timestamptz not null,
  key_id text check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  envelope jsonb check (jsonb_typeof(envelope) = 'object' and octet_length(envelope::text) <= 32768),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  destinations jsonb check (jsonb_typeof(destinations) = 'array' and octet_length(destinations::text) <= 65536),
  -- Fixed note codes about what the provider could not confirm (ADR 0300).
  notes text check (char_length(notes) <= 500),
  error_code text check (error_code ~ '^[a-z][a-z0-9-]{0,39}$'),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint openblog_social_connections_state unique (state_hash),
  constraint openblog_social_connections_reauth
    foreign key (reauth_account_id, site_id)
    references public.openblog_social_accounts (id, site_id) on delete restrict,
  constraint openblog_social_connections_sealed check ((envelope is null) = (key_id is null)),
  -- Tokens never outlive the handshake: only a pending (verifier), exchanging
  -- or authorized row may hold an envelope.
  constraint openblog_social_connections_erased check (
    envelope is null or status in ('pending', 'exchanging', 'authorized')
  )
);
create index if not exists openblog_social_connections_site
  on public.openblog_social_connections (site_id, status, expires_at);

alter table public.openblog_social_schema enable row level security;
alter table public.openblog_social_accounts enable row level security;
alter table public.openblog_social_posts enable row level security;
alter table public.openblog_social_attempts enable row level security;
alter table public.openblog_social_credentials enable row level security;
alter table public.openblog_social_connections enable row level security;

revoke all on public.openblog_social_schema from public, anon, authenticated;
revoke all on public.openblog_social_accounts from public, anon, authenticated;
revoke all on public.openblog_social_posts from public, anon, authenticated;
revoke all on public.openblog_social_attempts from public, anon, authenticated;
revoke all on public.openblog_social_credentials from public, anon, authenticated;
revoke all on public.openblog_social_connections from public, anon, authenticated;

-- Least privilege for the hosted function. It never deletes: cancel and
-- disconnect are updates, and attempts are append-and-finish.
grant select on public.openblog_social_schema to service_role;
grant select, insert, update on public.openblog_social_accounts to service_role;
grant select, insert, update on public.openblog_social_posts to service_role;
grant select, insert, update on public.openblog_social_attempts to service_role;
grant select, insert, update on public.openblog_social_credentials to service_role;

commit;
grant select, insert, update on public.openblog_social_connections to service_role;
