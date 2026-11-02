# ADR 0080: Hosted feedback is stored in one new, private table added by an optional, additive migration

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#81](https://github.com/journey-to-code-org/open.blog/issues/81)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md),
  [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md)
- Contract: [Hosted engagement](../specs/hosted-engagement.md)

## Context

The hosted database schema is a one-way door: deployed sites run the SQL by hand, there is no
migration runner, and a change to a table that holds readers' comments cannot be taken back
without risking their data. The existing `openblog_comments.author_name` is `NOT NULL` and is
published with every approved comment, so feedback, which is anonymous by default and names a
reader only with consent (ADR 0078), cannot reuse it. The roadmap also needs the same storage to
hold RD6 evidence submissions, RD10 Third Perspectives, RD11 section responses, RD12 moderation
states and RD13 future questions without another schema change each time. The most conservative
reversible choice was required.

## Decision

- **Only additions.** `supabase/feedback.sql` creates one new table, `public.openblog_feedback`,
  and two indexes, all with `if not exists`, in one transaction. It alters, renames, drops and
  rewrites nothing that exists: comments, analytics, rate limits and their functions are
  untouched, and existing comments keep working unchanged. `supabase/openblog.sql` is not edited,
  so a site that does not opt in runs no migration at all.
- **The table** (one row per received submission):

  | Column | Type | Rule |
  | --- | --- | --- |
  | `id` | `uuid` | primary key, `gen_random_uuid()` |
  | `site_id` | `text` | not null, 1–200 characters |
  | `format_version` | `integer` | not null, default 1, at least 1 (ADR 0079's `version`) |
  | `kind` | `text` | not null, `^[a-z][a-z0-9-]{0,39}$` |
  | `work` | `text` | 2–500 characters |
  | `revision` | `text` | `^p[1-9][0-9]{0,3}:[0-9a-f]{32}$` |
  | `target` | `jsonb` | an object of at most 16 KiB |
  | `body` | `text` | not null, 1–20,000 characters |
  | `details` | `jsonb` | not null, default `{}`, an object of at most 16 KiB |
  | `seen_at` | `timestamptz` | nullable, never after `received_at` |
  | `received_at` | `timestamptz` | not null, default `now()` |
  | `channel` | `text` | not null, default `hosted`, `hosted` or `manual` |
  | `reader_name` | `text` | nullable, 1–80 characters |
  | `publish_name` | `boolean` | not null, default false; true needs a `reader_name` |
  | `status` | `text` | not null, default `pending`, `^[a-z][a-z-]{0,31}$` |
  | `moderated_at` | `timestamptz` | nullable |

  `work`, `revision` and `target` are all present or all absent; every kind in ADR 0079 has them,
  and a future kind about the site rather than a passage (RD13) may leave all three out.
  Indexes: `(site_id, status, received_at)` for the moderation queue and
  `(site_id, work, status, received_at)` for one post.
- **The reader's name lives in its own nullable column**, private unless `publish_name` is true,
  and is never copied into `openblog_comments.author_name`. No address, e-mail, device, account
  or IP-derived value is stored; the rate limiter keeps only its existing salted, hourly hashes.
- **Shape in the database, values in the code.** `kind` and `status` are checked for shape only;
  the allowed values belong to ADR 0079 and the participation policy (#211), so a new kind or a
  `clarification` or `removed` state needs no migration. The function writes only `pending`,
  `approved` and `rejected` today. The database bounds (body 20,000 characters, JSON 16 KiB) are
  looser than the function's (4,000 characters), so a longer future kind fits without a change.
- **Private by default.** Row level security is enabled with no policies, `public`, `anon` and
  `authenticated` have no rights, and only `service_role` (the Netlify Function) may `select`,
  `insert` and `update`. No `delete` is granted until a retention policy (#211) needs it.
- **Later needs stay additive.** A parent item for author responses (#83), an evidence role
  (RD6), contact details for RD13 (private, in a separate restricted table) or audit events
  (#211) are new nullable columns or new tables.
- **Rollback.** First unset `OPENBLOG_FEEDBACK_ENABLED` and redeploy, which stops all reads and
  writes at once (ADR 0081). The table can then stay, unused, at no cost. To remove it, export the
  rows if wanted and run `supabase/feedback-rollback.sql`, which drops only
  `public.openblog_feedback` (and with it its indexes and rows) and nothing else. The deploy guide
  and the function guide give the same steps.

## Consequences

- Deployed sites that never opt in are byte-for-byte unaffected, and those that do can leave at
  any time without touching comments.
- Integrity rules on kinds and states live in code and in the shared fixtures rather than in
  the database; the database still refuses malformed ids, broken provenance combinations and a
  published name without a name.
- A test reads the migration and checks that it is additive, private and matches the columns the
  function writes and reads, and that the rollback drops only this table.
