# ADR 0214: The path editor offers only published targets, names unpublished steps, and previews the one public projection

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#77](https://github.com/journey-to-code-org/open.blog/issues/77)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0210](0210-a-transition-is-the-authors-own-words-with-a-closed-relationship-that-never-defaults-to-influence.md),
  [ADR 0211](0211-a-path-names-only-published-items-and-a-missing-step-is-left-out-and-reported-to-the-author-only.md),
  [ADR 0212](0212-the-public-paths-value-is-an-allowlisted-deterministic-projection-and-nothing-reads-a-path-yet.md),
  [ADR 0213](0213-reading-paths-are-curated-through-one-admin-route-family-with-revision-checked-atomic-canonical-writes.md)
- Contract: [Reading paths](../specs/reading-paths.md#admin)

## Context

The editor is where an author decides what readers are told, so it must show the author what
readers will not see without telling readers, must be usable without a pointer, and must not
invent a second reading of a path.

## Decision

- **Only what production publishes can be picked.** The picker is fed by `PublishedTargets`
  (ADR 0211): published posts (not drafts, not scheduled) and, when the site publishes its atlas,
  public atlas entries. A target already in the path is not offered again.
- **Unpublished steps are named, to the author only.** A path may already name a draft, a
  scheduled post, a missing post or a private entry (a hand edit, or a post unpublished later). The
  editor shows each step's state in words (`Published`, `Draft`, `Scheduled`, `Not found`, `Not
  public`) with "readers will not see this step", never by colour alone. The author may see their
  own draft's title in the editor; the public projection never carries it.
- **One projection.** The preview is `PublicPaths::resolve` of the path as edited, as if
  published, so it cannot disagree with what a page will show (ADR 0212). Paths have no page yet
  (#78), so the preview renders that value as an ordered list; it is the production projection
  and not a second implementation. A path that would be withheld says so, with the author-only
  diagnostics, and says readers are never told a step was left out.
- **Reasons and labels are required.** Every step after the first shows the relationship as a
  required choice with no default (ADR 0210) and the reason as required text. The step says which
  step it follows, which is the nearest required step when optional steps lie between.
  Saving with either missing is refused in the browser and by the server and writes nothing.
- **Reorder is by buttons, never by drag alone.** Each step has Move up and Move down, named for
  the step and the position they move it to, in a labelled group; a move is announced in a polite
  live region and keeps focus on the same control (or the other one when it can no longer move).
  There is no pointer-only path. A step moved to the front keeps its written reason in the
  editor, shows a note that it is not saved while first, and gets it back when moved down.
- **Conflicts keep the draft.** A stale save keeps the author's edits on screen with the newer
  copy one click away ("Load the newer version") or "Keep my edits" to save over it deliberately.
- **Diagnostics are step-scoped and quote no value.** Problems name the step and the rule, link to
  the step by moving focus, and take focus when a save is refused.
- **Responsive and quiet.** The layout reflows to one column, long unbroken text wraps inside its
  region, source mode scrolls inside its own box, and nothing animates.

## Consequences

- An author learns that a post unpublished earlier broke a path while editing it.
- A screen-reader user reorders, adds, explains and previews without a pointer.
- The editor shows a state vocabulary the public never sees, which is why it lives in Admin.

## Domain language

**Path step** is defined in [`CONTEXT.md`](../../CONTEXT.md).
