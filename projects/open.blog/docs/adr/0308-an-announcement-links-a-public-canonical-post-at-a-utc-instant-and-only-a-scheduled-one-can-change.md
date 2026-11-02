# ADR 0308: An announcement links a public canonical post at a UTC instant, and only a scheduled one can change

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#353](https://github.com/journey-to-code-org/open.blog/issues/353)
- Story: #356 (task #367)

## Context

A scheduled social post (ADR 0294) is a row with a caption, a time, a link and a status. Before anything can
write one, the rules for what makes it valid have to live in one place that both the Rust Admin, which knows the
posts, and the hosted function, which owns the database, can hold to. The epic asks that an announcement be
possible only after the canonical article is public, and edited or canceled only before a worker claims it.

## Decision

- **One model, two implementations, one fixture.** `openblog_core::social_schedule` and
  `netlify/lib/social-schedule.mjs` accept and refuse the same values, held to `tests/fixtures/social-schedule.json`
  exactly as the identity rules are (ADR 0293). The Rust Admin applies them first; the hosted function applies them
  again before a row is written, so the database never depends on a caller's good manners.
- **Only a public post is announced, at its own address.** The post must not be a draft, must not be dated after
  now, and the site needs a public `https` address (a real host: no `http`, no bare name, no address literal, no
  `localhost`, `.local` or `.internal`; no credentials, query or fragment). The link is the site's own address for
  the post. A post that names a canonical address on another site (a cross-post) is refused, because it belongs
  where it was first published. The stored link must end in the stored `work` path, so a link can never point
  somewhere the post does not live.
- **The caption is bounded per provider, in characters.** Provider names are an explicit list (`linkedin`,
  `facebook`); anything else fails with `unsupported-provider`. The caption is trimmed, line endings are
  normalized to `\n`, and control characters (other than a newline), line and paragraph separators, byte-order marks
  and bidirectional overrides are refused, so what the author previews is what is posted. The limit counts Unicode
  characters (not UTF-16 units) and is 3,000 for both providers: LinkedIn's own limit, and the schema's `body`
  bound, which is lower than Facebook's. The link is attached by the delivery adapter, so it does not count against
  the caption. Provider limits are code, not a table in the database, and a limit change is a one-line release.
- **Time is a UTC instant that names its zone.** A schedule must be a full RFC 3339 date and time with `Z` or an
  offset; a bare date or a time with no zone is refused with `time-needs-zone`, so no time is ever read in the
  server's zone by accident. It must be at least a minute ahead and no more than a year and a day. It is stored and
  sent as UTC to the second (`2026-11-02T07:30:00Z`). The author's time zone (an IANA name, checked for shape only
  because the engine carries no zone database) says how the time was chosen and is for display; **it is not stored**,
  because the schema has no column for it and a hosted schema is a one-way door. The Admin shows times in the
  viewer's own zone.
- **Idempotency key per submission.** A key is 16 to 128 of `A-Z a-z 0-9 _ -`. A client makes one per composed
  announcement and re-sends the same one on a retry, which the unique `(site, account, key)` index turns into the
  same row instead of a second post.
- **Status transitions are one table.** `scheduled -> claimed | canceled`; `claimed -> published | failed |
  unknown | scheduled` (a lease that expired); `failed -> scheduled` (a retry); `unknown -> published | failed`
  (reconciliation). Nothing leaves `published` or `canceled`. Only a `scheduled` announcement, which no worker
  holds, can have its caption or time changed or be canceled by an author; the author's only status change is
  `scheduled -> canceled`. The worker stories use the same table.

## Considered options

- **Store the author's time zone.** Rejected for now: it needs a new column; reversible later by an additive
  migration if recurring or "same wall time" schedules are wanted.
- **Let a cross-posted article be announced with its canonical address.** Rejected: the author would be promoting
  another site from this one, which is a decision the epic does not make for them. Reversible by relaxing one check.
- **A separate Facebook limit of 63,206.** Rejected: the stored caption cannot exceed the schema's bound anyway.

## Consequences

- The Admin explains every refusal with a fixed, code-tagged message; none repeats the refused value.
- A reschedule is a change of the same row (same key), so it can never duplicate a post.
- Later stories reuse `can_become` for claim, delivery and reconciliation rather than inventing their own states.
