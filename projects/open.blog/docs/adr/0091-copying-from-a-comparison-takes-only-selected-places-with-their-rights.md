# ADR 0091: Copying from a comparison takes only selected places, with their rights

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#54](https://github.com/journey-to-code-org/open.blog/issues/54)
- Parent story: [#22](https://github.com/journey-to-code-org/open.blog/issues/22)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0065](0065-precise-quotation-attribution-and-rights-guidance.md),
  [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md),
  [ADR 0090](0090-the-comparison-workspace-reads-one-snapshot-and-identifies-every-place.md)

## Context

Story #22 requires rights warnings that prevent accidental reproduction, and #54 requires copy
and export to respect them and an explicit selection. Rights statuses are the author's own
declarations (ADR 0085): open.blog cannot decide what a use permits, and must not turn a status
into "allowed". A copied passage that loses its version, translator, or locator is also an
attribution failure, wherever it is pasted.

## Decision

- **Explicit selection.** Each place has a labelled checkbox; nothing is preselected, and "Select
  every place" and "Clear the selection" are explicit actions. Copy and Download with nothing
  selected copy nothing, say so, and move focus to the selection.
- **Rights travel with the text.** Before copying, the selected places' versions are listed with
  their rights statements and a reminder that these are the author's statements, not permission.
  Each copied place carries its version, kind and language, maker, locator, and rights statement,
  then its original wording exactly as stored; a normalization is included only while
  normalizations are shown, and labelled. The text ends by saying it is private research and that
  open.blog does not decide what is permitted.
- **Private notes stay out unless included.** The author's own note on a place is private
  research, not part of the place's identification, so it is left out of copied and downloaded
  text by default. A labelled "Include my notes on places" checkbox, unticked on every visit, adds
  each selected place's note, labelled as the author's.
- **Confirmation where rights are unchecked or reserved.** When a selected place quotes text from
  a version whose status is `unknown` or `rightsReserved`, copying waits for a checkbox ("I have
  read the rights statements…"); any change to the selection clears it. Other statuses skip only
  that extra step; none is treated as permission. Absent places quote nothing and never ask.
- **Local and private.** Copy uses the Clipboard API; if the browser refuses, the text is shown in
  a labelled, read-only box to copy by hand. Download builds a `text/plain` file in the browser.
  Neither calls the server, writes canonical files, or stores anything in the browser, and
  nothing is published.

## Amendments

- 2026-10-26: Notes on places were copied with every selected place, which the workspace's own
  "your private research" wording contradicted. They are now left out unless the author ticks
  "Include my notes on places" (the decision above).

## Consequences

- An author cannot copy a whole comparison by accident, and every copied place stays attributed.
- The confirmation is a speed bump for the two statuses that most need one, never a permission
  gate; a later publication projection (#55) makes its own, stricter decision.

## Domain language

**Comparison export** is defined in [`CONTEXT.md`](../../CONTEXT.md).
