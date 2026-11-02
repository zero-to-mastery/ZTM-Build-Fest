# ADR 0172: An article links a term to an atlas entry only where the author writes an `atlas:` link, and only if the entry is published

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#73](https://github.com/journey-to-code-org/open.blog/issues/73)
- Parent story: [#27](https://github.com/journey-to-code-org/open.blog/issues/27)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0122](0122-the-draft-side-research-panel-inserts-only-checked-and-published-research.md),
  [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md),
  [ADR 0168](0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
  [ADR 0171](0171-the-query-file-carries-the-pages-wording-and-a-works-source-and-its-lookup-is-one-shared-algorithm.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#concept-links-in-articles)

## Context

A reader should be able to move from a word in an article (a person, a work, a concept) to the
author's approved explanation of it. Authors already could write `[Plato](/atlas/plato/)`, but the
address is a path the build does not check: an entry that is private, withdrawn or mistyped leaves a
link to a page that does not exist, and the Admin review can only say so afterwards (ADR 0122). #73
asks for authoring support and renderer anchors with no automatic recognition: the author chooses
every link, prose is preserved, a link to something unpublished is a diagnostic and safe plain text
rather than a broken or leaking link, and nothing changes for a site or post that does not use it.

## Decision

- **The author's syntax is an ordinary Markdown link to `atlas:<entry id>`**, for example
  `the [allegory of the cave](atlas:allegory-of-the-cave)`. In any editor, preview or exported copy
  that does not know it, the words read as the author wrote them, and the destination is a short id.
  The id is the atlas entry's own id (a lowercase slug of at most 64 bytes). Every form of
  Markdown link works (inline, and reference in its full, collapsed and shortcut forms; an autolink has no
  label and is refused, see ADR 0173); a code span or block is not a link. Nothing else
  is a concept link: prose is never scanned, a label is never matched to an entry, and a term the
  author does not link stays text however often it repeats. The author links the occurrences they
  choose.
- **It is opt-in by its own syntax.** A post without an `atlas:` link renders byte for byte as it did
  (a test pins it, with and without an atlas). Pages, series and the home introduction do not read
  the syntax: only posts do.
- **Resolved at build time against the public atlas alone.** The Markdown renderer marks each concept
  link with an inert element; `Site::link_concepts` replaces each mark once the atlas projection is
  attached, using `PublicAtlas::entry` and nothing else, so a link can only ever reach an entry the
  atlas already publishes (ADR 0168). The Admin preview, `build`, `check` and `serve` attach the
  atlas in one place (`boundary::project_with`), which also resolves the links. A published entry
  becomes `<a class="ob-concept" href="/atlas/<id>/" data-atlas-entry data-atlas-kind>label</a>`, an
  ordinary link that works without JavaScript and that the context previews (#74) can enhance by
  those attributes; the label is the author's own words, unchanged. Base paths apply as to any link.
- **An unavailable entry is plain text and a scoped diagnostic, never a link.** An id that is not
  well-formed, that names no published entry (unknown, not approved or withdrawn: the public atlas
  cannot tell which and neither does the page), or any concept link while the site does not publish
  its atlas, becomes the label as plain text. The build, `check` and Admin print one warning per post
  and id: ``posts/x.md: concept link `atlas:id` is shown as plain text: <reason>``, with a count when
  it is linked more than once. It names the file and the id the author wrote and never an entry's
  label or private text. The page never says an unpublished entry exists. A post nobody resolved
  (loaded and rendered without the atlas) already holds each concept link as its label, so no output
  can carry a link that leads nowhere.
- **Failures are scoped and change nothing stored.** One bad link affects its own label only; the
  post, the other links, the atlas and every canonical file are unchanged. Nothing is written back.
- **Copies that leave the site keep the author's words.** A portable copy, a feed or an export cannot
  resolve an atlas entry, so its Markdown (`Post::portable_markdown`) has each concept link written
  as its label (and an `atlas:` reference definition removed), and its HTML has the plain words. The
  copy's link to the canonical article is the way back to the linked version. The authored source is
  never changed: the author's syntax stays in the file.
- **The boundary manifest lists what a post links.** The post-scope `context-links` projection
  (ADR 0125) treats `atlas:<id>` like an address to the entry's page: a linked published entry is a
  published item `atlas-page` with its address and the post, once however often it is linked, and
  one that is not published is a withheld item with the reason `page-not-published` and a message
  that the label is published as plain text. The pre-publication review's `context-link` check reads
  the same links and says the same.
- **Checks shared with the browser.** Whether a destination names an entry is one rule in Rust
  (`concept_links::entry_id`) and JavaScript (`conceptEntryId` in `web/components/atlas-terms.js`),
  tested against `tests/fixtures/concept-links.json`.
- **Conservative and reversible.** Nothing is stored, emailed or published beyond what the atlas
  already publishes. Removing the syntax from a post, or turning the atlas off, removes the links at
  the next build.

## Consequences

- An author sees a precise warning for every concept link that did not become a link, instead of
  discovering a dead link on the live site.
- The marked HTML and the portable Markdown are two more forms of a post to keep in step; both are
  derived once at load from the same events, and tests cover each.
- The Admin editor does not yet offer a picker for entries; the syntax is plain text an author, an
  assistant or a script can write.
