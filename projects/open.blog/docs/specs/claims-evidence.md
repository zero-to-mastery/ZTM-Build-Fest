# Claims and evidence links format

Private claims in draft posts and the author's evidence links, owned by
`openblog_core::claims` and stored in `.openblog/private/research/claims.json`. Decisions:
[ADR 0068](../adr/0068-claims-and-evidence-links-record-the-authors-reading.md),
[ADR 0069](../adr/0069-contradicting-evidence-is-never-hidden-or-published-alone.md),
[ADR 0070](../adr/0070-claim-anchors-are-verified-utf8-byte-spans.md),
[ADR 0071](../adr/0071-private-claims-storage-checked-against-the-saved-draft.md),
[ADR 0072](../adr/0072-claims-take-their-lock-after-the-atlas-and-guard-their-sources.md) and
[ADR 0073](../adr/0073-claims-are-authored-from-a-selection-in-evidence-studio.md), with
evidence-gap findings in
[ADR 0074](../adr/0074-evidence-gaps-are-prompts-in-the-shared-finding-contract.md), and its
publication in
[ADR 0075](../adr/0075-publish-approved-claim-evidence-in-the-post-with-public-revision-notes.md).
The file itself never reaches a public page, feed, export or search index; only the
[publication](#publication) copies approved items, and only when the site opts in.

```json
{
  "version": 1,
  "claims": [
    { "id": "c1", "post": "on-caves", "statement": "The cave is an allegory of education.",
      "anchor": { "start": 120, "end": 158, "text": "the cave is an allegory of education." },
      "uncertainty": "Readers disagree about scope.", "visibility": "private" }
  ],
  "links": [
    { "id": "l1", "claim": "c1", "relation": "supports",
      "evidence": { "source": "republic-slings", "passage": "p-cave",
                    "locators": [{ "kind": "page", "value": "514" }] },
      "rationale": "Socrates says so directly.", "confidence": "plausible",
      "reviewState": "location-checked", "recordedBy": { "kind": "author" },
      "origin": "authored", "visibility": "private" }
  ]
}
```

- **Relations:** `supports`, `contradicts`, `contextualizes`; required, never defaulted.
- **Defaults written:** `visibility` private, `confidence` tentative, `reviewState` unreviewed,
  `origin` authored, `recordedBy` author.
- **Evidence** is the [Knowledge Atlas](knowledge-atlas.md) evidence object.
- **Anchors** are UTF-8 byte offsets into the post's anchor text: the body after a leading
  byte-order mark and the front matter are removed, with CRLF folded to LF and then any leading
  line breaks dropped (`claims::anchor_text`), so a hand-written post and the same post saved by
  Admin (which writes one blank line after the front matter) index the same text. `text` is the exact span and keeps `\n` only. A check reports
  `verified`, `moved` (exactly one occurrence elsewhere, overlapping occurrences counted),
  `stale` or `ambiguous`, and never rewrites the anchor.
- **Refused:** unknown source, passage from another source, ambiguous locator, unknown claim,
  duplicate link, duplicate id, contributor credits, an approved link with a private passage,
  approving an unreviewed suggestion, oversized or hostile text (control or bidi characters),
  unsupported version.
- **Projected, not refused:** a link reaches public output only when it and its claim are
  approved, it has no passage, and, for `supports`, every contradicting link on the claim is
  approved. An approved link on a private claim (`private-endpoint`) and approved support beside a
  private contradiction (`undisclosed-contradiction`) are valid, stay private, and are reported as
  non-blocking notices, so withdrawing consent is never refused.
- **Saving through Admin:** a new or changed anchor must be verified against the post's saved
  draft (`stale-anchor`, `ambiguous-anchor`, `anchor-mismatch` for moved words, `unknown-post`).
  A link cannot be added or changed while its claim's anchor is stale or ambiguous; removing a
  link and withdrawing its approval are always allowed. Every change names the file's revision.
- **Guards:** a source or notebook passage an evidence link uses cannot be removed, and a
  library or notebook change that would leave the file invalid is refused. Locks are taken in
  the order atlas, claims, notebook, library.
- **Evidence gaps and prompts** (`openblog_core::claim_review`) are `EvidenceFinding`s, the
  citation checks' contract, with `object: {claim, link?}`: `claim-post-missing`,
  `claim-anchor-moved`, `claim-anchor-stale`, `claim-anchor-ambiguous` (detected);
  `claim-evidence-missing`, `claim-locator-missing`, `claim-rationale-missing` (potential);
  `claim-suggestion-unreviewed`, `claim-support-only` (an uncertain claim with only supporting
  links), `claim-contradiction-undiscussed` (contradicting links, no uncertainty note),
  `claim-source-archived`, `claim-passage-archived`, `claim-location-unreviewed` (needs review).
  Claims in file order, each followed by its links; `path` is the post (or the claims file when
  the post is missing) and `field` the record and property, such as `links[l1].rationale`.
  Findings name ids only, never say whether anything is true, and are identical in
  `openblog check`, build output (stderr only) and Evidence Studio.
- **Never present:** truth value, score, net result, verified state.
- **Limits:** 4 MiB file, 20,000 claims, 100,000 links, statements 2,000 characters, rationale
  4,000.

## Publication

With `"claimEvidence": {"publish": true}` in `openblog.json`, a build reads the claims file and
publishes the claim evidence projection (`openblog_core::claim_publication`). Off (the default),
no build reads it and every post is unchanged.

- **What is public:** for each approved claim, its `statement`, `uncertainty`, the anchored words
  (only while the anchor is verified against the post's current text), its `standing`
  (`contested` when contradicting evidence is published, otherwise `asserted`) and its projected
  links grouped as `supports`, `contradicts` and `contextualizes`, each in file order; for each
  link, `source`, public locators (`kind`, `value`, `to`), `rationale`, `confidence` and
  `uncertainty`; for each cited source, its public reference description. Visibility, review
  state, origin, `recordedBy`, passages, anchor offsets and unknown fields are never public.
- **Where:** a `Claims and evidence` section at the end of the post's publication Markdown, before
  any citation notes, so the page, portable copies, feeds and `llms.txt` show the same text, and
  `/claim-evidence.json`:

  ```json
  {"format": "openblog-claim-evidence-projection", "formatVersion": 1,
   "posts": [{"slug": "cave", "url": "/posts/cave/", "title": "The cave",
     "claims": [{"id": "c1", "number": 1, "url": "/posts/cave/#claim-1",
       "statement": "The cave is an allegory of education.",
       "quote": "the cave is an allegory of education.", "standing": "contested",
       "supports": [{"id": "l1", "source": "republic-slings",
         "locators": [{"kind": "page", "value": "514"}], "rationale": "Socrates says so directly.",
         "confidence": "plausible"}],
       "contradicts": [{"id": "l2", "source": "critic", "confidence": "tentative"}],
       "contextualizes": []}],
     "revisions": [{"date": "2026-10-21", "claim": "c1", "note": "Added a contrary reading."}]}],
   "sources": [{"key": "critic", "kind": "work", "title": "A Critic", "text": "A Critic"}]}
  ```

- **Revision notes** are written in the post's front matter, never in the claims file:

  ```yaml
  evidenceRevisions:
    - "2026-10-20: First published with evidence."
    - "2026-10-21 c1: Added a contrary reading."
  ```

  Each is `YYYY-MM-DD: note` or `YYYY-MM-DD claim-id: note`, at most 100 notes of 200
  characters, sorted by date. A note naming a claim that is not published keeps its date and text
  without the claim. A malformed note refuses the post, naming the item. A site that takes
  passage feedback (`engagement.feedback`) publishes revision notes in this section even while
  `claimEvidence.publish` is off, without reading any claims file, and Admin's Moderation inbox
  can add a note after a reader's suggestion led to a change (ADR 0083).
- **Refused, not published partly:** a post whose body would swallow the section (an unclosed
  code block, HTML block or comment), and any portable copy that does not carry every claim's
  heading, contested marker and relation headings in order. A claims file, library or notebook
  that cannot be read refuses the build, naming the file.
- **No claims file** (a CI or static-host build): no claim is published, revision notes still
  are, and `build` and `check` warn.
