# ADR 0157: Converting a suggestion is an explicit author action that records an id and never enters the Source Library by itself

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0009](0009-research-source-library-identity.md), [ADR 0010](0010-private-source-library-storage.md), [ADR 0103](0103-who-may-moderate-reader-participation.md)

## Context

An accepted suggestion may become a draft, a series or a Source Library record. The library is
private author research with stable identities and per-version rights; untrusted reader hints
must not flow into it, or into any public output, without an author deciding to.

## Decision

- **Nothing converts automatically.** This module neither reads nor writes the Source Library or
  any publication projection (a test fails the build if its source names them); it may only borrow
  the library's offline identifier-shape check.
- **A link is a record of an author's act.** `convert` is allowed only for the site Admin or a
  coordinator of the work (the policy's approve grant), on a suggestion approved at its current
  revision, not waiting for clarification and still kept. It returns `Conversion {kind, id, at,
  by}`: `draft`, `series` or `library-source`, the slug of what the author made (a draft's or a
  series' as this site writes slugs, non-ASCII letters included; a library source's is the library's
  lowercase ASCII source id), when, and which Admin account recorded it. It creates nothing and sends nothing. A target is linked at
  most once and a suggestion keeps at most 8 links.
- **A link holds nothing of the reader**: no name, contact, text or hint, so a link can be shown to
  anyone who may see the editors' queue without leaking identity.
- **A library candidate is hints, not facts.** `library_candidate` gives the same actors, on the
  same accepted suggestions, the link, type and bibliographic hints, marked `unverified`, for the
  author to copy into a record of their own making. It never includes the reader's words, name or
  contact, and rights stay the author's per-version declaration
  ([ADR 0085](0085-rights-are-the-authors-declaration-per-version.md)), never inferred from a
  suggestion. A question has no candidate.
- **Storage and screens are RD13.3's** ([#228](https://github.com/journey-to-code-org/open.blog/issues/228)),
  decided in [ADR 0162](0162-a-link-to-future-work-is-kept-in-the-suggestions-details-with-an-audit-event-and-needs-no-new-schema.md)
  to [ADR 0164](0164-a-link-to-a-source-is-the-authors-record-of-a-library-record-they-made-and-the-hints-are-copied-by-hand.md):
  the links are kept in the row's `details`, recorded from the inbox through these functions, and
  no one is widened beyond who could call them.
- **Copying into the private research notebook is the one export, and it is explicit**
  ([ADR 0160](0160-editors-read-suggestions-in-the-one-inbox-and-copying-one-into-a-research-note-is-an-explicit-unverified-export.md)).
  It is a sibling of the library candidate, not a conversion: it records no link.
