# ADR 0135: Until sections have anchors, an approved reflection about an author's section is named by its author and never linked

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#223](https://github.com/journey-to-code-org/open.blog/issues/223)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0111](0111-third-perspective-lifecycle-and-its-one-public-projection.md),
  [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0127](0127-an-attributed-target-resolves-by-author-and-text-and-is-stale-rather-than-retargeted.md)

## Context

Once readers can write about an author's section (ADR 0131), moderators can approve such a
reflection and Admin publishes it to `third-perspectives.json` as it does any other. RD10's
projection checks a section target against the post's heading sections, so an attributed target
would always read as "a section since revised or removed", which is false for a section that is
there and unchanged. The page anchors for author sections and the answers under reflections are
#224's. This decision keeps the page honest until then, without doing #224.

## Decision

- **The status of an attributed target comes from the author's published sections.** `project_post`
  resolves it with `AttributedSections` (ADR 0127) from the post's committed body and credits:
  current or stale, never another section's text. This is the one part of the projection wiring ADR
  0127 left to #224 that #223 does now, because #223 is what lets such a reflection be approved.
- **The page names it by its author and never links it.** A current one reads "About a section by
  MINA"; a stale one "About a section by MINA, since changed or removed" (the published work cannot
  say which); when the author has no section left, "About one author's section, since changed or
  removed". No `href` is written, because the section has no anchor on the page yet (#224 adds the
  anchors, and a link from the reflection to the section with them). Ordinary heading sections and
  the whole work read exactly as before (the existing tests hold them).
- **Absent services fail to the canonical page.** Nothing about reading, the list of author sections
  or a published reflection needs the hosted function, JavaScript or an account. Where the service
  is absent or refuses, a reader's reflection stays on the form with a retry and a copy that names the
  author in words; an author's Admin form keeps what was written and says why; Admin reports an
  absent endpoint, credential or service in its own plain words and never claims an answer stored.

Amended by [ADR 0138](0138-a-conversation-follows-its-authors-section-as-static-html-with-anchors-bounded-and-enhanced-only-by-script.md):
where author responses are not hidden, each author's section now has its `ob-by-` anchor, so a
current reflection links to it and is shown after it.

## Consequences

Approving a reflection about an author's section is safe to do before #224: the page says only what
is true. When #224 gives each section its anchor, the "never linked" rule is the one to lift.
