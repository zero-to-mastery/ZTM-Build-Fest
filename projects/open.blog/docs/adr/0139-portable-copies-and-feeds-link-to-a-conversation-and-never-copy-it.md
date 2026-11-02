# ADR 0139: Portable copies and feeds link to a conversation and never copy it

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#224](https://github.com/journey-to-code-org/open.blog/issues/224)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0130](0130-attributed-perspectives-store-the-responder-publish-nothing-by-themselves-and-leave-static-reading-whole.md),
  [ADR 0137](0137-an-approved-author-response-is-published-under-its-reflection-in-the-one-public-file-and-shown-only-where-the-one-rule-says-so.md),
  [ADR 0138](0138-a-conversation-follows-its-authors-section-as-static-html-with-anchors-bounded-and-enhanced-only-by-script.md)

## Context

#224 asks that feeds and cross-posts receive "an approved excerpt or prose, or a discussion link per
policy". A reader's words and an author's response are published on the canonical page under their
own consent and moderation; copying them into a feed or a cross-post would carry them somewhere that
consent and withdrawal do not reach, and a feed reader cannot show a response as the author's.

## Decision

- **Link, never copy.** The policy is the link, as for Third Perspectives (ADR 0115): a post that
  shows reflections carries the labelled canonical-link capability, and portable HTML and Markdown,
  `rss.xml`, `feed.json`, `atom.xml`, `llms.txt` and `llms-full.txt`, and search data carry only that
  link, never the reflection's or the answer's text, the author's response heading, the answer's or
  reflection's id, the conversation markup or the responder. A leak scan over every generated file
  holds this (`author_conversations.rs`), and a browser contract fetches the feeds and portable
  copies from a running site (`author-conversations.spec.mjs`).
- **The link lands.** The link's target, `#ob-third-perspectives`, always exists on a page that
  shows reflections, even when every reflection is shown after its own section: the section then
  holds only links to those conversations (ADR 0138).
- **The conversation's own markup is canonical-only.** The `ob-by-` anchors and the
  `<ob-conversation>` element are written when the canonical page is rendered, not into the post's
  HTML that portable copies derive from. The body's `ob-turn-by-<key>` class (ADR 0136) is a
  contributor registry key already in the committed credits, so it adds nothing private.
- **Withdrawal and take-off.** A withdrawn, removed or rejected answer, or a reflection taken off,
  disappears from the next build and from the canonical link's target, as in ADR 0137; copies already
  published (history, a feed reader's cache) may remain, which Admin says.

## Consequences

A cross-post or a feed reader sends readers to the canonical page for the conversation, which is the
only place consent, moderation and withdrawal are enforced.
