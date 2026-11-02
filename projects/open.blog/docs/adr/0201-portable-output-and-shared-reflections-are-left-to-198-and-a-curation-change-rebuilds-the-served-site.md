# ADR 0201: Portable output and shared reflections are left to #198, and a curation change rebuilds the served site

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#197](https://github.com/journey-to-code-org/open.blog/issues/197)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0197](0197-the-curated-context-file-is-a-bounded-versioned-projection-of-the-one-public-curated-value.md), [ADR 0195](0195-curation-changes-are-revision-checked-ordered-after-the-content-lock-and-atomic.md)

## Context

#197 publishes the projection; #198 owns carrying curated context across portable HTML, Markdown, text,
feeds and approved shared-reflection assemblies, with loss diagnostics.

## Decision

- **What #197 leaves for #198.** The section lives on the page, which is built from the post; portable
  Markdown, portable HTML, bibliography exports, feeds and a shared reflection's assembly are built from
  the post and do not carry it. This release adds nothing to them, and a test pins that they carry
  neither the section nor the approved comment's text. The data file and the section are the public
  projection #198 reads: each item's facts, attribution, doubt, evidence and origin are already the
  semantic fallback it maps to lists, tables and attributed prose, and the sentinel corpus over every
  portable artifact stays clean.
- **A change rebuilds the served site.** While the site publishes curated context, a successful curation
  change rebuilds the site, as an atlas change does, and returns the outcome as `build`, so what an
  author previews and what the next build writes are the same. The store locks are released before the
  build and the content lock is kept, as every publishing save keeps it. A site that does not publish
  curated context is not rebuilt, and a change still only edits private choices.
