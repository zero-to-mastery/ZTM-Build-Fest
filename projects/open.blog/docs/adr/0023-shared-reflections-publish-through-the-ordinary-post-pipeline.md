# ADR 0023: Shared reflections publish through the ordinary Post pipeline

- Status: Accepted. The participant-order rule below is amended for structured reflections by
  [ADR 0030](0030-one-deterministic-reading-order.md) (Amended by 0030).
- Date: 2026-10-25
- Decision issue: [#169](https://github.com/journey-to-code-org/open.blog/issues/169)
- Parent story: [#147](https://github.com/journey-to-code-org/open.blog/issues/147)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)

## Context

[ADR 0022](0022-gate-schedule-and-publication-on-exact-approvals.md) makes the publish gate write one
Post and a credit sidecar, with the source attribution of [ADR 0008](0008-public-source-attribution.md)
as plain front matter. The native page, portable projection ([ADR 0004](0004-portable-projections-from-canonical-work.md)),
RSS and JSON Feed all read a Post. The question for #169 was whether a shared reflection needs its own
projections. It would also need its own authorization, its own escaping and its own leak surface.

## Decision

- A shared reflection has no projection of its own. Every output is derived from the Post the gate
  wrote, by the code every other Post uses. There is no new route and no new reader of private
  state, so the one author set of [ADR 0018](0018-reveal-policy-readiness-and-comparison.md) and
  `SharedPublication::authorize` stay the only way in. Publishing remains behind
  [ADR 0014](0014-record-level-authorization-and-publish-gate.md)'s gate.
- Section order is participant order (amended by 0030: when a reflection structure exists, section
  order follows its reading order) and credit order is the same order, so RSS `dc:creator` and
  JSON Feed `authors` list the same people in the same sequence as the sections. An author who wrote
  nothing has no section and no credit in any output. Under the plain-text fallback the sections
  stay in that order and the source is still a link. Summary-only feeds (`feeds.fullContent: false`)
  carry only the ordinary excerpt and the credited authors, as for any Post: no guiding question,
  source title or source link, because those live in the body. A reader follows the canonical link
  to the full piece.
- The title comes from a participant, not the site owner, so portable Markdown escapes it like the
  other untrusted shared values (`<` and `&` as well), and it can never become raw HTML.
- A shared conclusion is a section like any other, written by an author and approved with the rest.
  Nothing is dropped or summarised between approval and output.
- The guarantee is tested, not assumed. `shared_publication_output.rs` assembles a three-author
  piece and checks the page, portable HTML, Markdown and text, RSS, well-formed RSS and JSON Feed (both parsed or checked), `llms` files,
  sitemap and search index for section order, author order, canonical link equality, and absence of
  private values: a replaced draft revision, account names, the publication id, invitation, approval
  and reveal wording. The Admin publish test checks the rebuilt `rss.xml`, `feed.json` and page.
- Failure leaves content and output unchanged because publication is the one transactional operation
  of ADR 0022; this decision adds no write.

## Consequences

- Changing how Posts are rendered or exported changes shared reflections with them, and the same
  fixtures catch a regression.
- Destination-specific syndication and alternate layouts remain out of scope.
