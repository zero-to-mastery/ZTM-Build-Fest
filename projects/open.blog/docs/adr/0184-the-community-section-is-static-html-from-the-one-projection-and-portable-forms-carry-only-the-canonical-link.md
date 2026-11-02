# ADR 0184: The community section is static HTML from the one projection, and portable forms carry only the canonical link

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#230](https://github.com/journey-to-code-org/open.blog/issues/230)
- Parent story: [#205](https://github.com/journey-to-code-org/open.blog/issues/205)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0115](0115-approved-third-perspectives-publish-from-a-versioned-public-file-and-portable-copies-link-to-them.md),
  [ADR 0178](0178-withdrawal-retention-and-a-lost-source-take-a-feature-off-for-a-stated-reason.md),
  [ADR 0180](0180-a-feature-says-whose-reflection-it-is-and-why-it-is-shown-and-nothing-counts-ranks-or-claims-consensus.md),
  [ADR 0181](0181-features-publish-from-community-perspectives-json-beside-third-perspectives-json-and-read-strictly.md),
  [ADR 0182](0182-a-featured-reflection-stays-in-the-third-perspectives-list-under-its-own-anchor-and-that-lists-counts-stay.md),
  [ADR 0183](0183-admin-features-a-reflection-only-on-the-readers-agreement-and-takes-it-off-for-a-stated-reason.md)

## Context

#229 let an editor choose features and defined `resolve_post` and `project_post`. #230 shows them to readers.
The section must read as an editorial choice, never as a leaderboard or a sample of what readers think, and
must work with no script, in print, for screen readers and at 400% zoom.

## Decision

- **The build attaches features through `resolve_post`.** `Site::load` reads `community-perspectives.json`
  strictly (ADR 0181) and gives each post the features that still stand against the committed
  `third-perspectives.json` (reflection present, digest equal, not misdated, kind shown). A feature that does
  not stand is absent from the page with no mark of a gap, and is only a build warning naming the id and a fixed
  reason, never content. A post that hides Third Perspectives shows none. A site with no file, an empty file or
  no standing feature builds byte for byte as before.
- **Admin's preview is the build's value.** Both call `project_post`; a test compares the preview's JSON with the
  post's `community_features()` after choosing, and checks that the built page contains `render_section` of it.
- **One static section, after the Third Perspectives.** `community_feature::render_section` writes
  `<section id="ob-community-perspectives" aria-labelledby>` headed "Community perspectives", the fixed plural
  `NON_CONSENSUS_NOTICE` as the first paragraph, then a `<ul>` (never an `<ol>`: an order means a rank) of
  `<article id="ob-feature-<id>">`, each headed "Third Perspective from NAME, a reader" (or "from a reader"),
  marked "Chosen by the editors to feature here", with its provenance line (ADR 0180), the place it is about
  (the same line and link as the list), the prompt, the received day, the reader's words whole and escaped, the
  editors' note labelled "Note from the editors", and a link to the same reflection in the Third Perspectives,
  where it stays with its report form and any author's answer (ADR 0182). Items are in the order of the day
  featured, then id, so output is deterministic whatever the order of the file. There is no count, rank, score,
  reaction or tally anywhere, and no script, custom element or form: it is static HTML first, with no
  enhancement to fail.
- **Ids never repeat.** A feature's id is `ob-feature-<id>`; the list keeps `ob-perspective-<id>`. A test asserts
  every id on the page is unique.
- **Mixed anonymity and prompts are shown as published.** A named reader is named by the published reflection,
  an anonymous one never; each shows its own prompt or none, and nothing groups or orders by prompt.
- **Portable forms carry only the canonical link.** A featured reflection is always also in the Third
  Perspectives list, so the post keeps its existing `third-perspectives` capability and portable copies, feeds,
  search and `llms` files carry the same labelled canonical link as RD10 and none of the featured words, the note,
  an id, the notice or the section markup. A test scans every generated file other than the post's own page, and
  compares each to the build without the file. No new capability is added.
- **Style is words first.** The section is marked by headings, a border and labels that are text; the border is
  decoration. It keeps `overflow-wrap: anywhere` and `min-inline-size: 0` for 320px and 400%, avoids a break
  inside an article in print, and uses `CanvasText` borders in forced colours. Nothing moves.
- **Shared fixtures.** `tests/fixtures/community-features.json` (the notice, every reason Admin states, the notes
  the lint accepts and refuses) and `tests/fixtures/community-section.html` (the section, byte for byte) are read
  by Rust and node tests, so the two agree on one markup and one wording.

## Considered options

- **Render features inside the Third Perspectives list as a badge.** Rejected: it would make a feature look like
  a property of the reader's reflection, and a badge cannot carry the fixed notice.
- **A new `community-perspectives` capability for portable notes.** Rejected: the Third Perspectives link already
  leads to the same page, and a new capability would widen the portability registry for no new reader benefit.
- **Script that reorders or filters features.** Rejected: any order a reader controls is a ranking by interest.

## Consequences

- Taking a feature off or a reflection down changes the page at the next build; the page keeps no tombstone.
- The Admin card and banner name the "Community perspectives" section.
