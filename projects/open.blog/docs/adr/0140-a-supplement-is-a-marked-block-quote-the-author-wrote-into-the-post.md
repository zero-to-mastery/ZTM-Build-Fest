# ADR 0140: A supplement is a marked block quote the author wrote into the post, and nothing else ever becomes one

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#68](https://github.com/journey-to-code-org/open.blog/issues/68)
- Parent story: [#26](https://github.com/journey-to-code-org/open.blog/issues/26)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0004](0004-portable-projections-from-canonical-work.md),
  [ADR 0043](0043-opt-in-citation-markdown-syntax.md),
  [ADR 0058](0058-publish-one-allowlisted-knowledge-atlas-projection.md),
  [ADR 0059](0059-published-reference-data-for-citation-previews.md)
- Amended by: [ADR 0142](0142-supplements-keep-real-headings-a-visible-boundary-and-warnings-in-every-mode.md)
- Contract: [Reading modes](../specs/reading-modes.md)

## Context

B2 lets a reader choose how much author-approved supporting context appears beside an article
without changing its words or argument. Before controls (#69), rendering (#70) or safeguards (#71)
exist, we need one meaning for "supplement": who approves it, how it is written, where it lives,
and what it can never be. The registered capability `guided-reading-supplements` already promises
that canonical prose and citations are untouched and that every supplement has a static fallback.

## Decision

- **Approval is authorship in the published post.** A supplement is text the author wrote in the
  post file they publish. There is no second store: not a sidecar, not the Knowledge Atlas, not
  the claims file, not reader notes, not a source's private notes and not AI output. A reader
  suggestion, an atlas entry or an AI draft becomes a supplement only when the author copies words
  into the post. Drafts and held-back posts publish nothing, as for every other part of a post. So
  "only author-approved content may appear in any mode" holds because nothing else can reach one.
- **Opt-in per post.** `readingModes` (or `reading_modes`) in the front matter: `true`, or a map
  `{default: standard|guided|deep-dive}` that also names the mode the post opens in (ADR 0142). The
  key is read tolerantly: `true`/`yes`/`on` and any map opt in, `false`/`no`/`off` opt out, and
  anything else is off with a warning. A map never switches the post off. Without it
  every block quote renders exactly as before, markers included, as ordinary quotes. With it but no
  markers, the HTML, text, prose and word count are byte-for-byte those of a post that never opted
  in.
- **The marker is a block quote with a first line.** `> [!supplement kind=definition level=guided]
  Optional title`, then the body in the same quote. Block quotes nest, so supplements nest. It
  reads as a quote in any Markdown reader, and in portable Markdown it stays exactly as written. It
  is the GitHub alert shape that CommonMark already renders readably. A fenced or comment marker
  would hide or garble the words in an editor that does not know it.
- **Attributes are `key=value`, case-insensitive, and unknown keys are ignored**, so a later release
  can add attributes without breaking this one. `kind` is one lowercase word with digits and hyphens
  (at most 32 characters); `level` is `guided` or `deep-dive`. Both are written at most once.
- **Kinds.** Known: `definition`, `context`, `evidence`, `relationship`, `comparison`,
  `further-reading`. Any other well-formed kind is an unknown kind: it is kept, labelled with its
  own words ("Marginalia"), shown like any supplement and never dropped. No `kind` reads as
  `supplement`. A kind is a label, not a promise: nothing infers or checks that a "definition" is
  correct, that "evidence" is strong or that "further reading" is licensed to copy.
- **Level.** When the marker writes none, `definition` and `context` are `guided` and everything
  else, including every unknown kind, is `deep-dive`, so a surprise shows least often.
- **Nesting.** Up to three deep. A supplement inside another is shown only with it, so its
  effective level is never shallower than its parent's; a marker that writes a shallower level is
  reported and the effective level is used. A level the marker left to its kind's default is not
  "written", so it is not reported.
- **A marker that cannot be read stays a plain block quote** (the author's words remain), and is
  reported as a finding naming only the start of the marker line. Each finding is added, with the
  post's path, to the warnings the build, `check` and Admin show (ADR 0142). A title over 120
  characters and a kind over 32 each have their own message and leave the marker a quote; a marker
  whose `[` is escaped (`\[!supplement`) is ordinary text and no finding. Over three levels of nesting,
  over 200 supplements, or more than 1 MiB of Markdown (for the scanner), the excess is left as
  quotes the same way. One bad marker never affects its neighbours.
- **Supplements are not the article.** Their words are in the page and in search, but are not in the
  post's prose, so the description, word count and reading time are those of the article alone.
  A heading written inside a supplement stays a real heading with its own id, but is not an entry
  of the outline and takes no slug from the post's headings, so no mode adds or removes an entry
  of the outline and no later heading is renumbered (ADR 0142).
- **Citations and footnotes inside a supplement are the post's own.** They are numbered in
  document order, published in the one reference list and checked like any other. A mode never
  changes which references exist or their numbers; it only changes whether the marker is visible.
- **Ids are positional.** `ob-supplement-N` (N the order in the document) names a place in this
  revision only, like citation marker ids (ADR 0059), and must not be stored or linked from
  elsewhere. The prefix `ob-supplement-` is reserved: a heading slug that would start with it is
  written `section-ob-supplement-...`, and an unnamed heading inside a supplement is
  `ob-supplement-N-hK`.
- **Reversible and tolerant.** Nothing is written to a data file, no hosted schema is introduced and
  nothing is published or sent anywhere. Removing the key or the markers returns the post to its
  ordinary form.

## Consequences

- Author tools (#69-#71) edit the post's Markdown, and source-mode round trips are lossless because
  the marker is the Markdown.
- A post that wants a supplement drawn from the atlas, a claim or a source links to its public page
  in ordinary Markdown; automatic embedding of those projections is not defined here.
- A site that never sets `readingModes` is unchanged.

## Domain language

**Supplement** and **Reading depth** are defined in [`CONTEXT.md`](../../CONTEXT.md).
