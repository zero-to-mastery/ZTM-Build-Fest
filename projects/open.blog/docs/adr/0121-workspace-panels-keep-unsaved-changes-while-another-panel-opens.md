# ADR 0121: Workspace panels keep unsaved changes while another panel opens

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#60](https://github.com/journey-to-code-org/open.blog/issues/60)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0019](0019-draft-editor-prompts-and-conflict-recovery.md),
  [ADR 0120](0120-the-research-workspace-is-one-admin-destination-with-one-route-namespace.md)

## Context

Research happens beside writing: an author drafting a paragraph opens the library to check an
edition, captures a passage, and returns to the draft. Admin mounted one view at a time, so
leaving the editor asked "Leave without saving?" and then discarded the draft, and the
notebook, atlas and comparison forms were discarded without asking at all, because only the
editor and Sources reported unsaved changes to the router. Saving before every look at the
library would put half-written drafts into the site's files and history; the alternative of
storing drafts in the browser would copy private research and unpublished prose into storage
that outlives the session and is shared by whoever uses the browser.

## Decision

- **Every view says whether it has unsaved changes.** Besides the editor's existing flag, a view
  with its own form registers `viewDirty` when it mounts (Sources, Notebook, Atlas and Compare
  do), and the router, the sign-out question and the page-leave guard all ask it.
- **Switching panels keeps, never discards.** Moving from one workspace panel (a research panel
  or the draft) to another keeps the one being left when it has unsaved changes: its rendered
  nodes, its closures and its view version are set aside in memory, and the editor is suspended
  rather than disposed (pending preview and autocomplete work is dropped, as navigating away
  always did). Opening that panel again puts the same nodes back, unsaved values, selection
  state and conflict notices included, restores its view version so its pending work applies to
  it again, refreshes the editor's open view from the draft, and announces "… is as you left it,
  with your unsaved changes." A panel without unsaved changes is simply reloaded, so clean
  panels always show the latest files.
- **A kept panel reopens where it was left.** Asking for another item in a kept panel (another
  atlas entry, another alignment) reopens the kept panel at its own address and says to save or
  discard before opening another item. A kept draft opens on whichever of its views the address
  asks for, so the Claims link opens its Evidence Studio.
- **Asking first is kept for real loss.** The workspace holds at most one kept panel of each
  kind and one draft. The author is asked, naming every place unsaved work is in ("the draft
  “On the cave” and Notebook"), before: reloading the same panel, leaving the workspace for any
  other Admin page (kept panels are then discarded), opening a different document while a draft
  is kept, signing out, and closing or reloading the page. Declining changes nothing and puts the
  address back. A panel whose save is in flight, the draft or a research form such as Sources
  (views register `viewBusy` beside `viewDirty`), is never kept, because the save still owns the
  view and its address and its result must land there, or the next save would send a stale
  revision; the author is asked as before. An earlier address of the panel already open (such as
  `#/sources` on Sources) only corrects the address and never reloads the panel.
- **Memory only, for one user.** Kept panels live only in the page's memory. Nothing is
  written to files, browser storage, logs or the server, so no private research or unpublished
  prose is copied anywhere. Signing out discards every kept panel and the workspace's remembered
  draft title. A session that ends without signing out (an expired session that shows the
  sign-in form) keeps them, together with the open panel when it has unsaved changes, for the
  user who was signed in: signing in again as that user in the same tab returns to them, and a
  sign-in as anyone else discards them first, so another user never sees them. The sign-in form
  says that unsaved changes are kept without naming them. While the sign-in form shows, the
  router opens nothing: a new address or Back only puts the address back where the kept panels
  were left. And because the session cookie is shared by every tab, a kept panel returns only
  after the server confirms that the current session is still the user who kept it; when another
  tab has signed in as someone else, every kept panel is discarded and the sign-in form shows.
- **The rules are one pure function.** `planWorkspaceNavigation` decides what a move keeps,
  restores, discards and asks about from the two addresses, whether the open view is unsaved or
  saving, and the kept panels; the router only carries the plan out, so the rules are tested
  without a browser.

## Consequences

- An author can move between the draft and every research panel without saving or losing
  anything, and leaving the workspace still asks first, as Admin always did.
- Kept panels hold memory for their nodes until they are reopened, discarded or the page
  closes; at most five can exist at once (one per research panel, and the draft).
- A kept panel can be stale. Its saves name the revision it read, so a change made elsewhere
  meanwhile is refused with the existing conflict recovery (ADR 0019, and each store's
  revision check) rather than overwritten.
- The draft-side panel (#61) brings research into the editor, so most insertions need no switch
  at all; full panels opened from it keep the draft by this same rule.

## Domain language

**Kept panel** is defined in [`CONTEXT.md`](../../CONTEXT.md).
