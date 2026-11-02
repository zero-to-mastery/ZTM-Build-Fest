# ADR 0288: A proposed voice guide is folded into the saved guide on the server, and the author decides each change

- Status: Accepted
- Date: 2026-10-29
- Parent epic: [#409](https://github.com/journey-to-code-org/open.blog/issues/409)
- Story: #423 (tasks #455, #456)
- Amends: ADR 0279 (the voice-guide task and its rendering)

## Context

Story #423 asks that "existing guide text is preserved where samples do not contradict it; contradictions are
shown, not silently applied". Before this decision the proposal replaced the saved guide. The skill told the
provider to keep every claim, but the validator refused any trait whose sample was not selected for this
request. So a provider that kept the old claims was rejected, and one that dropped them made the saved guide's
claims show only as removed lines. A guide built from more than 8 samples (the request limit, ADR 0278) could
never be refreshed without losing something, and text the author wrote outside the trait format was always lost.

Leaving the merge to the model would make it non-deterministic and impossible to check. The server already reads
the saved guide and the samples, so it can do the merge itself.

## Decision

- **The saved guide is read back on the server** (`openblog_core::voice::merge::SavedGuide::parse`). The parser
  is tolerant: the title, the provenance line, the seven fixed section headings, trait bullets in the rendered
  shape `- <statement>: "<quote>" (<file>.md)[ (one sample)]` and the items under *What is not yet known*. Every
  other line is free text: a preamble, notes under a section (a hand-written bullet included) and whole
  sections under the author's own headings.
- **A proposal only adds or changes.** A trait may carry `replaces`, the exact statement of a saved trait in the
  same section that it changes, or `null` for a new trait. A trait with the same statement as a saved trait in
  its section changes that trait even without `replaces`. A trait that repeats a saved trait exactly is
  "unchanged". The validator (`VoiceGuide::from_json_against`) still demands that a new or changed trait quotes a
  *selected* sample word for word. Only an exact repeat of a saved trait may cite a sample that was not
  selected. `replaces` must name a saved trait in that section, and no saved trait may be changed twice. The
  provider's JSON schema gains `replaces` (string or null), and the built-in skill (version 1.1.0) says to return
  only new and contradicted claims.
- **The merge is deterministic** (`merge(saved, proposal)`):
  - a saved trait the proposal does not address is **kept** word for word, in its place;
  - a changed trait stays in the saved trait's place as a **change** with both texts;
  - new traits follow the saved ones in their section;
  - free text stays where it was: the preamble under the title, section notes after the section's traits, and
    the author's own sections after the fixed sections and before *What is not yet known*;
  - unknown items are the saved ones followed by new ones not already listed.

  The same saved guide, proposal and choices always give the same bytes. A guide that was itself rendered
  reads back to the same bytes.
- **The author decides every change before saving.** The route returns `merge`: each section's traits with
  their status (`kept`, `unchanged`, `changed`, `added`), and `lines`. In `lines`, each line is text or
  `{ change, current, proposed }`. The Admin shows each change as a fieldset with **Keep current** and **Take
  proposed** side by side (stacked on a phone). It joins the server's lines with the chosen text, so it never
  renders a trait itself. Save stays disabled until every change is decided, and the editor is read-only
  until then. After that, hand edits win: a later choice does not overwrite edited text. `markdown` is `null`
  while a change is pending. `diff` compares the saved guide with the result of taking every proposed change.
- **Carried quotes are checked again, never dropped.** For every saved trait, the server re-reads the cited
  sample from either folder. The trait is marked `verified`, `not-in-sample` (the sample no longer contains
  the quote) or `sample-missing`, and the Admin shows the last two as flags. The trait is kept either way:
  removing a claim is the author's call.
- **Private provenance covers what is carried.** The proposal's sources are private when a selected sample is
  private, the saved guide is the private one, the saved guide's provenance line says `private`, or a saved
  trait cites a sample that is private now. In any of these cases `portableAllowed` is false, and the context
  save refuses a portable write (ADR 0279 amendment, unchanged). This is conservative: a changed trait whose old
  text came from a private sample still counts, even if the author takes the new text.

## Considered options

- **Let the provider return the whole merged guide.** Rejected: unverifiable, not byte stable, and the provider
  would need every old sample to pass the quote check.
- **Match changed traits by similarity of wording.** Rejected: not deterministic, and a wrong match would
  silently replace a claim. `replaces` is explicit, and an exact statement match is the only fallback.
- **Render the merge in the browser.** Rejected: two renderers would drift. The browser only picks between
  lines the server wrote.
- **Drop a kept trait whose sample was erased.** Rejected: the story says contradictions are shown and not
  silently applied. A missing sample is flagged and the author decides.

## What would trigger revisiting this

- Authors wanting a proposal to retire a saved unknown item or a claim with no replacement. Today they delete
  the line in the editor before saving.
- A trait format change. The parser reads only the rendered shape, and anything else is kept as free text.

## Consequences

- Refreshing a guide with new samples keeps everything the new samples do not touch, however many samples the
  guide was built from.
- Hand-written guide text survives a proposal.
- The provider adapters gain one field in the voice-guide schema. Results without `replaces` are still accepted.
