# ADR 0120: The research workspace is one Admin destination with one route namespace

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#60](https://github.com/journey-to-code-org/open.blog/issues/60)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0011](0011-admin-source-library-management.md),
  [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0073](0073-claims-are-authored-from-a-selection-in-evidence-studio.md),
  [ADR 0090](0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md)
- Amends: [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md) and
  [ADR 0090](0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md)
  (their routes move under `#/research/` and the old ones redirect)

## Context

Each research story added its own Admin view: Sources (`#/sources`), the notebook
(`#/research`), the Knowledge Atlas (`#/atlas/<id>`) and Compare (`#/compare/<id>`), plus claims
inside the draft's Evidence Studio and the citation picker inside Write. They sat as four
unrelated links in a "Research" toolbelt group that was shown only when the Evidence Studio
editor view was, so Simple and Custom layouts hid or showed research for an unrelated reason.
Nothing told an author which places were private and which would reach readers, nothing led a
first-time author from a source to a cited draft, and the Admin had no skip link and left focus
on a detached link after every route change. Story A8 next adds a draft-side research panel
(#61), a completeness review (#62) and a publication preview (#63), which need one stable place
to hang from.

## Decision

- **One destination, five panels.** The research workspace is a named Admin destination whose
  panels are listed once, in `RESEARCH_PANELS`, in the order research travels: **Workflow**,
  **Sources**, **Notebook**, **Atlas**, **Compare**. Beside them sit two entries that live in the
  draft: **Claims** (the draft's Evidence Studio, ADR 0073) and the **Draft** itself.
- **One route namespace.** Panels are `#/research/<panel>[/<item id>]`: `#/research/overview`,
  `#/research/sources`, `#/research/notebook`, `#/research/atlas/<id>` and
  `#/research/compare/<id>`, built by `researchHref`. The earlier routes redirect in place with
  `history.replaceState` (no extra history entry), keeping the item and any query:
  `#/sources`, `#/atlas/<id>` and `#/compare/<id>` go to their panels, and the bare `#/research`,
  which was the notebook's address, still opens the notebook. An unknown panel opens the
  Workflow. Claims are reached as `#/edit/<path>?pane=evidence`; `?pane=` opens any allowlisted
  editor view and is ignored otherwise.
- **The Workflow panel is the empty state.** It shows the source-to-draft path as an ordered
  list: add a source, capture a passage, optionally relate and compare, then cite it in a draft
  with the citation picker. Each step says whether it is done, from the library and the notebook,
  which are read separately so one that cannot be read is reported, with its file, in its own
  step while the others still show. It writes nothing, and the next step is the primary action.
- **Private and publishable, said in words and data.** The workspace navigation is a
  `nav` named "Research workspace" with two lists, each named by a visible label: "Private
  research" (every research panel and Claims) and "Publishable" (the Draft). Every link is
  described by its list's label through `aria-describedby`, every item carries
  `data-visibility="private|publishable"`, and the page's context bar repeats the open panel's
  visibility in a sentence. A border style (solid or double) repeats the words, never replaces
  them. "Private research" means nothing there is public merely because it exists: a source's
  reference reaches readers only when a post cites it (ADR 0044), and atlas relationships, claim
  evidence and comparisons only through their approval projections.
- **Placement follows the layout preset.** `research` joins the optional modules (the Rust and
  JavaScript preference lists), after `evidence`. Guided and Advanced show it, Simple does not,
  Custom lets the author choose, and preferences saved before it existed gain it at the end of
  their order, as every added module does. Research used to show only with Evidence Studio, so
  saved preferences that hid `evidence` and do not yet name `research` gain it hidden, in both
  the Rust and JavaScript migrations, and a custom layout looks as it did. The toolbelt gets a single **Research workspace** link
  (marked `aria-current="true"` inside the workspace, since the panel link is the current page);
  the panels are listed only in the workspace's own navigation, which is always shown on research
  panels and shown beside a draft when the preset includes the workspace or a panel holds kept
  work (ADR 0121). Every layout still reaches it: Advanced tools lists it under "Check quality and
  research", and the command palette has Research workspace, every panel and **Back to draft**.
- **Landmarks, headings and focus.** Every Admin page starts with a "Skip to main content" link
  that moves focus to `main#oba-main` itself (the hash is the router's, so it never navigates).
  The page has one `h1` in the context bar, focusable with `tabindex="-1"`; each panel's sections
  use `h2` and below. After a route change, focus moves to that heading unless the new view placed
  focus itself (the editor's writing surface, an opened atlas entry or alignment). Nothing is
  animated, and the navigation wraps so no layout scrolls sideways at 320 CSS pixels.

## Consequences

- Deep links written before the workspace keep working, and Admin now writes only canonical
  links (the notebook's concept links, the atlas's way back to the notebook, capture's "Open
  sources").
- The draft-side panel (#61) reuses `RESEARCH_PANELS`, `researchHref` and the visibility labels
  rather than defining its own list, and opens a full panel through the same routes; the
  completeness review (#62) and publication preview (#63) become further entries, so the
  navigation, palette and redirects stay in one place.
- A new research tool adds one `RESEARCH_PANELS` entry and its view; it inherits the route, the
  navigation, the private label, the palette and kept-panel behaviour.
- The Admin header now wraps at phone widths, so it no longer overflows at 320 pixels.

## Domain language

**Research workspace**, **Workspace panel**, **Workflow panel** and **Visibility label** are
defined in [`CONTEXT.md`](../../CONTEXT.md).
