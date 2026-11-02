# ADR 0130: Attributed perspectives store the responder, publish nothing by themselves, and leave static reading and portable copies whole

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#212](https://github.com/journey-to-code-org/open.blog/issues/212)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0081](0081-hosted-feedback-transport-is-opt-in-and-reuses-the-engagement-seam.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0126](0126-an-attributed-section-is-an-ordinary-section-target-with-a-reserved-anchor-and-a-digest.md),
  [ADR 0128](0128-only-the-bound-contributor-who-wrote-a-section-may-answer-as-its-author.md)

## Context

Hosted storage, and anything that makes reader or author words public, are hard to take back. This
task defines the targets and permissions so that #223 and #224 can build on them. An earlier draft
of this ADR said the contract adds no storage at all; that held for the target but not for the
answer, whose author must be stored for the answer to be shown honestly.

## Decision

- **The target needs no new storage.** It is stored as the existing RD10 section target inside the
  existing hosted rows and the existing `third-perspectives.json`. Nothing in `attributed_perspective`
  adds a table, a column, a file or a versioned format of its own.
- **The answer stores its responder, and #223 owns that storage.** An author response is an
  existing `author-response` item, and #223 must also store who answered: privately the participant
  and contributor binding (`Responder::participant`, with the Admin account in the audit event) and
  publicly the contributor handle, the published name and the section's standing at the time
  (`Responder::contributor`, `author`, `standing`). Without that, nothing can tell a contributor's
  answer from a plain author response a coordinator was permitted to post. Two things enforce it
  in this contract: `ModerationPolicy::admit` refuses a plain author response to an attributed
  parent (ADR 0128), and `response_shown` shows an answer under an attributed parent only when its
  stored responder contributor equals the section's. #223 stores those fields in the existing row's
  `details`, with no hosted schema change, behind one opt-in flag (ADR 0132); this contract does not
  change a hosted schema.
- **Nothing is published or sent.** The module is pure: it decides, and callers write. It does no
  e-mailing, notification or publication, and an answer is pending until a moderator approves it.
- **Static and portable stay whole.** A post's canonical page, static builds, portable HTML and
  Markdown, feeds and `llms` files are produced as before, except the reserved-heading-id change of
  ADR 0126 for a heading whose text begins "OB by". Ordinary reading never needs the response
  service, JavaScript or an account. Targets resolve from the committed body and credits alone, so
  a CI or static build without private records resolves the same as Admin. Where the hosted service
  is absent answers simply cannot be written, with the canonical page and the offer-by-text
  fallback of ADR 0114 unchanged.
- **Untrusted input.** The anchor and digest are checked strictly and by exact form (lowercase
  registry key, canonical place), a target names no value in its errors, no author is attributed
  by name (so duplicate and look-alike names attribute nothing), and a forged look-alike
  arrangement is not an arrangement. Reader text is untouched here.
- **Out of scope.** Nested discussion trees, answers to conversation items, per-author opt-outs,
  rate limits and the submission route (#223), and rendering (#224).
