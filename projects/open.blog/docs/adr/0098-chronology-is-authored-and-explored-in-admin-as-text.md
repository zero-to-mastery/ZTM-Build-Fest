# ADR 0098: Chronology is authored in the atlas editors and explored in Admin as text

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#58](https://github.com/journey-to-code-org/open.blog/issues/58)
- Parent story: [#23](https://github.com/journey-to-code-org/open.blog/issues/23)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0057](0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
  [ADR 0093](0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md),
  [ADR 0094](0094-temporal-relationships-are-relative-datings-never-inferred.md),
  [ADR 0095](0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md),
  [ADR 0096](0096-the-chronology-index-orders-every-dating-for-display-only.md),
  [ADR 0097](0097-chronology-prompts-are-structural-and-never-verdicts.md)
- Amends: [ADR 0095](0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md)
  (datings are no longer edited only in the file)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md#admin-api-and-workspace)

## Context

Datings could only be written by hand in the atlas file, and the chronology index and its prompts
were visible only through `openblog check`. A timeline invites a drawing: bars on an axis, zoomed
and panned with a mouse, competing dates merged into one bar or hidden behind a hover. Such a
drawing is hard to operate from a keyboard, says little to a screen reader, and flattens exactly
what the atlas keeps apart: two parties' datings of one birth, an open end, an unknown date, a
date that is known only relative to another.

## Decision

- **Datings are edited in the entry and relationship editors.** Each item's form has a Dates
  fieldset with one fieldset per dating: identifier (suggested, fixed once stored), aspect, the
  date form (at, from/to, notBefore/notAfter, unknown, relative), each point's precision (year,
  month, day, decade, century, or open for an end), its value typed as digits with a separate
  BCE/CE choice (never a minus sign), month, day, circa and calendar, the relative order, entry
  and aspect, who dates it, confidence, evidence or the unsourced draft state, a note and
  approval. A "Reads:" line gives the dating back in the core's words ("not before the 420s
  BCE") as it is typed.
- **The server describes what may be dated.** `kinds.aspects` lists each aspect's owners and
  whether it lasts, with `orders`, `maxDatings` and `maxYear`, read from the core. The aspect
  picker offers only aspects of the entry's kind (a relationship, only `span`), a duration is
  unavailable for an aspect that happens at one time, a relative dating offers only aspects the
  other entry's kind has and `during` only those that last. Client checks point at the control
  to fix; the server stays authoritative, and its diagnostics (`dates[1].date.at.year`) map to
  the matching control.
- **Lossless, and rebased by identity.** A dating keeps unknown fields on itself, its date, its
  points, its relative target, its party and its evidence. On a conflict, "Keep my draft" rests
  each dating on the newer stored dating with the same id wherever it now sits, never on the
  one at its old position; a dating removed elsewhere keeps the draft's copy; a dating added
  elsewhere joins the draft, and the author is told, so keeping a draft never drops it. Nested
  evidence keeps ADR 0057's rule (same position and same source and passage).
- **The atlas view carries the chronology index.** `GET /admin/api/research/atlas` and every
  change's response add `chronology`: `timeline` (every dating in `ChronologyIndex` order, with
  owner, collection, position, `field`, aspect, the core's `date_text`, `placement` of dated,
  relative or unknown, the first and last year it covers or null for an open end, and whether it
  would be projected), `prompts` and `unlisted`. No route is added and nothing is written.
- **The explorer is lists and words.** The Atlas view's Chronology panel lists *dated aspects*
  (one item's datings of one aspect) in an ordered list in the index's order, every competing
  dating together in one row, labelled "N competing datings, side by side. None is preferred",
  each with its party, confidence, evidence or draft state, note and visibility. Aspects with no
  absolute dating are listed apart as "Not placed in time"; relative datings are also listed as
  sentences ("Composition of Politeia: after the birth of Plato"). Each entry and relationship
  panel shows its own datings, the relative datings that point at it, and its prompts.
- **Filters never flatten.** A search, an aspect, a time window (years with BCE/CE), "only
  competing" and "only prompted" show or hide a whole dated aspect, never one of its datings: a
  competitor outside the window stays, marked "Outside the time window" in words. Zoom is a
  "Group by" select (century, decade, year, none) that heads groups by when each aspect's
  earliest dating begins, with BCE written out ("the 420s BCE"). Every control is a labelled form
  control, and a `role="status"` line states what is shown and every filter in force.
- **Prompts are listed as checks with links.** "Datings to check" lists each prompt's message
  with a button that opens the owning item and moves focus to the dating fieldset it names.
  The wording never says a dating is right, likely or agreed.
- **No drawing.** There is no canvas, SVG or bar chart, so no visual aid needs a text
  equivalent. A visual layer, if ever added, must render the same model and pass the same
  keyboard and screen-reader tests.

## Consequences

- Authors can record and review uncertain chronology without editing JSON, with the same core
  validation as `openblog check` and hand edits.
- The explorer, `check` and a future public timeline (#59) read one index, so they cannot
  disagree about order or text.
- The explorer covers private datings and is Admin-only; publication remains #59's job.
