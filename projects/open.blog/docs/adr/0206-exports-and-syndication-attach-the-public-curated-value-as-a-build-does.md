# ADR 0206: Exports and syndication attach the public curated value as a build does

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#198](https://github.com/journey-to-code-org/open.blog/issues/198)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0198](0198-a-post-page-carries-its-curated-context-as-a-static-section-with-canonical-anchors.md)

## Context

The CLI export and syndication load a site without the build's projections, so they would have silently left the context out.

## Decision

- `attach_public_curation` resolves the public value exactly as a build does, only while `curatedContext.publish` is on; with it off nothing is read. A selections file that cannot be read refuses the export, as it refuses a build, rather than producing a copy that looks complete.
- The text guard already allows the public value, so a copy's words pass it; any other private text is still refused or warned about. The sentinel corpus now scans portable HTML, Markdown and text, what a destination is sent, the feeds, llms-full.txt and the bibliographies, and checks that the approved words are in each.
- A syndicated copy's revision changes when its context first appears, so a destination is updated.
- **Skipped on purpose:** the Admin's authenticated portable preview does not attach it yet.
