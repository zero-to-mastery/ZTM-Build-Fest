# ADR 0202: Portable copies carry the public curated context as labeled sections with links back to the canonical page

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#198](https://github.com/journey-to-code-org/open.blog/issues/198)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0198](0198-a-post-page-carries-its-curated-context-as-a-static-section-with-canonical-anchors.md)

## Context

#197 left portable HTML, Markdown, text, feeds and llms-full.txt without the research context a post's page carries. A copy that leaves the site cannot use the page's anchors, scripts or layout, and must still keep every attribution, doubt and evidence beside what it qualifies.

## Decision

- **One source.** A copy reads the public curated value through the same projection the post's page is rendered from (`Site::curated_context_for`), and nothing else. It never takes a selections file, a notebook, a library or an atlas, so it cannot reach a private object. Only `PortableProjection::for_site` attaches it; `from_post` and the authenticated Admin preview carry none.
- **One renderer, three syntaxes.** The page, the portable HTML and the portable Markdown are written by the same code from the same fields, so their words, order and escaping agree. Plain text is derived from the Markdown like every other portable text. A copy has no ids, scripts or data attributes; every link is absolute; a link to an in-page anchor becomes the canonical address and that fragment.
- **Links back.** Each copy says "Read this research context on the original article" (the canonical `#ob-research-context`) and ends each item with a link to that item's `#ob-curated-<id>` on the canonical page. A summary-only feed says where the section is (an Atom `related` link in RSS, `_openblog.researchContext` in JSON Feed with each item's id, kind and anchor) and carries no item's words.
- **Fails closed.** A copy that dropped an item's anchor, reordered the items, or lost any of the words of the items it shows is refused for that post alone (`curated-context-lost`), naming what is missing and never publishing a partial copy, as claim evidence does. Words are compared by letters and digits so each format's escaping does not matter.
- **Bounded.** A copy shows at most the page's bound (1,000 items) and says how many more are on the canonical page.
- **Legacy bytes.** With curation off, nothing selected, or nothing offered to a post, every copy, feed and llms-full.txt is byte for byte what it was, and so is a syndicated copy's revision.
- **The page said less than the data.** Checking the words found that a compared version's passages and its rights statement were not on the page; both are now shown, on the page and in every copy.
