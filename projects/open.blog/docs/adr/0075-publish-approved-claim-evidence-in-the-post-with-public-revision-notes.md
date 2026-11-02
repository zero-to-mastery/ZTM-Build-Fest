# ADR 0075: Publish approved claim evidence as a section of the post, with revision notes the post itself carries

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#47](https://github.com/journey-to-code-org/open.blog/issues/47)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0044](0044-what-a-citation-makes-public.md),
  [ADR 0048](0048-citations-publish-through-the-one-publication-projection.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0068](0068-claims-and-evidence-links-record-the-authors-reading.md),
  [ADR 0069](0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
  [ADR 0070](0070-claim-anchors-are-verified-utf8-byte-spans.md),
  [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md)
- Amends: [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md) and
  [ADR 0074](0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md) (a build now
  reads the claims file to publish it, only when the site opts in)
- Contract: [Claims and evidence links format](../specs/claims-evidence.md#publication)

## Context

ADR 0069 made approval the author's consent and fixed which links a projection may copy: a
link and its claim approved, no notebook passage, and support only while every contradicting
link on the claim is approved too. It left the projection to this task. Readers should see the
author's evidence for a claim next to the claim, with contradiction as visible as support and no
suggestion that the software judged anything. Issue #92 gives every public representation one
projection, so a native page, a portable copy, a feed and `llms.txt` can never disagree. Issue
#47 also asks for transparent revision notes, and that removing local private data never
silently deletes historical public revisions. B5.4 (#83) will publish revision notes from
reader feedback that link a claim, a date and a change; B7.1 (#88) will link interpretations to
evidence. Existing posts must publish byte for byte as before.

## Decision

- **Opt in per site, consent per item.** Publication needs `"claimEvidence": {"publish": true}`
  in `openblog.json` and approval on each claim and each link. While the switch is off (the
  default, omitted from the written configuration) no build reads the claims file and every post
  is unchanged; a project that approved items before this release publishes nothing until its
  author turns publication on. There is no per-post switch: a claim already belongs to one post,
  and its approval is consent for that post, so a third switch would add a step without adding
  consent. A post with no published claim and no revision note is published exactly as before,
  even with the switch on. (Amended by
  [ADR 0083](0083-feedback-moderation-is-version-checked-and-approved-notes-publish-from-a-versioned-file.md):
  a site that opts in to passage feedback also publishes revision notes through the evidence
  section without `claimEvidence.publish`, reading no claims file.)
- **One projection, `ClaimEvidence`, and allowlisted public types.**
  `openblog_core::claim_publication::ClaimEvidence::project` takes the validated claims file and
  the source library, and nothing else; the notebook is not an input. It copies approved claims
  and the links `ClaimSet::projected_links` returns, re-checks that no published support stands
  beside a withheld contradiction and that no link carries a passage, and refuses (naming ids)
  rather than publishing if either fails. Each post then builds a `PostEvidence` naming exactly
  what is public:
  - claim: `id`, its number and `url` (the post address and the heading's fragment),
    `statement`, `quote` (the anchored words, only while the anchor is verified against the
    post's current text, since an older draft's words are unpublished prose), `uncertainty`,
    the derived `standing`, and the three relations `supports`, `contradicts` and
    `contextualizes`, always present, each in file order;
  - link: `id`, `source`, public locators (kind, value, end), `rationale`, `confidence` and
    `uncertainty`;
  - revision note: `date`, `claim` (only while that claim is published) and `note`;
  - source: the citation allowlist of ADR 0044 (`PublicReference`) and its plain-text rendering,
    for exactly the sources published links cite.

  Visibility, review state, origin, `recordedBy`, notebook passage ids, anchor offsets, unknown
  fields at every level, private claims and links, and approved links that the projection holds
  back have no place in these types. Approving a link is consent to publish its rationale; the
  Evidence Studio checkbox says so.
- **Where it goes: a section of the post, and data.** The section is ordinary Markdown appended
  to the post's publication Markdown (ADR 0048), before any citation notes: a `Claims and
  evidence` heading, a sentence saying it records the author's reading and not whether a claim
  is true, then per claim `Claim N`, the statement, the quoted words, the uncertainty, and
  `Supporting evidence (n)` and `Contradicting evidence (n)` (and `Context (n)` when there is
  any) as lists of reference, locations, confidence, rationale and uncertainty, then `Revision
  notes`. Claims are numbered in reading order (verified anchors by position, then the rest in
  file order). Because it is the publication body, the native page, portable HTML, Markdown and
  text, RSS, JSON Feed and `llms.txt` all carry the same words, and the page needs no script, no
  component and no new stylesheet. `/claim-evidence.json` is the same values as data:
  `{"format": "openblog-claim-evidence-projection", "formatVersion": 1, "posts", "sources"}`,
  posts sorted by slug and sources by id, compact, with root-relative URLs (prefixed with a
  site's base path) and `<`, `>` and `&` escaped. It has no `version` key, so it is never
  mistaken for private research. Markers next to the claim in the running text were not added:
  inserting them would rewrite authored Markdown at byte offsets that can sit inside links, code
  or HTML; the quoted words and the heading fragment locate the claim instead.
- **Contested evidence is never consensus.** A claim with published contradiction says
  "Contested:" with both counts, kept apart; one without says that no contradicting evidence is
  published here and that this is not a statement that none exists. Nothing is netted, ranked,
  scored or labelled verified. Confidence reads as how firmly the author holds the reading.
- **Revision provenance lives in the post.** Revision notes are written in the post's own front
  matter as `evidenceRevisions`, each `YYYY-MM-DD: what changed` or `YYYY-MM-DD claim-id: what
  changed`, at most 100 notes of 200 characters (Admin's limits for a list). They are public
  author text, versioned with the post in Git, so deleting the private claims file, withdrawing a
  claim or building on CI never removes a published note; a note that names a claim no longer
  published keeps its date and text and drops the claim reference. A malformed note refuses that
  post with the item number, so a note is never dropped silently. Notes are published only while
  the switch is on. B5.4 can write notes in the same shape.
- **Withdrawal is an ordinary edit.** Clearing a claim's or a link's approval, or a
  contradicting link's, removes what depends on it from the next build. The build never writes
  the claims file. While the site publishes claim evidence, a saved Evidence Studio change
  rebuilds the site at once (under the content lock it already holds) and reports the outcome as
  `build`.
- **Fail closed.** The published Markdown is parsed again and must hold the section exactly as
  composed (headings, counts and one list item per link and note) under the last `Claims and
  evidence` heading; an unclosed code block, HTML block or comment that would swallow or reshape
  it refuses a post the load publishes and warns for a draft, a scheduled post or another
  preview document, as citations do (ADR 0049). Every portable copy (HTML, Markdown, text) must
  carry each claim's heading, contested marker and relation headings in order, or the portable
  projection refuses it (`claim-evidence-lost`). The `claim-evidence` capability is registered as
  fully portable with a `markdown-section` fallback.
- **Only a build that can read the claims file publishes evidence.** The claims file is private
  and Git-ignored. A build without one (CI, a static host) is not refused: it publishes no claims,
  still publishes the revision notes, and `build` and `check` warn, naming the file; without a
  claims file neither the library nor the notebook is read for it, so neither can refuse the
  build. A stored claims file that cannot be read or validated, or a library or notebook it
  cannot be checked against, refuses every full generation before anything is written, naming
  the file and counting problems without repeating its text; a load that only reads content (an
  Admin save, a preview) is not stopped by it.
- **Deterministic.** Nothing depends on time, locale or hash order: projection order is file
  order, posts and sources in the artifact are sorted.

## Consequences

- B5.4 (#83) can publish feedback-driven revision notes as `evidenceRevisions` items that name a
  claim, and link to the claim's `url`; nothing about a submitter has a place in a note.
- B7.1 (#88) can link interpretations to published links by `id` and must keep disagreement side
  by side as this section does.
- A post that publishes claim evidence includes the section in its search text and table of
  contents, as generated citation notes are. Its description, word count and reading time come
  from the post's own prose, which ends where the section begins, as it ends at the notes.
- The section's chrome is English, like the atlas pages; references and locators use the English
  citation strings.

## Domain language

**Claim evidence projection**, **Claim evidence publication switch** and **Evidence revision
note** are defined in [`CONTEXT.md`](../../CONTEXT.md).
