# ADR 0203: A portable copy says what it could not carry, and an address that is not a link stays text

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#198](https://github.com/journey-to-code-org/open.blog/issues/198)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0198](0198-a-post-page-carries-its-curated-context-as-a-static-section-with-canonical-anchors.md)

## Context

A format cannot carry everything the page does, and a missing detail must never look like a complete copy.

## Decision

- **Loss diagnostics.** Portable HTML reports, with the portable-export destination, `curated-context-sequenced` (information: anchors, links between items, the data file and layout are on the canonical page; the items' words, attribution, doubt, evidence and origin are unchanged), `curated-context-address-text` (warning: an address that is not a safe link is shown as text) and `curated-context-held-back` (warning: items beyond the bound are on the canonical page). They reach `openblog export` and build warnings through the existing diagnostics path.
- **Nothing is invented.** A detail the source lacks is listed as not recorded in the copy, as on the page; a caveat is a sentence from its code and field, never the Admin's message.
- **Hostile text is inert.** Every string is escaped for its syntax; a link is only a page of this site or an `https` address, made absolute; a backslash, control character or `javascript:`/`data:` address is text.
