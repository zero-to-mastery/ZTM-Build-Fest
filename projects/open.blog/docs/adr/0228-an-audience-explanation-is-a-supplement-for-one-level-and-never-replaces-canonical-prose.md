# ADR 0228: An audience explanation is a supplement for one level and never replaces canonical prose

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#88](https://github.com/journey-to-code-org/open.blog/issues/88)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0226](0226-a-comparison-is-its-own-public-content-type-and-one-versioned-file.md)

## Decision

- **Three fixed levels.** `beginner`, `student`, `scholarly`, in that order wherever they are offered.
  They are the author's labels for the text they wrote, not a reader profile; nothing personalises or
  remembers a level on the server.
- **A supplement by construction.** An explanation is `text` about the whole comparison or, with
  `about`, one interpretation. The file has no field that stands in for a post's prose, and the
  fields that would (`replaces`, `canonical`, `body`, ...) are refused (ADR 0227). The public value
  always carries `supplemental: true`. A reader who never chooses a level reads the canonical prose,
  unchanged.
- **One per level per subject.** A second `student` explanation of the same interpretation is refused,
  so switching levels is a choice among alternatives, not a pile.
- **Claims nothing of its own.** An explanation holds no relation or attribution, and any evidence
  reference it carries must already be cited by the interpretation it is about (or, for the whole
  comparison, by some interpretation); validation refuses anything else. The page therefore shows
  evidence only beside the interpretations, never inside a level, so it never says more than the
  interpretations it explains and a level choice cannot change the evidence on view.

## Consequences

- Authors can write for several audiences without forking the post.
- Reading a level is never required to understand the canonical text.

## Domain language

**Audience explanation** is defined in [`CONTEXT.md`](../../CONTEXT.md).
