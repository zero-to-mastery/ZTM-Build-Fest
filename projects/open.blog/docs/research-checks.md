# Research checks: what each finding means and what to do

open.blog checks the structure of your research and shows what it finds in one report, the same
codes in the same order, in **What will be public** in the research workspace, in the review before
you publish a post, in the Research panel beside a draft, and in the terminal:

```sh
openblog check          # the report, after the usual checks
openblog check --json   # the same report as JSON, nothing else on standard output
openblog build          # the same report beside the build
```

Every finding is a prompt for a person. Nothing here says your research is true, complete, fair,
authoritative or ready, and a report with no findings is not praise: the checks cannot see most of
what matters about scholarship. They look at structure (is a location given, does a record point at
something that exists, is a date possible as recorded), and a person decides the rest.

## Reading a finding

Each finding names where it is, says what it found in the validator's own words, and says what to do:

```text
research detected: posts/lanterns.md:12:1: <message> Repair: <what to do> [citation-review: citation-unresolved]
```

- **Outcome.** *Detected* means a check found a definite gap in the record. *Potential* means a
  detail may be missing, though the record may simply have nothing more to say. *Needs review* means
  only you can tell, against your sources, whether it is a problem. The three are counted apart and
  never added into a total or a score.
- **Where.** A finding is about one thing: a post and line, a source, a passage, a claim, an
  evidence link, an atlas entry or a comparison, or one whole private file. Fixing that one thing
  fixes the finding, and no finding changes anything for you.
- **Nothing is filled in.** When a detail is missing the finding says it is missing and where to
  record it. open.blog never invents a DOI, a date, a translator, a location or a source to make a
  finding go away, and an imported record keeps only what the imported item stated.
- **What stops a build.** Only a failure of a private file the build reads (it cannot be read, or it
  breaks its own rules) stops the next build, and it stops it before any public file changes. Every
  other finding is yours to decide. A citation the build would refuse once its post is published only
  warns while the post is a draft.

## Acknowledging

You can **acknowledge** a finding you have considered and decided needs no change. Acknowledging:

- keeps the finding listed and counted (the counts say how many are acknowledged);
- keeps the finding open, never resolved: it marks nothing fixed, checked, verified or approved, and changes nothing public;
- stops applying, and says so, when what the finding states changes, so a changed record is
  reviewed again;
- is stored only in `.openblog/private/research/acknowledgements.json`, which names findings by
  code and place and never repeats a statement, note or excerpt.

A finding that blocks a build, or that withholds a comparison until you check it again, is fixed
rather than acknowledged.

## What stays private

The source library, notebook, claims, atlas and alignments files are private research under
`.openblog/private/`, and never reach a page, feed, export, search index or log. A finding names ids,
fields, locations and stated values, never a statement, note, excerpt, rationale or label. A build
publishes only what you approve: the public description of the references a post cites, and approved
claims, atlas entries and comparisons.

## The distinctions your records keep

The checks keep these apart so each can fail on its own:

| You record | What it is | Checked as |
| --- | --- | --- |
| Original work | The text as a work, whatever its versions | its identifiers and attribution |
| Edition | One printing or edition of a work | volumes, identifiers, rights |
| Translation | A rendering into another language | a named translator, what it is based on |
| Witness | One manuscript or copy | its repository and shelfmark |
| Reference | A place in a version | its location and volume |
| Citation | A post citing a source | resolving to a record, its location, consistency |
| Source location | A page, line, chapter or timestamp | well-formed, fits the version, precise enough |
| Research note | A private passage or note | a location for each passage |
| Claim | What a post asserts | its words are still where it was anchored |
| Evidence | A source linked to a claim | a location, a reason, a relation |
| Interpretation | Your reading or rendering | attributed, kept apart from the source text |
| Contextual entry | A person, work or concept in the atlas | possible dates, approval |

A speaker's statement (a lecture at a timestamp), the source the speaker names, the source text, your
interpretation and a scholarly disagreement are five different records, and none stands in for
another. Two passages that read alike, or two people alive at the same time, are never read as one
influencing the other: an influence is recorded only when you record it, with its evidence.

## Findings by check

### Research posts

| Code | What it means | What to do |
| --- | --- | --- |
| `doi-invalid` | The DOI field is empty or not shaped like a DOI name. A work with no DOI is fine. | Write the DOI as `10.1234/example`, or remove the field. |
| `license-url-invalid` | The license is not an absolute web address. | Write the license's full `https://` address. |
| `abstract-missing` | No top-level Abstract section. | Add an `## Abstract` section. |
| `references-missing` | No top-level References or Bibliography section. | Add a `## References` section. |
| `footnote-unresolved` | A footnote marker has no footnote. | Write the footnote or remove the marker. |
| `reference-link-review` | A reference entry has no web link. | Add a link if one exists; none may be fine, so check. |
| `doi-link-non-preferred` | A DOI link uses an old resolver. | Use the `https://doi.org/` form. |

### Citations

| Code | What it means | What to do |
| --- | --- | --- |
| `citation-syntax` | A `[@...]` bracket cannot be read. | Fix the bracket, or write `\[@` for literal text. |
| `citation-unresolved` | A key is not in your source library, or a location does not fit its source. | Add the source, or correct the key. |
| `citation-identifier-unpublished` | The only web address on a cited source is not public, so it is left out. | Record a public address, or accept that none is shown. |
| `citation-reference-incomplete` | A cited reference lacks a detail its kind usually has, such as a publisher or date. | Record it if you know it; open.blog never fills it in. |
| `citation-location-review` | A citation gives a location. Only its shape was checked. | Compare it with the source. |

### Sources and quotations

| Code | What it means | What to do |
| --- | --- | --- |
| `identifier-conflict` | One record holds two different values of one identifier scheme. | Keep the one that is right; a preprint and a published DOI are two records. |
| `identifier-shared` | Two unrelated records share a DOI or ISBN. | Decide whether they are one record, or one realizes the other. |
| `identifier-on-work` | An ISBN sits on a work whose editions are recorded. | Move it to the edition it belongs to. |
| `volume-missing` | A page or folio in a multi-volume version names no volume. | Add the volume. |
| `volume-unknown` | A volume the version does not have. | Correct the volume or the volume count. |
| `translator-missing` | A translation names no translator and is not anonymous. | Record the translator, or mark it anonymous. |
| `witness-unidentified` | A witness has no repository or shelfmark. | Record where the copy is held. |
| `version-unspecified` | A quotation cites a work whose versions are recorded. | Cite the edition or translation you read. |
| `quotation-locator-missing` | A quotation's citation gives no location. | Add the page, line or other place. |
| `quotation-location-broad` | A quotation is located only by chapter or section. | Narrow it if the version allows. |
| `passage-locator-missing` | A notebook passage has no location. | Add where it is in its source. |
| `citation-same-identifier` | A post cites two records sharing an identifier. | Cite one, or merge the records. |
| `citation-versions-mixed` | A post cites several versions of one work. | Say which you mean, or keep them if you compare them. |

### Claims and evidence

| Code | What it means | What to do |
| --- | --- | --- |
| `claim-post-missing` | A claim names a post that is not saved. | Save the post or re-point the claim. |
| `claim-anchor-moved` | The anchored words moved. | Re-anchor in Evidence Studio. |
| `claim-anchor-stale` | The anchored words are gone from the draft. | Re-anchor, or remove the claim. |
| `claim-anchor-ambiguous` | The anchored words occur more than once. | Select the one you mean. |
| `claim-suggestion-unreviewed` | A suggested claim or link is not yours yet. | Read it, then make it yours or remove it. |
| `claim-evidence-missing` | A claim has no evidence links: a gap in the record, not a judgement. | Link what you relied on, including sources that disagree. |
| `claim-support-only` | An uncertain claim whose links all support it. | Link the source of your doubt, or leave it. |
| `claim-contradiction-undiscussed` | Contradicting evidence with no note on how the post meets it. | Discuss it and record how. |
| `claim-source-archived` | A link rests on an archived source. | Restore it, relink, or remove the link. |
| `claim-passage-archived` | A link points at an archived passage. | Restore it, choose another, or remove it. |
| `claim-locator-missing` | A link names a source but no place in it. | Add the page or other place. |
| `claim-location-unreviewed` | A located link nobody recorded checking. | Compare it with the source and set its review state. |
| `claim-rationale-missing` | A link does not say why you read the source that way. | Add a rationale. |
| `undisclosed-contradiction` | Approved support sits beside a contradiction you kept private. | Approve the contradiction too, or withhold the support. |

### Atlas, chronology and context links

| Code | What it means | What to do |
| --- | --- | --- |
| `private-endpoint` | An approved link or relationship reaches something still private, so it is left out. | Approve the other end, or leave it private. |
| `unpublished-datings` | An approved entry whose datings are not approved. | Approve the datings, or publish without them. |
| `death-before-birth` | A death dated before a birth, as recorded. | Check the datings against their evidence. |
| `composition-after-death` | A work composed after its author's death, as recorded. | Check the datings and the authorship. |
| `composition-before-birth` | A work composed before its author's birth, as recorded. | Check the datings and the authorship. |
| `publication-before-composition` | A publication dated before the composition. | Check the datings. |
| `outside-lifetime` | Activity dated wholly outside a life. | Check the datings; a competing date can stay beside another. |
| `opposed-relative` | Two relative datings that cannot both hold. | Check them against the evidence. |
| `relative-cycle` | Relative datings that loop. | Check them against the evidence. |
| `relative-against-dates` | A relative dating that disagrees with absolute datings. | Check them against the evidence. |
| `context-link-unpublished` | A post links to an atlas entry or comparison the next build does not publish. | Approve the page, or remove the link. |

### Comparisons across versions

| Code | What it means | What to do |
| --- | --- | --- |
| `stale-locator` | A member's recorded place no longer matches its passage. | Check the place and update it. |
| `stale-approval` | A passage moved after you approved the comparison, so it is withheld. | Check the place, then approve again. This is fixed, not acknowledged. |
| `archived-member` | A member rests on an archived source or passage. | Restore it or replace the member. |
| `withheld-rights` | A version's rights are not declared open, so its wording stays out of a published comparison. | Declare its rights if you know them. |
| `withheld-length` | An excerpt is longer than a public comparison may quote. | Shorten the excerpt or leave it out. |

### Private files that cannot be used

When one of your private research files cannot be read, or breaks its own rules, the finding names
that one file and nothing is repaired for you. Fix the file by hand. A finding here refuses the next
build, before anything public changes, only when the build reads that file: the library and notebook
whenever the build reads any research, the atlas while `knowledgeAtlas.publish` is on, the claims
file while `claimEvidence.publish` is on, the alignments while `comparisons.publish` is on, and the
curated selections while `curatedContext.publish` is on. When the build does not read a file,
`openblog check` still reports it, and the report says the part that depends on it was not reviewed.
These codes appear for the source library, notebook, atlas, claims and alignments files alike unless a
row says otherwise. The curated selections file reports only `file-unreadable` here: a selection that
is withdrawn, stale, missing or cyclic is your own state, listed with its reason in What will be public
and never acknowledged (see [ADR 0191](adr/0191-a-damaged-selections-file-refuses-a-full-build-and-withheld-selections-have-no-rows-to-acknowledge.md)).

| Code | What it means |
| --- | --- |
| `file-unreadable` | The file cannot be read at all. |
| `too-large` | The file is larger than the limit. |
| `invalid-json` | The file is not valid JSON. |
| `unsupported-version` | The file is from a newer version than this one reads. |
| `missing-field` | A record lacks a required field. |
| `invalid-field` | A field has the wrong shape or text. |
| `invalid-id` | An id is not a lowercase slug. |
| `duplicate-id` | Two records share an id. |
| `unknown-source` | A record names a source the library does not hold. |
| `unknown-passage` | A record names a notebook passage that does not exist. |
| `unknown-entry` | A record names an entry that does not exist (an atlas entry, or a note when removing). |
| `unknown-kind` | A kind, or an attribution kind, is not one of the known ones. |
| `unknown-locator-kind` | A location uses a kind that is not known. |
| `invalid-locator` | A location is malformed or repeated. |
| `ambiguous-locator` | A location cannot address that record, such as a page of a whole work. |
| `contributor-credit` | A record carries credit fields, which belong in `.credits.json` sidecars. |
| `invalid-visibility` | A visibility is neither private nor approved. |
| `private-reference` | An approved record points at something private. |
| `missing-evidence` | A relationship or link cites no evidence and is not marked as an unsourced draft. |
| `shadowed-field` | An unknown field reuses the name of a defined one. |
| `duplicate-link` | Two evidence links on a claim cite the same evidence. |
| `unknown-post` | A claim's anchor names a post that is not saved. |
| `stale-anchor`, `ambiguous-anchor`, `anchor-mismatch` | A claim's anchor no longer fits its saved draft, or its offsets do not match its words. |
| `unresolved-relationship`, `invalid-relationship`, `ambiguous-relationship` | A source's `of`, `basedOn` or `revises` points nowhere, at the wrong kind, or across works. |
| `relationship-cycle`, `cycle` | Sources or atlas relationships that loop. |
| `ambiguous-location` | A reference's page or volume does not fit the version it points at. |
| `invalid-identifier` | A DOI, ISBN or other identifier is not well formed. |
| `conflicting-attribution` | A source marked anonymous also names a maker. |
| `not-private`, `reader-feedback` | A notebook entry is marked public, or holds reader feedback. |
| `endpoint-kind`, `wrong-source-kind`, `self-relationship`, `duplicate-relationship` | An atlas relationship or comparison joins the wrong kinds, a thing to itself, or repeats one. |
| `evidence-conflict` | An atlas relationship both cites evidence and is marked unsourced. |
| `invalid-date`, `aspect-kind`, `duplicate-dating` | A dating is impossible, belongs to another kind of entry, or repeats one party's date. |
| `unknown-interpretation`, `duplicate-member`, `conflicting-member`, `missing-counterpart`, `missing-locator`, `missing-original` | A comparison member names a missing interpretation, repeats itself, contradicts another member, lacks a counterpart or a place, or normalizes wording with no original. |

### Changes that are refused

These do not describe a file. They are the reasons Admin refuses a change you asked for, before it is
saved, so nothing is written and no build is refused.

| Code | What it means |
| --- | --- |
| `still-linked`, `still-used` | You tried to remove something other records still rest on. |
| `kind-changed`, `source-changed` | You tried to change what a record is, or which source a passage quotes. |
| `unknown-link`, `unknown-claim`, `unknown-alignment` | A change names a link, claim or comparison that does not exist. |

## Importing sources

Importing CSL JSON (for example from Zotero) shows a preview first. Each item keeps a stable id made
from its own id, the preview lists every field the library cannot hold, and private abstracts and
notes are never imported. A bare item stays bare: importing never adds a DOI, date or creator, and
importing the same file twice changes nothing. What an item lacks is then named by the checks above.

## See also

- [Research posts and Evidence Studio](research-profile.md) for the research profile and citations.
- [Claims and evidence links](specs/claims-evidence.md), [the research notebook](specs/research-notebook.md),
  [the source library](specs/research-source-library.md),
  [the Knowledge Atlas](specs/knowledge-atlas.md) and
  [passage alignments](specs/passage-alignments.md) for each file's format.
- [ADR 0146](adr/0146-one-research-completeness-contract-with-one-owner-per-check.md) and
  [ADR 0147](adr/0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md)
  for the contract behind the report.
