# ADR 0220: A continuation does not imply cause or endorsement, and its note is linted

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0218

## Context

Linking a later work to a reader's question can read as "the reader made us write this" or "the editors agree with the reader".

## Decision

- Every list of continuations carries `NO_CAUSATION_NOTICE`: the link means the later work takes the topic up, not that the submission caused it, that its author agrees, or that the editors endorse it.
- The editor's note is plain text of at most 280 characters. It is refused when it claims popularity, a count or agreement (the ADR 0180 lint) or says the submission caused, prompted or is endorsed by the work ("inspired", "because of", "led to", "endorse", "thanks to" and similar). These are conservative lints, not a judgement of the note; an editor can say a true thing in other words.
- Nothing counts, ranks or orders by attention: edges list by the day linked, then id.
