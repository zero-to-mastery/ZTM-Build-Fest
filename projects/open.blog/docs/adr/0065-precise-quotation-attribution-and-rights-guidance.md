# ADR 0065: Precise quotation attribution and rights guidance that never judges

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#176](https://github.com/journey-to-code-org/open.blog/issues/176)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0008](0008-public-source-attribution.md),
  [ADR 0062](0062-media-moments-locate-attributed-quotations-and-observations.md),
  [ADR 0063](0063-media-moments-stay-private-until-revealed-and-bind-into-approval.md),
  [ADR 0064](0064-capturing-media-moments-in-admin-studio.md)

## Context

A moment quotation already keeps its speaker, its rights status and its provenance apart (ADR
0062), but each view credited it in its own way: the panel said "Said by …", the preview put the
speaker in a footer, and neither named the source and the time together. The rights status was a
bare label. Contributors need every quotation credited the same, precise way, and help with the
status they choose, without open.blog ever implying that a use is permitted or that a quotation
is accurate. Copyright determination and plagiarism detection are out of scope.

## Decision

- **One attribution, built in core.** `Moment::attribution(sources)` returns the speaker (when the
  quotation names one), the source's title and kind from the record as it is now (never a copy),
  and the location (`location_text`). `MomentAttribution::text` is the one line every view shows:
  - "The host, in Episode 4 (Podcast), from 1:02 to 1:10";
  - "Episode 4 (Podcast), from 1:02 to 1:10" when no speaker is named;
  - "a source that is no longer listed" in place of the source when it is gone.

  Correcting a source corrects every attribution. The moments routes send the line as
  `attribution`; the panel shows it as the quotation's caption, and the combined preview renders
  the quotation as a `figure` with the words in a `blockquote` (carrying the quotation's language
  as `lang`) and the line as its `figcaption`. Public output (#177) uses the same line.
- **Rights guidance is the participant's statement explained, never a ruling.** Each
  `QuotationRights` value has a short `label` and neutral `guidance` that says what the participant
  is stating and what helps co-authors review it, such as naming who agreed or which licence
  applies. `RIGHTS_STATEMENT` goes with every status: the status is the participant's own
  statement, and open.blog neither checks rights nor decides how the words may be used. No label,
  guidance or warning says that a use is fair, allowed, permitted or cleared; tests guard the
  wording in core and in the panel.
- **Warnings advise and never block.** `Quotation::notices` returns, in a fixed order:
  - `noSpeaker` when no speaker is named, so the words are credited to the source alone;
  - `long` when the quotation is longer than `BRIEF_QUOTATION_CHARS` (300) characters, or
    `longForBriefQuotation` instead when its status is a brief quotation.

  Length is counted in Unicode characters, newlines included, exactly as the 1,000-character limit
  counts. 300 is a guide to quoting only what a point needs, not a legal line. No warning judges
  whether the words are accurate or true. A warned quotation saves, can be proposed for the piece
  and can be approved and published; only `unknown` rights still keep a quotation out of the piece
  (ADR 0062).
- **A rights note.** A quotation may carry `rightsNote`: one line of plain text, at most 500 bytes,
  without surrounding spaces, control, line-break or direction-override characters. The
  participant uses it to record such things as who gave permission and when, or the licence's
  name. It is part of the moment's content, so it is covered by the seal and the approval binding.
  It is hashed only when present, so quotations without a note keep their existing digests. It is
  shown to the owner and, once revealed, to co-authors for review, and it is never published:
  public output credits the speaker, the source and the location only. This is the conservative
  choice; showing a licence publicly can be decided later, per status, in #177.
- **One guide for every view.** The moments routes send `quotationGuide`, built from the core
  definitions: the thresholds, the statement, each status's label and guidance, and each warning's
  message. The panel's live guidance and warnings come from it, so the panel says exactly what the
  preview says. Without a guide (an older server), the panel shows no warnings rather than
  guessing.
- **The panel.** The rights select is labelled "Rights (your statement)" and described by a
  polite live region that shows the chosen status's guidance and the statement. The quotation
  shows a character count and a polite live list of warnings that is updated only when the
  warnings change, so typing does not flood a screen reader. Each listed moment, the writer's own
  or one another author revealed, shows the attribution caption, the rights statement attributed
  to whoever made it ("as you state them", "as Grace states them"), the rights note and the
  warnings, all as text.
- **Nothing is fetched.** Guidance never looks up a source, a licence, a transcript or a
  quotation's text. The panel calls only the Admin API, and the preview has no network access.

## Consequences

- The quotation text, speaker, rights note and source title are untrusted or site text; every view
  escapes them, and a hostile value shows as text.
- The preview shows each quotation's rights statement, guidance and warnings so co-authors can
  review them before approving. They are review aids in an unpublished document and never reach a
  public page, feed or export.
- Warnings depend only on the quotation, so they read the same for the owner and for co-authors,
  and a warning never makes a preview incomplete or withholds an approval token.
- Choosing a different threshold later changes advice only; nothing stored depends on it.

## Domain language

**Quotation attribution**, **Rights guidance**, **Rights note** and **Quotation warning** are
defined in [`CONTEXT.md`](../../CONTEXT.md).
