# ADR 0204: Shared reflections reference approved public context without changing the approved assembly

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#198](https://github.com/journey-to-code-org/open.blog/issues/198)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0198](0198-a-post-page-carries-its-curated-context-as-a-static-section-with-canonical-anchors.md)

## Context

A published shared reflection is a post whose words are exactly what every required author approved. Research context must not become part of what they approved, nor bypass the approval model.

## Decision

- **A rendering, not content.** The context is appended to the post's portable copies from the public value; it is never written into the assembled source or the approved revisions, so the approval binding is unchanged.
- **After the arrangement.** In every copy the rounds, prompts, authors and labels keep their reading order and the context follows the last turn. `reflection_text` (the body llms-full.txt prints) is unchanged, and the context is appended after it.
- **Public only.** A selection scoped to the reflection's slug is the same public value as for any post: only what the atlas, comparisons and citations already publish and the author selected. A private note, draft or unapproved prose is not in it.
