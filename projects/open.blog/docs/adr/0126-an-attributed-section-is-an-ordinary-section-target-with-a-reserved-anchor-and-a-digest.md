# ADR 0126: An attributed section is an ordinary Third Perspective section target with a reserved anchor and the digest of its text

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#212](https://github.com/journey-to-code-org/open.blog/issues/212)
- Parent story: [#202](https://github.com/journey-to-code-org/open.blog/issues/202)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0030](0030-one-deterministic-reading-order.md),
  [ADR 0033](0033-portable-equivalents-of-every-reflection-layout.md),
  [ADR 0076](0076-passage-targets-are-section-anchors-with-quoted-context.md),
  [ADR 0109](0109-third-perspectives-are-reader-reflections-with-optional-prompts-and-four-distinct-stages.md),
  [ADR 0112](0112-third-perspective-shapes-map-onto-b5-and-rd12-at-merge.md)

## Context

A shared reflection publishes each author's text as a turn under that author's name. RD10 lets a
reader write a Third Perspective about "one section" using a heading id. A turn is raw markup with
no heading id, and a heading id made from text or position changes when authors reorder, add or
rename things, so a reader's note could end up under the wrong author. Layouts also place turns in
columns or lanes, so any "left author" or "right author" is a property of CSS, not of the work.

## Decision

- **The target names the author, not a position on screen.** An attributed target is the author's
  public contributor id (the registry key the post's committed credits sidecar already names, never
  a name, an account or a participant id), the zero-based place `nth` among that author's sections
  in reading order, and the digest of the section's normalized text. Nothing about layout, lane, side or column is part of
  it, and the same sections are found whichever of the five layouts a post is published in.
- **It is stored as an ordinary RD10 section target**, so no schema, file or column changes and
  every stored Third Perspective, every projection and every reader of one keeps working: the
  section is the reserved anchor `ob-by-{contributor}-{nth}`, the selector is B5's section
  selector, and the digest is required. The digest is the same Blake2s construction as B5's section
  digest but under its own label, `openblog-attributed-section-v1`, so it never equals the digest
  of a heading section with the same words. A reserved anchor that is not written exactly so (the
  contributor id lowercase as a registry key is, `nth` canonical), or that has no digest, is
  refused. A target that is not attributed (the whole work, an ordinary heading
  id) keeps RD10's meaning unchanged.
- **The sections as published come from committed public content alone**, never from drafts or the
  private publication record: `AttributedSections::from_published(body, credits)` reads the
  arranged reflection back (ADR 0033) and the post's credits sidecar. The sidecar lists each
  contributor once, in order of first appearance (ADR 0030), so the k-th distinct author name in
  the body is the k-th credit; each turn takes that credit's registry key and its Markdown is
  digested exactly. No name is compared with any record, so a static or CI build (where private
  records are absent) resolves the same as Admin, a person invited later under the same name
  changes nothing, and a look-alike name (including a Unicode one) cannot move a section. If the
  credits do not pair one to one with the body's distinct names (two authors sharing a name, a
  missing or unreadable sidecar, a hand-edited body), or the post is not an arranged reflection,
  no section is attributed: fail closed, nothing is guessed. The author a page shows for a section
  is what the published body says, so a coordinator who edits the committed body edits that. No new
  output is needed for existing posts: the sidecar is already written and committed. Quotations
  stay B5's passage feedback and are not attributed targets (RD10 already refuses them).
- **`ob-by-` is reserved in headings.** `assign_heading_ids` never gives a heading an id that starts
  with it: a generated slug that would (a heading beginning "OB by ...") is prefixed `heading-`, and
  an id the author writes in that space (`{#ob-by-...}`) is replaced by the heading's own slug. This
  is a known change to the id of such a heading; no fixture or example in this repository has one,
  and the CHANGELOG records it. Raw HTML `id` attributes are not rewritten: a section is attributed
  only if the body parses as an arrangement and the credits pair with it, so a hand-written id
  attributes nothing.
- **Conversation items are not attributed targets.** "Speaking for A, B" items have positional ids
  and several authors; a reader answers them through the whole-work target. Revisit when they gain
  stable ids.

## Consequences

- The renderer (#224) gives each author section the anchor this ADR defines; until then the
  contract exists in core and existing posts publish byte for byte as before, apart from the
  reserved-id change above.
- The anchor carries a registry key that is already public in the committed sidecar. It carries no
  participant number, so it does not reveal how many editors, readers or other participants a
  publication has.

Amended by [ADR 0136](0136-a-section-states-its-contributor-and-credits-that-drift-attribute-nothing.md): the k-th name is also required to be the k-th credit's registry name (older bodies) or to state that credit's key itself (bound bodies), so credits edited after publication attribute nothing.
