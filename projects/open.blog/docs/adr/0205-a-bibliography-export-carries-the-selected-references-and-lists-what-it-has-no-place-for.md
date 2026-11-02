# ADR 0205: A bibliography export carries the selected references and lists what it has no place for

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#198](https://github.com/journey-to-code-org/open.blog/issues/198)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0198](0198-a-post-page-carries-its-curated-context-as-a-static-section-with-canonical-anchors.md)

## Context

BibTeX and CSL JSON describe sources. Of the curated items only references are bibliographic.

## Decision

- **References join the cited ones**, after them, once each by key, as the public description the exporters already read (`PublicReference`), with only the fields the item holds: a creator or date the source lacks is absent, never filled in. A post with curated references but no citations can export them.
- **Everything else is listed.** Each annotation, relationship, dating, comparison, entry or explanation offered to the post is an export loss (`omitted:` in the dry run, `omissions` in the JSON plan) saying a bibliography has no place for it and that it is in the portable article and on the canonical page.
- **Legacy.** With no curated context the export is what it was. The Admin preview's own citation exports are unchanged.
