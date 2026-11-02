# ADR 0222: Update subscriptions are optional, off by default, explicit and separate from analytics

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0218, [ADR 0155](0155-attribution-and-contact-are-optional-consented-and-contact-stays-private-to-the-site-admin.md)

## Context

Some readers want to hear when a question they care about is taken up. This must not be needed to follow a link, track anyone, or send anything unasked.

## Decision

- **Off by default.** `offer(enabled, hosted_available)` returns the form only when a site turned subscriptions on and the hosted service is reachable; otherwise it returns link-only, the baseline. The static page never contains a form, address or subscriber count.
- A request is `{scope, address, agree}`: the scope is one page's questions or one series, the address one plain mailbox (the same rule as a suggestion's contact), and `agree` must be explicitly true, separate from any submission consent. Unknown fields are refused, so no tracking or analytics field rides along.
- The stored record keeps the address only while active, plus a digest of the unsubscribe token (never the token). It does not implement `Serialize`, and its `Debug` shows no address or token, so it cannot reach a page, feed, export, log or analytics event by accident.
- **Unsubscribe and deletion** are always available. A correct token ends the subscription and erases the address (idempotent); a wrong token changes nothing; `erase` removes the address on request or by retention. Neither identifies the reader across sites.
- Out of scope and unchanged: transport. Nothing in this module sends a message to anyone.
- **Hosted schema: none in this task.** The table and function belong to #232, which must be additive, behind a flag, with a rollback file in `supabase/` (the RD13 precedent). The most conservative reversible option here is to add none.
