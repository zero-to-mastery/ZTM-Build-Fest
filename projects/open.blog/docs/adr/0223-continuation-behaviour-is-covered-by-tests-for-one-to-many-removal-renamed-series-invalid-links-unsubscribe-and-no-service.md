# ADR 0223: Continuation behaviour is covered by tests for one-to-many, removal, renamed series, invalid links, unsubscribe and no service

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0218 to ADR 0222

## Decision

The unit tests in `continuation.rs` cover each required case: one-to-many edges and duplicate pairs, removed or withdrawn submissions (hidden and forgotten), renamed and unknown series, invalid links and notes, strict canonical file reading, escaped static output free of private fields, link-only offers (no service), explicit consent, redacted debug output, unsubscribe with right and wrong tokens, and deletion. The page and Admin wiring (#231, #232) add browser tests for keyboard, 400% reflow and reduced motion on the real UI; the Admin and page wiring (#231) added them, see ADR 0224.
