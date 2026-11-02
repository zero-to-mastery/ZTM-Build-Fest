# ADR 0234: An explanation states its authors, prerequisite, modes and withdrawal, and one explanation serves every mode

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#209](https://github.com/journey-to-code-org/open.blog/issues/209)
- Parent story: [#200](https://github.com/journey-to-code-org/open.blog/issues/200)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0228](0228-an-audience-explanation-is-a-supplement-for-one-level-and-never-replaces-canonical-prose.md), [ADR 0229](0229-ai-drafts-are-labelled-by-origin-and-publish-only-with-a-persons-approval-of-the-exact-text.md)

## Decision

- **Refine the stored #88 explanation; add no second store.** Every new field is optional, so a #88 file
  (the legacy data of #31 and #88) parses, round-trips byte for byte and keeps its approvals unchanged.
  The public projection stays the one allowlisted value (ADR 0230); the new fields appear in it only when
  the file sets them.
- **Authors.** `authors` is up to 5 distinct display names. Empty means the comparison's author. The
  approver stays `approval.by`, an Admin login that never leaves the file (ADR 0229); a byline is
  author-written text and may be public. Several authors never mean several approvals.
- **Prerequisite.** `prerequisite` is one short sentence about what is useful to know first. It is
  advice shown beside the text ("You can read the article without it"), never a gate: no field hides,
  locks or orders readers, and `hides`, `hidden`, `gated` and `locked` are refused like the other
  ranking fields (ADR 0227). A level is the author's label for the text, not a reader's standing.
- **Modes without duplication.** `modes` lists the reading modes (`guided`, `deep-dive`) the explanation
  is offered in; empty means every mode that shows supplements. `standard` shows none, so it is not a
  value. The one-per-level-per-subject rule (ADR 0228) is unchanged, so serving two modes never needs
  two copies. How the page reacts to a mode is a reader-side matter for #219.
- **Translations.** `language` and `translationOf` work as they do for interpretations. A translation
  names an original explanation of the same level and subject, says its language and cannot itself be
  translated. The one-per-level rule is per language. A public translation loses its pointer while its
  original is not public.
- **Approval covers what the reader sees.** The digest additionally binds authors, prerequisite, language
  and translation link when any is set. An explanation with none of them keeps the digest it always had.
  Origin, modes and revision are labels, not the thing approved.
- **Selected revision and withdrawal.** `revision` is the author's own number for the version on view
  (informational). `withdrawn` (`at`, optional `reason`) takes an explanation out of every public output
  while keeping it in the file; it frees its level for a replacement. The reason is for the author only
  and is never projected. Revoking the approval of an AI draft withdraws it the same way (ADR 0229).
- **Nothing generated is public unprompted.** Unchanged and tested here: an AI draft with no approval, a
  stale one or a revoked one is never projected. No new generation is added.

## Consequences

- Authors can credit several people, state what helps a reader first and retire a bad explanation without
  deleting its history.
- A reader who never picks a level, mode or language reads the canonical prose unchanged.

## Domain language

**Audience explanation** is extended in [`CONTEXT.md`](../../CONTEXT.md).
