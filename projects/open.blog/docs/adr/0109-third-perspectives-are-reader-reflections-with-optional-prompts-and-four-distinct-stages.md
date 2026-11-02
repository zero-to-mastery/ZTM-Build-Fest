# ADR 0109: Third Perspectives are reader reflections with optional prompts, a work or section target, and four distinct stages

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#210](https://github.com/journey-to-code-org/open.blog/issues/210)
- Parent story: [#201](https://github.com/journey-to-code-org/open.blog/issues/201)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0026](0026-publishing-approved-synthesis-in-the-post.md),
  [ADR 0040](0040-contributor-aware-series-navigation.md), B5's passage targets and feedback
  provenance ([ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md) and [ADR 0078](0078-feedback-provenance-records-the-revision-seen-and-consent.md)), RD12's participation registry
  ([ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md))
- Coordinates with: [#221](https://github.com/journey-to-code-org/open.blog/issues/221) and
  [#222](https://github.com/journey-to-code-org/open.blog/issues/222) (RD10 submission and
  status), [#211](https://github.com/journey-to-code-org/open.blog/issues/211) (participation
  policy), [#214](https://github.com/journey-to-code-org/open.blog/issues/214) (RD14 featured
  reflections), [#215](https://github.com/journey-to-code-org/open.blog/issues/215) (RD15
  continuations), [#81](https://github.com/journey-to-code-org/open.blog/issues/81) (hosted
  transport)

## Context

A shared reflection publishes its authors' perspectives side by side, and their joint statements
under "Continuing the conversation" (ADR 0026). RD10 lets a reader add another reading without
being cast as a vote for one author or a verdict on who was right. The roadmap (#92) says
Third Perspectives extend the one participation seam (#81, #211) and do not become a second
comment system. RD12 already reserves the kind id `third-perspective` with the target shape
"the work or a section", and B5 defines the passage target JSON. The issue asks for the
vocabulary (Reader reflection, Third Perspective, Response category, Submission consent,
Moderation decision, Featured reflection, Continuation), for optional categories, for distinct
private, submitted, approved and featured forms, and for anonymous display without anonymous
moderation provenance. Hosted persistence and UI are out of scope.

## Decision

- **A Third Perspective is one participation kind.** `openblog_core::third_perspective` defines it
  with RD12's kind id `third-perspective` and label "Third Perspective". It is a reader's own
  reflection on a published work (a shared reflection or any post), submitted through the public
  path without an account, always pending first (ADR 0111), and public only with the reader's
  consent (ADR 0110) and a moderator's approval of exactly that text and consent. It is never an
  author's perspective, never part of the authors' sections or "Continuing the conversation",
  never a work credit, and never a research note.
- **Four distinct stages, four types.** Nothing converts one into the next except the step named:
  1. **Local reflection** (`LocalReflection`): the reader's private draft on their own device. It
     has no id, provenance, consent or moderation state; nothing in core sends or stores it.
  2. **Submitted copy** (`SubmittedCopy`): what the site received when the reader chose to send
     the draft with their consent (`SubmissionRequest::receive`). Private to moderation.
  3. **Approved response** (`ApprovedResponse`): the one public projection of an approved copy
     (ADR 0111), for the canonical page only.
  4. **Featured publication** (`FeaturedPublication`): an approved response an editor features,
     which needs the reader's separate feature consent for that approved revision. RD14 (#214)
     owns placement, editorial context and the unpublish policy; selection is editorial and never
     a count, rank or reaction.
- **Response categories are optional prompts.** `ResponseCategory` is a closed list a form may
  offer beside its prompt, and a reflection without one is complete:

  | Id | Label | Prompt |
  | --- | --- | --- |
  | `another-reading` | Another reading | How do you read this, in your own way? |
  | `connection` | A connection | What does this bring to mind: another work, idea or source? |
  | `experience` | From experience | What in your own experience speaks to this? |
  | `question` | A question | What question does this leave you with? |
  | `application` | Putting it to use | How might you apply or try this? |

  A category describes what kind of thought it is. There is no score, rating, agreement,
  disagreement, "correct" or "side with an author" category, nothing asks which author the reader
  prefers, and an unknown category or any ranking or vote field is refused. A test checks that no
  id, label or prompt reads as a verdict.
- **Target: usually the whole work, or one section.** A target is B5's passage target JSON,
  restricted: `{"version":1,"kind":"work"}` or
  `{"version":1,"kind":"section","section":"methods","digest":"…"}` (no `section` for the text
  before the first heading). A `quote` target is refused (`targetNotAllowed`): quoting a passage is
  passage feedback. Anchor and digest rules are B5's.
- **Content limits.** The reflection is plain text, never read as Markdown or HTML: line breaks
  normalized to `\n`, trimmed, 1 to 4000 characters (the comment and passage-feedback limit),
  without control characters other than tab and line break and without bidirectional overrides.
  Renderers escape it and split paragraphs at blank lines. A name is 1 to 80 characters with
  whitespace collapsed. A submission or stored record is at most 32 KiB. Messages name the field
  and never repeat what the reader wrote. Rate limits, quotas and spam handling belong to the
  transport (#221).
- **The submission format** a browser sends:

  ```json
  {"version":1,"kind":"third-perspective","work":"/posts/tides/","revision":"p1:…",
   "target":{"version":1,"kind":"work"},"category":"connection","body":"…",
   "seenAt":"2026-10-26T09:41:00Z","attribution":{"name":"Mina","publishName":false},
   "consent":{"publish":true,"clarification":true,"feature":false}}
  ```

  It is B5's submission shape plus `category` and `consent`. `consent.publish` must be present and
  true; unknown fields are refused, so no vote, rating, contact or device data can ride along.
- **Vocabulary.** Reader reflection, Third Perspective, Response category, Local reflection,
  Submitted copy, Approved response, Featured reflection, Submission consent, Moderation decision
  and Continuation are defined in [`CONTEXT.md`](../../CONTEXT.md). A **Continuation** is RD15's
  typed link from an approved response to a later published work (#215). Only an approved
  response can be continued; a continuation never edits the reflection and never implies that it
  caused or is endorsed by the new work.

## Considered options

- **A Third Perspective as a comment with a flag.** Rejected: comments carry no consent, target,
  revision binding or withdrawal, and the roadmap forbids a second comment system; the kind uses
  the one participation policy instead.
- **Publish approved Third Perspectives inside the Post, like synthesis items.** Rejected: the
  Post is the authors' approved work and its credits. Approved responses stay a reader layer on the
  canonical page (ADR 0111); only RD14's featured publication may later place one in published
  content, with its own consent.
- **Required categories, or categories such as "agree" and "disagree".** Rejected: they would
  turn reflections into votes and make an uncategorized thought incomplete.
- **Quotation targets.** Rejected for this kind: a reflection is about the work or a section;
  B5's passage feedback already covers quotations.

## Consequences

- RD10.2 (#221) builds the form and transport on this submission format and RD10.3 (#222) the
  receipt and status; neither needs a new contract.
- Existing output is unchanged: this task adds core types and tests only, no page, feed, export,
  configuration or database change.

## Domain language

**Reader reflection**, **Third Perspective**, **Response category**, **Local reflection**,
**Submitted copy**, **Approved response**, **Featured reflection** and **Continuation** are
defined in [`CONTEXT.md`](../../CONTEXT.md).
