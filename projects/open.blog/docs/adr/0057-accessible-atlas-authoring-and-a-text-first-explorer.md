# ADR 0057: Author the Knowledge Atlas in Admin Studio as forms and explore it as text

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#50](https://github.com/journey-to-code-org/open.blog/issues/50)
- Parent story: [#21](https://github.com/journey-to-code-org/open.blog/issues/21)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0053](0053-knowledge-atlas-entries-keep-their-kind.md),
  [ADR 0054](0054-attributed-evidence-based-relationships.md),
  [ADR 0055](0055-private-knowledge-atlas-storage.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md)

## Context

ADR 0055 stored the atlas and left its Admin workspace to this slice. An atlas invites a
node-and-edge drawing, but a drawing is hard to operate from a keyboard, says little to a
screen reader, and makes it easy to show a contested link as a plain line that reads as
fact. Authors also need to edit relationships whose validity depends on entry kinds, the
source library and the notebook, without the editor offering choices the store refuses.

## Decision

- **Routes mirror the notebook's.** `GET /admin/api/research/atlas`, `POST` / `PUT` /
  `DELETE /admin/api/research/atlas/entries` and `.../relationships`, and a read-only
  `POST /admin/api/research/atlas/explore`. They sit behind the Admin session, the CSRF
  token for changes and the deny-by-default router, are `no-store`, cap a change at
  256 KiB, require the atlas revision, answer a stale revision with `409`, the latest
  revision and the stored `current` copy, and answer invalid input with `422` and the
  core's scoped diagnostics, which never repeat authored text. An id named in a removal or
  exploration request is checked as an atlas identifier before any message can name it.
  Every change goes through `atlas_store`, so its locks, revision check and atomic write
  are the only write path.
- **The server describes what may be joined.** The atlas view carries the core's table of
  relationship kinds (endpoint kinds, inverse label, symmetric, same-kind, acyclic), the
  source library for evidence and attribution, and each notebook passage's id, source,
  locators and a short preview for evidence pickers. The editor never hard-codes the rules
  it constrains pickers by, and passages are pointed to, never copied.
- **Text first, with no drawing.** The explorer is `relationships_of` served by
  `research/atlas/explore`: for one entry, outgoing and incoming relationships as lists,
  each read from that entry's side (`authored`, `authored by`), with who asserts it, its
  confidence, its derived standing, its evidence or unsourced state, its uncertainty note
  and whether the projection would include it. Each item can open the relationship or
  move to the other entry, so the whole atlas is navigable from the keyboard. Nothing is
  mirrored or inferred. A graph view, if ever added, must be an optional rendering of the
  same lists, never the only interface.
- **Contested is said in words.** Standing is shown as "Asserted; no recorded dissent" or
  "Contested: N recorded dissents (by ...)". No wording, colour or ordering presents a
  relationship as agreed, and confidence is labelled as the asserting party's.
- **Provenance or an explicit draft.** The relationship editor needs evidence from the
  library (with optional notebook passage and locators) or the "unsourced draft" box,
  which is unavailable while evidence is listed. Dissents need evidence or a note.
  Approval is a separate box whose hint repeats the core's rules. Client checks only point
  at the field to fix; the server stays authoritative.
- **Conflicts keep the draft.** Like the notebook, a `409` blocks saving until the author
  uses the stored copy or keeps the draft, which then rests on the stored copy so fields
  added elsewhere survive. A removed item can only be discarded.
- **Notebook concepts link to entries.** A note's concept links open `#/atlas/<id>`. A
  concept with no entry opens a new concept form with that identifier, and the atlas lists
  concepts notes link to that have no entry. The notebook API and file are unchanged.

## Consequences

- Admin, `openblog check` and hand edits are the three ways to change the atlas, and all
  of them are validated by the same core.
- The publication projection (#51) can reuse the explorer's `projected` flag and wording.
- A future visual graph must pass the same keyboard and screen-reader tests as the lists.
