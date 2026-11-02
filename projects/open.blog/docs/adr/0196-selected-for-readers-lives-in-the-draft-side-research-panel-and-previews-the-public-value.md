# ADR 0196: Selected for readers lives in the draft-side research panel and previews the public value

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#196](https://github.com/journey-to-code-org/open.blog/issues/196)
- Parent story: [#190](https://github.com/journey-to-code-org/open.blog/issues/190)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0185](0185-curated-research-context-is-one-more-projection-that-selects-only-what-the-other-projections-publish.md), [ADR 0122](0122-the-draft-side-research-panel-inserts-only-checked-and-published-research.md), [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md)

## Context

The draft-side research panel already searches an author's research and inserts from it, and
What will be public already previews a post's research. Curation needs a place that is neither a
third panel nor a second preview.

## Decision

- **One section in the existing panel.** The panel hosts a **Selected for readers** section
  beside its research checks and claims. An item's detail offers **Select for readers** only when
  the build already publishes it (a public source, an approved entry, a published dating, a
  projected relationship, a published comparison) and says it is not selectable otherwise;
  selecting never approves it. An author can also write a comment on a public source or an
  explanation of an entry, attributed to a name they give.
- **The preview is the public value.** The section shows what readers of this post get from
  `PublicCuration.view_for(post)`, the same value the public renderers read (#197), as readable
  rows and, beside them, the exact public data. It adds nothing the author did not select, shows
  each caveat (competing dating, stale, missing, not recorded) and the context that comes with
  it, and never a private note, an unselected field or an unsafe address. What this post makes
  public lists the same curated report with its notices.
- **Accessible by construction.** The section is a labelled region; every control is a native
  button named for the item it acts on; the order is an ordered list with a visible place
  ("Place 2 of 5"); status is announced politely, an error is an alert and takes focus; focus
  returns to the control that opened a form or confirmation and stays on a moved item's control;
  Escape closes a confirmation or the new-selection form and goes no further, so the research
  panel stays open. Published and withheld are told apart in words. Everything wraps,
  so it reflows at 320 pixels and at 400% zoom without sideways scrolling.
- **No state is lost.** A refusal or a conflict keeps the form exactly as it was filled (the
  fields, the comment, who it is by, where it applies, the origin and the scope; a conflict
  reloads the list and the preview only) and the draft; nothing here edits the draft or the
  research; it works in Markdown and Visual modes. A change of the post's address rereads the view
  and refuses a change made against the old one, rather than touch another post's selections. An
  open item in the panel is redrawn whenever the selections load or change, so its "already
  selected" line is never stale.
- **A draft says so.** When the post is not published yet, the section says its selections are
  shown as they will be when it is published and the preview is headed "when this post is
  published" (ADR 0193); ordering works there.
- **The server states the rules.** The view lists each kind's always-included and optional
  fields, so the page restates none of ADR 0187, and the Rust tests pin the view as a fixture the
  node tests render.
