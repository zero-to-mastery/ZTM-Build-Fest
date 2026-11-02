# ADR 0090: The comparison workspace reads one snapshot and identifies every place

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#54](https://github.com/journey-to-code-org/open.blog/issues/54)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0084](0084-version-lineage-witness-identity-and-volumes.md),
  [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md),
  [ADR 0086](0086-attribution-uncertainty-is-explicit.md),
  [ADR 0087](0087-attributed-interpretations-live-in-the-source-library.md),
  [ADR 0088](0088-passage-alignments-record-correspondence-never-equivalence.md)
- Contract: [Passage alignments format](../specs/passage-alignments.md)

## Context

Alignments (ADR 0088) name places by identifier: a source, its locators, a notebook passage, an
interpretation. Reading them as a comparison needs the versions behind those identifiers (kind,
language, lineage, witness identity, volumes, rights, makers and their attribution certainty),
the exact quoted wording, and the interpretations with who made them. A comparison that stitched
these together from three separately loaded views could show a passage from one revision beside a
library from another, and a side-by-side layout that only worked visually would fail keyboard,
screen-reader, and phone users, and would lose who made a version once a place is read on its
own.

## Decision

- **One snapshot.** `GET /admin/api/research/alignments` (and every change, which returns the
  same view) also carries `sources` with each version's `rightsStatus` (the declared status and
  its "The author states…" label, or "Rights not checked yet") and each record's realization
  `chain`, `passages` with their exact excerpts, `interpretations` with each interpreter's
  `display` name (a contributor's registry name or the stated name), and the `correspondences`
  labels from `Correspondence::label`. All of it is read under the alignments store's snapshot,
  so the comparison and the alignments always agree. The route stays authenticated and
  `no-store`; nothing here is public.
- **A Research tool.** Admin Studio gains **Compare** (`#/compare`, `#/compare/<id>`) beside
  Notebook and Atlas, with a palette entry. It lists alignments (filterable by version) and opens
  one with a focused `h2`, its correspondence label, confidence, attribution, and the alignment
  notice.
- **Columns are versions, in the author's order.** Each version or interpretation is a section
  with an `h4`, its maker in its own role ("Translator: …", "Editor: …", "Scribe: …", or
  "Interpreted by: …" with attribution certainty, "anonymous; the source names nobody", or "not
  recorded"), its lineage, witness identity, volumes, and rights. Its places follow in member
  order; a split keeps its places in one column. Nothing is sorted, scored, or matched.
- **Every place identifies itself.** Each place repeats, in visible text, its version, kind and
  language, maker, and locator, so a place read alone, copied, or announced by a screen reader is
  never anonymous. Absent members say "Absent: this version lacks the passage." in words, and
  stale or archived members carry their notice inline.
- **Wording exactly, with its direction.** Original wording (a passage excerpt or an
  interpretation's text) is a `blockquote` with the excerpt's `lang` and a `dir` derived from the
  language tag: a script subtag decides first, then the language; a missing or malformed tag gives
  `dir="auto"`. Titles, names, and notes inside labels are `bdi`, and CSS keeps whitespace
  (`pre-wrap`) and isolates the text. Nothing normalizes, trims, or parses stored text as markup.
- **Normalization on request, labelled.** A checkbox shows the author's normalizations under the
  original, labelled "The author's normalization, not the source text". The original is always
  shown.
- **Two layouts, one reading order.** A labelled radio group switches between side by side (a CSS
  grid that wraps) and a single column (an ordered list of the same sections). Below the phone
  breakpoint the grid is one column in the same DOM order, so reflow never reorders. No visual
  alignment aid is drawn; correspondence is stated in words. The choice lasts for the visit and
  nothing is written to browser storage.
- **Editing.** Alignments and members are created and edited in a form that reuses the atlas form
  idioms: only editions, translations, and witnesses are offered as versions, choosing a passage
  fills its locators, an absent member hides locators and wording, members can be reordered with
  labelled Move up and Move down buttons, and unknown fields and evidence carry over. A stale save
  keeps the draft and offers "Use the stored copy" or "Keep my draft"; a refused save focuses the
  control the server's diagnostic names and changes nothing. Removal offers undo.

## Consequences

- The workspace is opt-in research tooling: articles, recipes, research posts, and contributor
  behavior are unchanged, and the alignments file format is unchanged.
- The view is larger (it carries the library and notebook), as the notebook view already does.
- Interpretations are shown with attribution but still edited outside Admin; their Admin
  controls, and controls for the remaining version-model fields, are left to B7.2, authoring
  interpretations in Admin Studio ([#89](https://github.com/journey-to-code-org/open.blog/issues/89)).
- Public comparison pages stay out of scope (#55).

## Domain language

**Comparison workspace** and **Place identification** are defined in
[`CONTEXT.md`](../../CONTEXT.md).
