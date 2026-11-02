# ADR 0218: A continuation is a typed ordinary link from one approved submission to a later work

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0181](0181-features-publish-from-community-perspectives-json-beside-third-perspectives-json-and-read-strictly.md)
- Coordinates with: [#151](https://github.com/journey-to-code-org/open.blog/issues/151) (collaborative series), [#76](https://github.com/journey-to-code-org/open.blog/issues/76) (reading paths)

## Context

A reader's question, reflection or source suggestion may shape what is written next. Readers should be able to follow that from the earlier page to the later one, and back, without an account, script or service.

## Decision

- A continuation (`crates/openblog-core/src/continuation.rs`) is an editor's edge with an `id`, the origin's `kind` (question, reflection, source-suggestion) and `origin` id, the canonical `from` page it was about, the canonical `to` page of the later work, an optional series slug, a closed `relation` (takes-up, revisits, uses-source), an optional editorial `note` and the day `linked`.
- One origin may open many edges (at most 20) and each origin-and-page pair links once. The file holds at most 500.
- **Ordinary links are the whole baseline.** The static section on the earlier page lists "where this question went" and on the later page "earlier questions this continues", as a labelled region of plain links. It needs no JavaScript, account or hosted service, and shows no count, rank or subscription.
- The relation describes the link, never its worth. `uses-source` is valid only for a source suggestion.
- Questions and source suggestions are never public, so their edges show the kind ("a reader's question") and the editor's note only, never the reader's words or name.

## Considered options

- **Link by free-text "because of" notes.** Rejected: it invites causation claims (ADR 0220).
- **Store the edge in the post front matter.** Rejected: it ties a reader's submission to an author's file and history.
