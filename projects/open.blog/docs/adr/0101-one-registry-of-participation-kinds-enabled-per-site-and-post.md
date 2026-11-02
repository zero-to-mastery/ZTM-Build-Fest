# ADR 0101: One closed registry of participation kinds, each off until the site and the post turn it on

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#211](https://github.com/journey-to-code-org/open.blog/issues/211)
- Parent story: [#203](https://github.com/journey-to-code-org/open.blog/issues/203)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [Hosted engagement](../specs/hosted-engagement.md)
- Coordinates with: B5 passage feedback
  ([ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md) to
  [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md),
  #81),
  [#210](https://github.com/journey-to-code-org/open.blog/issues/210) and
  [#221](https://github.com/journey-to-code-org/open.blog/issues/221) (RD10 Third Perspectives),
  [#83](https://github.com/journey-to-code-org/open.blog/issues/83) (author responses),
  [#213](https://github.com/journey-to-code-org/open.blog/issues/213) (RD13 suggestions),
  [#225](https://github.com/journey-to-code-org/open.blog/issues/225) (moderation inbox),
  [#226](https://github.com/journey-to-code-org/open.blog/issues/226) (abuse and retention)

## Context

The site already has one kind of reader participation: hosted comments, switched on by
`engagement.enabled`, `engagement.comments` and an endpoint, with each post's `comments:` front
matter choosing `open`, `locked` or `hidden`. B5 adds four typed feedback kinds and, until this
decision, lets them follow each post's `comments:` setting behind one more switch
(`engagement.feedback`, [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md)). RD10 adds Third Perspectives, #83 author responses and #226
abuse reports. The roadmap (#92) says all of them go through one policy seam with no second
comment system, and the backlog asks that everything new start switched off. Existing sites must
build exactly as before.

## Decision

- **One closed registry.** `openblog_core::participation::ParticipationKind` lists every kind, with
  a stored id (lowercase letters, digits and hyphens, at most 40 characters, the shape the `kind`
  column of [ADR 0080](0080-hosted-feedback-is-one-additive-private-table.md) accepts) and fixed
  rules:

  | Id | From | Target | Public when approved | May ask to clarify | Per post |
  | --- | --- | --- | --- | --- | --- |
  | `comment` | reader | the work | yes | no | `comments:` |
  | `question` | reader | a passage | yes | yes | yes |
  | `source-suggestion` | reader | a passage | yes | yes | yes |
  | `correction-suggestion` | reader | a passage | yes | yes | yes |
  | `alternative-interpretation` | reader | a passage | yes | yes | yes |
  | `third-perspective` | reader | the work or a section | yes | yes | yes |
  | `author-response` | an author of the work | an approved item | yes | no | yes |
  | `abuse-report` | reader | an approved item | never | no | no (site-wide) |

  An id this version does not know is refused, never guessed. A new kind (RD11 section responses,
  RD13 future questions and sources) is a new variant with its own row and starts `off`, so no
  existing site changes and, because storage checks only the id's shape, no migration is needed.
- **Modes are the comment modes, for every kind.** `ParticipationMode` is `hidden` (nothing shown
  or accepted), `locked` (approved items shown, nothing accepted) or `open` (approved items shown,
  new items accepted pending moderation).
- **Site settings** live in `openblog.json` under `participation.kinds`, keyed by kind id:
  `off` (the default for every kind: the kind does not exist on the site and no front matter can
  enable it), `hidden`, `locked` or `open` (enabled, and the mode of posts that do not name the
  kind), or `follow-comments` (each post's mode is its `comments:` setting). `abuse-report`
  accepts only `off` or `open`. `comment` is refused here. Unknown kinds, values and fields are
  refused at load. The whole `participation` object is omitted when written while it has its
  defaults, so existing configuration files are unchanged.
- **Post settings** live in front matter as `kind: mode` entries:

  ```yaml
  participation:
    - question: open
    - third-perspective: locked
  ```

  or `participation: [question: open, third-perspective: locked]`. A post may name any kind whose
  rules allow it; `comment` (use `comments:`), `abuse-report`, unknown kinds or modes and a kind
  named twice are build errors. A kind the site has switched `off` may be named and has no effect,
  so turning a kind off site-wide never breaks a build.
- **One resolver.** `participation::effective_mode(config, post, kind)` is the only answer pages,
  manifests and portable output use:
  1. Without a hosted transport (engagement disabled or no endpoint) every kind is `hidden`.
  2. `comment` is `hidden` when `engagement.comments` is off and otherwise the post's `comments:`
     setting: exactly the rule pages used before, now one row of the policy. Comment pages, the
     `openblog-comments.json` manifest and portable output call the resolver.
  3. Any other kind is `hidden` when its site setting is `off`; otherwise the post's own mode if it
     names the kind, else the site default (`follow-comments` reading the post's `comments:`).
- **A published manifest, only once something new is on.** When the site has a transport and at
  least one kind beyond comments is not `off`, the build writes `openblog-participation.json`,
  mapping each post path to the kinds that are not hidden and their modes; a missing kind or post
  means hidden. It holds only public post paths and modes. Otherwise the build output is byte for
  byte what it was.

### How B5's interim rule maps onto the registry

B5's four kinds use the same ids here. Its interim rule, "feedback follows each post's `comments:`
setting, whatever `engagement.comments` says, when `engagement.feedback` is on", is the
`follow-comments` site setting. With B5 merged into this policy:

- **The fold happens at config load.** When `SiteConfig` loads (where it already validates and
  normalizes `engagement`), the merge folds `engagement.feedback: true` into
  `participation.kinds` as `follow-comments` for each of the four kinds that `participation.kinds`
  does not name; `false` (its default) adds nothing, so they stay `off`. Naming a kind in
  `participation.kinds` takes precedence. Because the fold runs before anything reads the policy,
  `any_enabled`, `effective_mode` and the manifest all see the folded settings, so a site that
  opted in to B5 sees no change and publishes `openblog-participation.json`. The folded entries
  are derived, not the owner's: writing the configuration back keeps `engagement.feedback` as the
  owner set it and does not add them to `participation.kinds`.
- **B5's form gate and offered kinds come from the resolver.** Whether a post shows B5's passage
  feedback form
  ([ADR 0082](0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md)),
  and which kinds it offers, are read from `effective_mode(config, post, kind)` for each of the
  four kinds, never from `engagement.feedback` or `comments:` directly: the form is shown when at
  least one kind is `open`, it offers exactly the kinds that are `open` (named in the element's
  `kinds` attribute only when it offers some of the four, so a page offering all four is
  unchanged), a `locked` kind shows its approved items but is not offered, and a `hidden` kind
  does neither. Each published note in `reader-feedback.json` is shown only where its own kind
  shows approved items, read by `participation::published_mode`: the kind's site and post mode as
  the resolver's steps 2 and 3 give it, without step 1, with `open` counting as `locked` while
  there is no transport. So switching a kind `off`, or `hidden` site-wide or on a post, takes its
  notes off those pages until it is switched back on (the file keeps them), while a site that
  turns hosted engagement off, or leaves its hosted service, keeps showing every note it
  published, as ADR 0083 and static reading require. The hosted function applies the same
  per-kind modes from the manifest.
- **`engagement.feedbackContact` stays under `engagement`.** It is a transport setting, not a kind
  setting, so it is not moved into `participation`. It is where the copy-and-send fallback points
  (a `mailto:` address or an HTTPS page) for every reader kind, not only B5's four: Third
  Perspectives, abuse reports and any later reader kind use the same contact.
- B5's `openblog-feedback.json` (path to mode) is the per-kind column of this manifest; the hosted
  function reads the kind's mode from `openblog-participation.json` instead, with a missing entry
  meaning hidden, as B5 already treats a missing manifest. For a function deployed before this
  change, builds keep writing `openblog-feedback.json` while one of the four kinds is on, now
  derived from the policy: each post's most restrictive mode of the four, so an older function
  never accepts a kind the policy keeps hidden or locked (a site that only sets
  `engagement.feedback` gets B5's file byte for byte). The current function reads it only when
  the site publishes no `openblog-participation.json`, a site built before the policy, and only
  for B5's four kinds: every other kind, abuse reports among them, is hidden on such a site. A
  participation manifest it cannot read is "hidden", never a reason to read the older file.
- B5's `FeedbackKind` stays the registry of its submission format
  ([ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md)); every
  `FeedbackKind` id must be a `ParticipationKind` id, and the merge adds a test that asserts it.

## Considered options

- **Per-kind boolean switches beside `engagement.comments`.** Rejected: a second shape for every
  kind, and no way to say "enabled, but only on the posts that ask".
- **Let a post enable a kind the site has off.** Rejected: a single front-matter line would open
  hosted submissions the owner never chose, which is not a conservative default.
- **Move comments into `participation.kinds`.** Rejected: two settings for one thing, and existing
  `engagement.comments` and `comments:` must keep their meaning.

## Consequences

- Owners turn on one kind at a time, site-wide by default or post by post, and nothing new is
  accepted anywhere until they do.
- Third Perspectives (#221), author responses (#83), passage feedback (B5) and abuse reports (#226)
  plug into the same resolver and manifest; the hosted function adopting the manifest is part of
  those tasks.
- Moderation of what each kind receives is one state machine (ADR 0102), with one role model
  (ADR 0103) and one retention and audit policy (ADR 0104).
