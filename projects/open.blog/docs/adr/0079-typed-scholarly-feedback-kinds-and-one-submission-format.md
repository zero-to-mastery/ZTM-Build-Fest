# ADR 0079: Typed scholarly feedback is a reader's stated intent with a fixed set of kinds and one submission format

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#81](https://github.com/journey-to-code-org/open.blog/issues/81)
- Parent story: [#29](https://github.com/journey-to-code-org/open.blog/issues/29)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md),
  [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md)
- Coordinates with: [#82](https://github.com/journey-to-code-org/open.blog/issues/82) (forms),
  [#83](https://github.com/journey-to-code-org/open.blog/issues/83) (moderation),
  [#208](https://github.com/journey-to-code-org/open.blog/issues/208) (RD6 evidence and
  correction decisions), [#210](https://github.com/journey-to-code-org/open.blog/issues/210)
  (RD10 Third Perspectives), [#211](https://github.com/journey-to-code-org/open.blog/issues/211)
  (RD12 participation policy), [#213](https://github.com/journey-to-code-org/open.blog/issues/213)
  (RD13 future questions and source suggestions)

## Context

B5 lets readers ask questions, suggest sources, suggest corrections and offer other readings of a
passage. RD6, RD10, RD11 and RD13 will add evidence submissions, Third Perspectives, responses to
one author's section and future-question suggestions, and the roadmap (#92) requires all of them to
extend the one hosted engagement seam rather than start another comment system. RD6 adds a rule
that shapes the names: a submission is never labelled a correction before an author decides. The
hosted function, a reader's browser and the author's manual entry must agree exactly on what is a
valid submission, and nothing about the reader beyond ADR 0078 may ride along.

## Decision

- **A kind names the reader's intent, never a verdict.** Four kinds, with stored ids:

  | Id | Label | Target | `details.sourceUrl` | `details.suggestedText` |
  | --- | --- | --- | --- | --- |
  | `question` | Question | any | optional | no |
  | `source-suggestion` | Suggested source | any | required | no |
  | `correction-suggestion` | Suggested correction | a section or a quotation | optional (evidence) | optional |
  | `alternative-interpretation` | Another interpretation | any | optional | no |

  A suggested correction is not a correction: only an author decision (#83, RD6) can make one,
  and accepting any feedback is a separate author edit. Nothing here edits a post, a citation, the
  Source Library or research notes, and no field ranks, votes on or endorses feedback.
- **One submission format** (version 1, JSON):

  ```json
  {"version":1,"kind":"correction-suggestion","work":"/posts/tides/","revision":"p1:…",
   "target":{…},"body":"…","details":{"sourceUrl":"https://…","suggestedText":"…"},
   "seenAt":"2026-10-26T09:58:00Z","attribution":{"name":"Ada","publishName":false}}
  ```

  `work`, `revision`, `target`, `seenAt` and `attribution` are the ADR 0078 fields with its rules;
  `target` is read with the passage-target rules, integers checked as written. `body` is the
  feedback text, 1–4,000 characters once surrounding Unicode whitespace is trimmed; tabs and line
  breaks are kept, other control characters and the bidirectional embeddings, overrides and
  isolates are refused. `suggestedText` follows the same rules up to 2,000 characters. `sourceUrl`
  is an absolute HTTP(S) link without credentials, written without whitespace, control or
  text-direction characters, stored as its WHATWG serialization, which must be ASCII (an
  international host becomes Punycode) and at most 2,048 bytes. A name is collapsed to single
  spaces; a blank name is anonymous. A detail a kind does not use is refused, not dropped. Unknown
  fields are refused, so no e-mail, address or account can be added; a serialized submission is at
  most 32 KiB.
- **Checks run in one fixed order** (size, JSON, version, shape, kind, work, revision, target,
  target allowed for the kind, body, details, `seenAt`, attribution), so every implementation
  reports the same first problem with the same code. Messages name the field and never repeat the
  reader's text. JSON is read as the build reads it: a number that does not fit a double, nesting
  deeper than 127 levels or a lone surrogate makes the document invalid; a repeated key keeps its
  last value.
- **One record a receiver keeps**: `{version, kind, body, details, provenance}`, where
  `provenance` is the ADR 0078 record with the receiver's own `receivedAt` and channel and a
  reader clock running ahead dropped. A copied submission the author enters by hand (the manual
  channel) makes the same record as the hosted path.
- **Two implementations, one set of fixtures.** `openblog_core::scholarly_feedback` serves the
  build and Admin (#83 reads hosted moderation items through `HostedFeedback`, re-checking every
  rule because stored data is not trusted more than a request);
  `web/components/passage-feedback.js` serves the hosted function (ADR 0081) and the forms (#82).
  Both read `tests/fixtures/scholarly-feedback.json` and must produce the same codes and records.
- **Extending the kinds.** A kind id is lowercase letters, digits and hyphens, at most 40
  characters. A new kind (`third-perspective` for RD10, a section response for RD11, future
  questions for RD13) is added to both implementations and their fixtures with its own target and
  detail rules; storage checks only the id's shape (ADR 0080), so no migration is needed. A kind
  this version does not know is refused as `unknownKind`, never guessed. Kinds that need fields
  the record lacks (an evidence role, a decision, a parent item) raise `version`, which older
  readers refuse.
- **The copy fallback.** `feedbackCopyText` writes a plain-text message a reader can copy to the
  author when no endpoint is available: the kind, the canonical address, the passage, the
  revision, the text and details, the name and its publication choice, and the submission's
  canonical JSON on its last line for the author's manual entry. It sends nothing.

## Consequences

- Moderation can always tell a question from a suggested correction, and a published note can
  never call a reader's suggestion a correction unless an author decided so.
- Third Perspectives and the other roadmap kinds extend the same format, record and storage.
- Validation logic lives twice, Rust and JavaScript; the shared fixtures, including number
  canonicality, nesting and hostile text, keep them in step.

## Domain language

**Feedback kind**, **Feedback submission** and **Scholarly feedback record** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
