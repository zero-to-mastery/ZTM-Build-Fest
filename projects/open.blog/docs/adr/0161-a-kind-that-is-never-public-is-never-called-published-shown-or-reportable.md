# ADR 0161: A kind that is never public is never called published, shown or reportable

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0152](0152-a-future-suggestion-is-one-more-participation-kind-whose-approval-publishes-nothing.md), [ADR 0107](0107-reader-receipts-deletion-requests-and-anonymous-abuse-reports.md)

## Context

The core policy's `is_public` is false for a kind that is not publishable in every state, so nothing
in the build can show an accepted suggestion. The hosted function, which answers readers directly
from stored rows, decided "published" and "shown" from the state alone: an approved suggestion's
receipt would have said it was published, and an abuse report against one would have been stored and
would have told the reporter the item exists, while a report against an id that does not exist was
refused.

## Decision

- **The hosted mirror asks the same rule.** `netlify/lib/participation-moderation.mjs` exports
  `isPublishable(kind)`: the kind's fixed `publishable` rule, false for an editorial kind, an abuse
  report and a kind the code does not know.
- **A receipt's `published` is false for a kind that is not publishable**, whatever its state: an
  accepted suggestion's receipt says it is not published, and its words say it is private to the
  editors.
- **A report is accepted only for an item that is public now**, and "public" requires
  `isPublishable(kind)` first. A report against an accepted suggestion gets exactly the answer a
  report against a nonexistent id gets (404 `unavailable`, the same body), so the existence of a
  private suggestion does not leak, and nothing is stored.

## Consequences

Both rules are tested at the function: an approved suggestion row read through its receipt, and a
report against it compared byte for byte with a report against an unknown id. Every kind that is
publishable keeps its behaviour.
