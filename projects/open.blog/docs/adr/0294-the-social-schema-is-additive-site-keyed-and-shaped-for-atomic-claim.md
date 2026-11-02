# ADR 0294: The social schema is additive, site-keyed and shaped for atomic claim

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #354 (task #362)

## Context

A hosted schema is a one-way door: once a site runs it, data lives there. The epic corrects a sketch that used
`gen_random_policy_v4()`, plaintext tokens, a client insert with no owner, and a `PUBLISHED` flag with no proof of
delivery. Later stories need to claim due posts atomically, retry without duplicating, and record the provider's
response id. `supabase/workspace.sql`, `feedback.sql` and `protection.sql` set the conventions: server-only
`service_role`, additive and re-runnable, one rollback file.

## Decision

The most conservative reversible design, in `supabase/social.sql` with `supabase/social-rollback.sql`:

- **Additive and re-runnable.** Only `create ... if not exists`, no change to any existing object. The rollback
  drops only the `openblog_social_*` tables and leaves `pgcrypto`. A version table (`openblog_social_schema`, row
  `1`) lets a later migration know what it upgrades. IDs use `gen_random_uuid()`.
- **Private.** Row level security on, no policies, `revoke all` from `public`, `anon`, `authenticated`; `service_role`
  gets `select, insert, update` and never `delete`: cancel and disconnect are updates, attempts are append and
  finish, and foreign keys are `on delete restrict` so history is never cascaded away.
- **Site keyed, not owner keyed.** Every table has `site_id` with the same check as the scope rule (ADR 0293).
  Ownership is a composite foreign key: a post's `(account_id, site_id)` references the account's `(id, site_id)`,
  and an attempt's `(post_id, site_id)` references the post's, so a row cannot point across sites even by mistake.
  The Admin user is only the audit text `connected_by` / `created_by` / `worker`.
- **Accounts** (`openblog_social_accounts`): provider, kind, the provider's id and a display name (none secret),
  status `connected | needs-reauth | disconnected`. A partial unique index allows one live connection per identity.
- **Queue** (`openblog_social_posts`): the canonical `work` and `https` URL, the text (at most 3,000), `scheduled_for`,
  status `scheduled | claimed | published | failed | canceled | unknown`, a `version`, a lease
  (`claimed_by`, `claimed_at`, `lease_expires_at`) that check constraints require exactly while `claimed`, an
  `idempotency_key` unique per site and account, `attempt_count`, `provider_post_id` and `published_at`, which check
  constraints require to appear together and exactly when `published`: nothing is `published` without a provider id.
  Partial indexes serve "due and unclaimed" and "expired lease". `unknown` is a first-class state for an outcome that
  may have reached the provider, so it is reconciled, never blindly retried.
- **Attempts** (`openblog_social_attempts`): `(post_id, attempt_no)` unique, worker, start and finish, outcome
  `published | failed | unknown`, HTTP status, provider request and post ids, a short error code and at most 500
  characters of redacted detail. Never a token, header or response body.
- **Open vocabularies, closed lifecycles.** `provider`, `kind` and error codes are checked for shape only (the
  feedback convention), so a new provider needs no migration. The lifecycle states are enumerated because claiming
  depends on them; widening one is a one-line additive constraint swap.
- **Verified for real.** The statements were run against PostgreSQL twice (idempotent), a cross-site post was
  refused by the foreign key, and the rollback left no `openblog_social_*` table.

## Considered options

- **`auth.users` ownership and RLS policies.** Rejected in ADR 0293.
- **Provider-specific tables.** Rejected: a table per provider multiplies migrations; the shape-checked columns do not.
- **A claim function now.** Deferred: the claim story owns its semantics. This schema only guarantees it is possible
  (version, lease checks, indexes, idempotency).
- **`on delete cascade`.** Rejected: deleting an account must not erase what was sent.

## Consequences

- Rolling back deletes the schedule and delivery history; the rollback file says how to export it first.
- Adding a provider or a lifecycle state is additive.
