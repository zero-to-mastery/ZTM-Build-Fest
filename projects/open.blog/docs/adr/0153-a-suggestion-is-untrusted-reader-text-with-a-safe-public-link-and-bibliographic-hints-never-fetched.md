# ADR 0153: A suggestion is untrusted reader text with a safe public link and bibliographic hints that are never fetched or verified

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0079](0079-typed-scholarly-feedback-kinds-and-one-submission-format.md), [ADR 0116](0116-evidence-submissions-are-suggested-sources-and-corrections-with-unverified-reader-evidence.md), [ADR 0009](0009-research-source-library-identity.md)

## Context

Editors need actionable ideas, but a suggestion's link, title, creators and identifiers are things
a stranger typed. The Source Library has strict, author-owned records with stable identities
([ADR 0009](0009-research-source-library-identity.md)); a suggestion must never be mistaken for one.

## Decision

- **Five types, a closed set**: `question` (words only), `text`, `video`, `audio` and `source`
  (an archive, dataset, object or account). An unknown type is refused, not guessed. A question
  carries no link or hints (a source is its own suggestion), and every type needs the reader's own
  words (`text`, 1 to 2,000 characters, no control or text-direction characters).
- **The link is optional and public-web only, by the one rule open.blog has for that.** It must
  pass B5's source-link rule (absolute `http` or `https`, no credentials, no whitespace or control
  characters, normalized, at most 2,048 ASCII bytes) and then `citations::public_url_problem`, the
  same rule the publication boundary and the citation review use (a third copy of it was written
  here first and refused addresses the rule allows and allowed others it refuses): no private or
  local name (`localhost`, `localhost.localdomain`, a single-label host, `.local`, `.internal`,
  `.lan`, `.home.arpa`, `.intranet`, `.corp`, `.test`, `.home`, `.localdomain`), no loopback,
  private, link-local, site-local, carrier-grade, benchmarking, multicast or reserved address in any
  way it can be written (decimal, octal, hex, mapped, compatible, 6to4 or NAT64), and no query or
  fragment parameter named like a key, token or signature. Documentation ranges are not refused:
  they are not a private network, nothing fetches the link, and the boundary's decision
  ([ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md)) is
  kept. The browser and the hosted function read the same rule from `web/components/public-url.js`,
  held to the build by `tests/fixtures/public-urls.json`, which the Rust side generates. Nothing in
  open.blog fetches the link.
- **Hints are the reader's statement.** Title, up to 8 creators, a free-text year, publisher and up
  to 4 scheme-qualified identifiers, each bounded and plain text (no control or text-direction
  character, never empty). An identifier's scheme is one of `doi`, `isbn`, `issn`, `url`, `pmid` or
  `pmcid`; its value is plain text of at most 128 characters, checked for shape by the Source
  Library's own offline checks and never against a registry or a remote service. A `url` value goes
  through the one public-address rule above and is stored normalized. None of them is a stable
  source identifier, a citation or a rights statement.
- **Missing metadata is allowed.** A suggestion needs only its words; `missing_metadata` lists
  what an editor still has to find (a link or identifier, a title, a creator) and never blocks one.
- **It may name a series or an article** (`about`: exactly one of `series` slug or `article` page
  path). A series is named by a slug as this site writes them (`slug::slugify`: letters and digits,
  non-ASCII ones too, lowercased, joined by single hyphens, at most 64 characters), so a series
  titled in another script can be named. It is a hint for the editors, not a target the policy
  resolves; the policy's work is the page the form was on. There is no passage target in version 1
  ([ADR 0154](0154-a-suggestion-is-one-feedback-row-with-no-passage-target-and-one-loosened-check.md)).
- **Strict, versioned, deterministic.** Format version 1; unknown fields, a newer version, a wrong
  kind, oversize input (16 KiB) and any broken rule are refused with a code and a message that
  never repeats what the reader wrote. Output is canonical JSON in a fixed field order. A
  submission is at most 12 KiB, and a stored record at most 16 KiB (a hosted row's `details` is held
  to 16 KiB by its own check): the difference leaves room for what the receiver adds (the page, the
  time, the channel, the revision), so a submission at its largest still reads back from storage,
  and one that could not is refused when it is sent, never stored and then unreadable.
- **No remote scraping and no automatic episode creation**, as the issue says. Nothing here
  reads the network or the filesystem.
