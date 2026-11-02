# ADR 0221: A removed or deleted submission takes its continuations off every page and out of the file

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0218, ADR 0219

## Context

Readers may withdraw a submission and moderators may remove one. The earlier question must not linger as a link.

## Decision

- `resolve` shows an edge only while the origin is `Approved` and both pages are published. Any other standing hides it with no placeholder. A static build has no hosted service to ask, so it passes `Approved` for every edge in the file, which Admin wrote only for a submission it saw approved and drops with `forget_origin` when that stops being true (ADR 0224); an edge whose pages are not published is hidden at build time. A removed submission therefore disappears from both ends at the next build.
- `ContinuationsFile::forget_origin` drops every edge of a deleted, withdrawn or removed submission for good; Admin calls it with the same action that removes the submission, and a sweep drops edges of submissions withdrawn on the hosted side (ADR 0224). Nothing of the submission ever lived in the file, so no text needs scrubbing.
