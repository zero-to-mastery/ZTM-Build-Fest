# Knowledge Atlas format

The private Knowledge Atlas holds contextual entries and the attributed relationships between
them. It is owned by `openblog_core::knowledge_atlas` and stored by the CLI's `atlas_store`;
decisions are in [ADR 0053](../adr/0053-knowledge-atlas-entries-keep-their-kind.md),
[ADR 0054](../adr/0054-attributed-evidence-based-relationships.md),
[ADR 0055](../adr/0055-private-knowledge-atlas-storage.md),
[ADR 0056](../adr/0056-one-lock-order-and-cross-store-research-guards.md) and
[ADR 0057](../adr/0057-accessible-atlas-authoring-and-a-text-first-explorer.md),
[ADR 0058](../adr/0058-publish-one-allowlisted-knowledge-atlas-projection.md), and, for
[chronology](#chronology),
[ADR 0093](../adr/0093-uncertain-dates-are-attributed-datings-at-their-stated-precision.md),
[ADR 0094](../adr/0094-temporal-relationships-are-relative-datings-never-inferred.md) and
[ADR 0095](../adr/0095-atlas-version-2-supersedes-bounds-and-keeps-datings-private.md). Nothing in it
reaches a public page, feed, search index, `llms.txt` or export except through the
[publication projection](#publication), which copies approved items only when the site opts in.

```json
{
  "version": 2,
  "entries": [
    { "id": "plato", "kind": "person", "label": "Plato", "aliases": ["Πλάτων"],
      "dates": [
        { "id": "plato-born-dl", "aspect": "birth",
          "date": { "at": { "year": -428, "circa": true } },
          "assertedBy": { "kind": "source", "source": "diogenes" },
          "evidence": [{ "source": "diogenes", "locators": [{ "kind": "canonical", "value": "3.2" }] }] },
        { "id": "plato-born-nails", "aspect": "birth",
          "date": { "notBefore": { "year": -424 }, "notAfter": { "year": -423 } },
          "assertedBy": { "kind": "source", "source": "nails-2002" },
          "evidence": [{ "source": "nails-2002" }], "confidence": "plausible" }
      ] },
    { "id": "republic", "kind": "work", "label": "Republic", "source": "plato-republic",
      "dates": [
        { "id": "republic-after-phaedo", "aspect": "composition",
          "date": { "relative": { "order": "after", "entry": "phaedo", "aspect": "composition" } },
          "assertedBy": { "kind": "author" }, "unsourced": true }
      ] },
    { "id": "phaedo", "kind": "work", "label": "Phaedo" },
    { "id": "allegory", "kind": "concept", "label": "Allegory" }
  ],
  "relationships": [
    { "id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
      "assertedBy": { "kind": "source", "source": "scholar-book" },
      "confidence": "plausible",
      "evidence": [{ "source": "republic-slings", "locators": [{ "kind": "page", "value": "514" }] }],
      "uncertainty": "Authorship of some dialogues is disputed.",
      "contestedBy": [{ "by": { "kind": "named", "name": "Another reading" }, "note": "Dates it later." }] }
  ]
}
```

## Entries

`id` (slug, shared with relationships), `kind` (`person`, `work`, `concept`, `movement`,
`event`), `label` (at most 200 characters), optional `aliases` (20), `summary` (the author's
prose, 20,000 characters), `source` (work entries only; a source-library record of kind
`work`), `dates` (attributed datings, see [Chronology](#chronology)), and `visibility`
(`private` default, or `approved`). Version 1's `bounds` is refused in version 2. A notebook note's `concepts` id resolves to the concept
entry with the same id; an unresolved id is reported, not an error. Removing an entry is
refused while a relationship joins it; removing a concept that notes link to is allowed and
reports those notes, whose links are now unresolved.

## Relationships

`id`, `kind`, `from`, `to`, `assertedBy`, optional `confidence` (`tentative` default,
`plausible`, `strong`), `evidence`, `unsourced`, `uncertainty`, `contestedBy`, `dates` (`span`
datings of when the relationship held), `visibility`.

| kind | from | to | notes |
| --- | --- | --- | --- |
| `authored` | person | work | read back as "authored by" |
| `influenced` | any | any | needs evidence unless an unsourced draft |
| `responds-to` | person, work | person, work, movement, concept, event | |
| `disputes` | person, work, movement | person, work, movement, concept | |
| `member-of` | person | movement | |
| `participated-in` | person, movement | event | |
| `developed` | person, movement | concept | |
| `exemplifies` | work | concept, movement | |
| `discusses` | work | any | |
| `part-of` | work, concept, movement, event | same kind | acyclic |
| `specializes` | concept | concept | acyclic |
| `related-to` | any | any | symmetric |

`assertedBy` and each `contestedBy[].by` is `{"kind": "author"}`, `{"kind": "source",
"source": id}` or `{"kind": "named", "name": text}`. `evidence[]` is `{"source": id,
"locators": [...], "passage": id?}` using the notebook's locator format. A relationship needs
evidence or `"unsourced": true`, never both. An approved relationship needs evidence and no
`passage` pointer; otherwise it is refused. It reaches the publication projection only when
both entries it joins are approved too. If either is private the relationship stays private
and `Atlas::notices` reports a non-blocking `private-endpoint` notice, so withdrawing an
entry's approval never makes the atlas invalid.

Unknown fields are preserved at every level; contributor credit fields are refused; diagnostics
are scoped to collection, index, id and field and never repeat authored text.

## Chronology

Owned by `openblog_core::chronology`. An entry's or relationship's `dates` hold at most 20
**datings**, each one party's claim about when one aspect happened. Nothing converts calendars,
reconciles datings, or infers a date, an order or a relationship from another date.

| Field | Rule |
| --- | --- |
| `id` | A slug in the atlas's one identifier space (entries, relationships and datings). |
| `aspect` | See the table below. |
| `date` | Exactly one form, below. |
| `assertedBy` | The atlas attribution: `author`, `source` or `named`. |
| `confidence` | `tentative` (default), `plausible` or `strong`: how firmly that party holds it. |
| `evidence` / `unsourced` | Atlas evidence, or `"unsourced": true`; never both. Unsourced cannot be `strong` or `approved`. |
| `note` | Optional, 2,000 characters: doubt, or how the party reckons the date. |
| `visibility` | `private` (default) or `approved`; approved needs evidence and no `passage`. |

| aspect | applies to | lasts |
| --- | --- | --- |
| `span` | every entry; the only aspect of a relationship | yes |
| `birth`, `death` | person | no |
| `active` | person, movement | yes |
| `composition` | work | yes |
| `publication` | work | no |
| `emergence` | concept, movement | no |

| Form | Meaning |
| --- | --- |
| `{"at": P}` | At one point, at that point's precision. |
| `{"from": P, "to": P}` | A duration, either end open; only for an aspect that lasts. |
| `{"notBefore": P, "notAfter": P}` | Some time inside an inclusive window, either end open ("after", "before"). |
| `{"unknown": true}` | The party says the date is unknown. |
| `{"relative": {"order": o, "entry": id, "aspect": a}}` | Before, after or during (`o`) another entry's aspect; `during` needs an aspect that lasts. |

A point `P` is exactly one of `{"year": Y}` (optionally `month` 1–12, and `day` only with a
month), `{"decade": D}` (`1380` is 1380–1389, `-380` is 389–380 BCE; a non-zero multiple of 10)
or `{"century": C}` (`-4` is 400–301 BCE), plus optional `"circa": true` and, only with a month,
`"calendar": "gregorian"` or `"julian"`. Years are historical: negative is BCE, there is no
year 0 (1 BCE, `-1`, is followed by 1 CE, `1`), and magnitudes stay within 100,000. A start
that begins after its end ends is refused; months and days are compared only when both points
state the same calendar (or neither), otherwise years are. February may have 29 days.

Any number of datings may date one aspect (competing datings); only the same party giving the
same date for the same aspect twice is refused (`duplicate-dating`). A relative dating's entry
must exist and have the aspect, and cannot be the aspect being dated; opposed relative datings
are valid. Datings never create or support a relationship, and `Atlas::relationships_of` is
unchanged by them; `Atlas::datings_of` lists an entry's datings and the relative datings that
point at it. `DateExpr::key` orders absolute datings by their earliest and latest stated day
(open start first, open end last), then relative datings, then unknown ones;
`chronology::chronological` breaks ties by id. Order is for display only.

A dating is projected (`Atlas::is_dating_projected`, `Atlas::projected_datings`) only when it is
approved and cited with no passage, its entry is approved or its relationship is projected, and
the entry a relative dating points at is approved. Otherwise it stays private, with a
non-blocking `private-endpoint` notice. Projected datings are published with the atlas
([Publication](#publication)). An approved entry that
carries datings none of which may be projected (every approved entry that had version 1 `bounds`)
gets an `unpublished-datings` notice, and a build that publishes the atlas warns, naming those
entries and their dating counts, since their years are missing from public output. A dating's sources
and passages count as uses, so removing them from the library or notebook is refused.

**Version 1.** A `"version": 1` atlas is read as version 2 and written as version 2 by the next
accepted change; reading never writes. Each entry's `bounds` with a year becomes a dating
`<id>-span` (or the first free `-span-N`) of aspect `span`, `{"from": {"year": F}, "to":
{"year": U}}` with the stored years, by the author, `unsourced` and `private`; unknown fields
inside `bounds` move to `boundsExtra` on that dating (or the entry, if no year was stated). A
version 1 item that already uses `dates` is refused until renamed.

### Chronology index and prompts

Owned by `openblog_core::chronology_index` ([ADR 0096](../adr/0096-the-chronology-index-orders-every-dating-for-display-only.md),
[ADR 0097](../adr/0097-chronology-prompts-are-structural-and-never-verdicts.md)).
`ChronologyIndex::of(&atlas)` reads a valid atlas, never fails and never writes. It indexes every
dating, private or approved, by id; `by_owner` (each entry's or relationship's datings by aspect,
competing datings side by side, `competing(owner, aspect)`), `by_aspect`, `by_time` (one
timeline) and `relative_to` (relative datings pointing at each entry). Every list is in
`chronological` order, so the index does not depend on file order. Nothing is dropped, chosen or
merged, and there is no table of neighbours or contemporaries. The index is for the author's
tools and is never published.

Its `prompts` are structural, non-blocking notices about datings that cannot all hold as
recorded: the latest day one allows ends before the earliest day the other allows can begin (an
open end never ends, a decade or century covers all its years, circa does not move a point, and
months and days count only in the same calendar).

| Code | Datings compared |
| --- | --- |
| `death-before-birth` | A person's death and birth datings. |
| `outside-lifetime` | A person's `active` dating, or the `span` of an `authored`, `member-of`, `participated-in` or `developed` relationship, against the person's birth, death and `span` datings. |
| `publication-before-composition` | A work's publication and composition datings. |
| `composition-after-death`, `composition-before-birth` | A work's composition against the life of a person an `authored` relationship records as its author. |
| `opposed-relative` | Two relative datings ordering the same two aspects both ways round, or one inside the other while also before or after it. |
| `relative-cycle` | Three or more aspects ordered in a loop by relative datings. |
| `relative-against-dates` | A relative dating against the absolute datings of the two aspects it orders. |

A `ChronologyPrompt` names the code, the owning item's collection, position and id, the field of
the dating it starts from (`dates[1]`), every dating it is about, and a message with ids, aspects
and stated values only ("not after c. 410 BCE"). It asks the author to check the values against
the cited evidence and, for datings from different parties, says a recorded disagreement can stay
side by side; it never says which dating is right and repeats no authored text. Prompts are
sorted by owner id, datings, code and message, so the order never follows the file; at most 1,000 are listed and `unlisted` counts the rest.
`openblog check` prints them as `notice:` lines and summarizes the index when the atlas has
datings; builds never run them.

## Storage

The atlas is one file, `.openblog/private/research/atlas.json`, in canonical form
(deterministic pretty JSON, trailing newline). Its **atlas revision** is the SHA-256 of the
stored bytes, or of the empty atlas while no file exists. Every change names the revision it
was based on and is refused as a conflict when the file has changed, including by hand edit.
Changes are validated against the stored source library and notebook, written to a temporary
file and renamed while holding the atlas, notebook and library locks in that order, so a
refused or interrupted change leaves the file as it was. A symlinked, damaged, oversized or
newer-version file is reported with its path and never replaced, and a damaged library or
notebook blocks atlas changes.

| Operation | Rule |
| --- | --- |
| create entry or relationship | Refuses an id any entry or relationship uses. |
| update entry or relationship | Refuses an unknown id; an entry keeps its kind. |
| remove entry | Refused while a relationship joins it; reports notes left with an unresolved concept link. |
| remove relationship | Always allowed. |

Other stores protect it: removing a source-library record the atlas uses (a work entry's
`source`, evidence, or an attribution) is refused with `still-used`, removing a notebook
passage atlas evidence points to is refused with `still-linked`, and an atlas that cannot be
read blocks both removals. A library or notebook edit that would turn a valid atlas invalid
is refused. `openblog check` validates a stored atlas, prints approved relationships the
projection would leave out as `notice:` lines that name ids only, and says nothing when there
is no atlas. The hosted workspace keeps the file durable with the 4 MiB library limit. A copy
of an atlas inside `content/`, `static/` or a theme stops the build, `serve`, `check` and
publish.

`Atlas::index` gives sorted lookup tables computed from file order: entries by kind,
relationships by entry, users by source and users by passage. Nothing is indexed on disk.

## Admin API and workspace

Defined by [ADR 0057](../adr/0057-accessible-atlas-authoring-and-a-text-first-explorer.md).
Admin Studio's **Atlas** panel (in the research workspace, next to Notebook, at
`#/research/atlas/<id>`; the earlier `#/atlas/<id>` redirects there, ADR 0120) lists,
searches and filters entries by kind, edits one entry or relationship, and explores an
entry's relationships as text. There is no graph drawing.

| Route | Purpose |
| --- | --- |
| `GET /admin/api/research/atlas` | `file`, `revision`, `stored`, `entries`, `relationships`, `notices`, `missingConcepts`, `kinds` (each relationship kind's endpoint kinds, `inverse`, `symmetric`, `sameKind`, `acyclic`; each dating `aspect` with its `entries`, `relationship` and `durative`; `orders`, `maxDatings`, `maxYear`), `chronology` (below), the library's `sources`, and notebook `passages` as `id`, `source`, `locators`, `archived` and a short `preview`. |
| `POST /admin/api/research/atlas/explore` | Body `{ id }`. `entry`, `outgoing` and `incoming`, each item with the relationship, its `label` read from this entry's side, the `other` entry, its derived `standing` (`asserted` or `contested`) and whether it is `projected`; for a concept, the notebook `notes` that link it. Read-only; an unknown id is `404`. |
| `POST` / `PUT /admin/api/research/atlas/entries` | Body `{ revision, entry }`. Create refuses an id any entry or relationship uses; update refuses an unknown id or a new kind. |
| `POST` / `PUT /admin/api/research/atlas/relationships` | Body `{ revision, relationship }`. Same rules. |
| `DELETE /admin/api/research/atlas/entries`, `/relationships` | Body `{ revision, id }`. An entry a relationship joins is refused (`still-linked`); removing a concept returns `unresolvedNotes`. |

All routes need an Admin session and, for changes, the CSRF token; a change is at most
256 KiB, and responses are `no-store`. Successes return the new revision and the whole view,
plus the saved `entry` or `relationship`. `409` carries `conflict`, the latest `revision`
and the stored `current` copy; `422` carries scoped `diagnostics` and the `file`. An id in a
removal or exploration request that is not an atlas identifier is `400` and is never echoed.

`chronology` ([ADR 0098](../adr/0098-chronology-is-authored-and-explored-in-admin-as-text.md)) is
the chronology index for the author: `timeline`, every dating in index order as `id`, `owner`,
`collection`, `index`, `field` (`dates[1]`), `aspect`, `text` (the stated value read back),
`placement` (`dated`, `relative` or `unknown`), `startYear` and `endYear` (null for an open end,
a relative or an unknown dating) and `projected`; `prompts`; and `unlisted`. It is on every
response that carries the view and is never published.

Both editors have a Dates fieldset: per dating, an identifier (fixed once stored), the aspect
(only those the owner may have), the form (at, from/to, notBefore/notAfter, unknown, relative),
each point's precision with digits and a BCE/CE choice, month, day, circa and calendar, the
relative order, entry and aspect (only aspects that entry has; `during` only those that last),
who dates it, confidence, evidence or the unsourced draft state, a note and approval, with a
"Reads:" line in the core's words. Every unknown field is kept. After a conflict, "Keep my draft"
rests each dating on the stored dating with the same id and adds datings recorded elsewhere.
The Chronology panel lists dated aspects (an item's datings of one aspect, side by side) in index
order, grouped by century, decade or year, with "Not placed in time", relative datings as
sentences and "Datings to check" linking each prompt to its dating. Its filters (text, aspect,
a BCE/CE time window, only competing, only prompted) hide or show whole dated aspects, and a
status line states the filters in force. There is no drawing.
The editor offers only the entries a relationship kind may join, sources from the library
and passages from the notebook for evidence, the three kinds of attribution, confidence,
an uncertainty note and recorded dissents. A relationship needs evidence or the explicit
unsourced draft state. Standing is always written out ("Asserted; no recorded dissent" or
"Contested: N recorded dissents (by ...)"), never as agreement. A conflict keeps the draft
until the author uses the stored copy or keeps the draft on top of it. A notebook note's
concept links open the matching entry, or a new concept with that identifier.

## Publication

Defined by [ADR 0058](../adr/0058-publish-one-allowlisted-knowledge-atlas-projection.md). A site
publishes its atlas only with `"knowledgeAtlas": {"publish": true}` in `openblog.json`; until then
no build reads the atlas. When it is on, `openblog_core::atlas_publication::PublicAtlas` projects
the approved entries and the relationships `Atlas::is_projected` allows (approved, sourced, no
passage pointer, both entries approved), and the build writes:

| Output | Content |
| --- | --- |
| `/atlas/` | Published entries grouped by kind, with how many relationships each has, a link to `atlas.json`, and, when datings are published, the timeline (below). |
| `/atlas/<id>/` | The entry's label, other names, summary and work reference; its datings, if any (below); then its relationships from and to it, each in the stored direction with standing, who asserts it, confidence, cited references and locators, uncertainty, every dissent and the datings of when it held. |
| `/atlas.json` | The same projection as compact data (below). |

```json
{
  "format": "openblog-atlas-projection",
  "formatVersion": 1,
  "entries": [
    { "id": "plato", "kind": "person", "label": "Plato", "aliases": ["Aristocles"],
      "url": "/atlas/plato/" }
  ],
  "relationships": [
    { "id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
      "label": "authored", "inverseLabel": "authored by",
      "assertedBy": { "kind": "source", "source": "scholar-book" },
      "confidence": "plausible",
      "evidence": [{ "source": "republic-slings", "locators": [{ "kind": "page", "value": "514" }] }],
      "uncertainty": "Authorship of some dialogues is disputed.",
      "standing": "contested",
      "contestedBy": [{ "by": { "kind": "named", "name": "Another reading" }, "note": "Dates it later." }] }
  ],
  "sources": [
    { "key": "scholar-book", "kind": "work", "title": "A study", "text": "A study" }
  ],
  "datings": [
    { "id": "plato-birth", "owner": "plato", "ownerType": "entry", "aspect": "birth",
      "date": { "notBefore": { "year": -428, "circa": true }, "notAfter": { "year": -427 } },
      "text": "between c. 428 BCE and 427 BCE", "placement": "dated",
      "startYear": -428, "endYear": -427,
      "assertedBy": { "kind": "source", "source": "scholar-book" }, "confidence": "plausible",
      "evidence": [{ "source": "scholar-book", "locators": [{ "kind": "chapter", "value": "3" }] }],
      "note": "Reckoned from the archon list." }
  ]
}
```

Only the fields shown (and an entry's `summary` and a work's `source`, a dissent's `evidence`)
are published; sources carry the citation allowlist of ADR 0044. Visibility, `unsourced`,
passage ids, unknown fields, private entries and relationships, relationships touching a
private entry, datings that are not projected and notebook data are never published. Entries,
relationships and sources are sorted by id. A relationship's `kind` is the stored machine value (`member-of`); `label` and
`inverseLabel` are how it reads in words from each end (`member of`, `has member`), as pages and
the Admin explorer show it. URLs are root-relative and follow a site's base path, and `<`, `>` and `&` in
text are written as JSON escapes. A relationship is `contested` whenever anyone dissents;
there is no agreed state.

**Datings** ([ADR 0099](../adr/0099-approved-datings-publish-through-the-atlas-projection.md)).
`datings` holds every projected dating in `chronology::chronological` order, and is left out when
there are none, so an atlas without projected datings is written exactly as before (the format
version stays 1). Each carries `id`, `owner` and `ownerType` (`entry` or `relationship`),
`aspect`, `date` (exactly one form; points keep only `year`, `month`, `day`, `decade`, `century`,
`circa` and `calendar`), `text` (the stated value in words with BCE written out; a relative dating
reads "after the composition of Phaedo"), `placement` (`dated`, `relative` or `unknown`),
`startYear` and `endYear` (the first and last year an absolute dating covers, absent for an open
end), `assertedBy`, `confidence`, `evidence` and its `note`. Competing datings are all present
and none is preferred; chronology prompts are never published. An entry page shows its datings
under "Dates", one heading per dated aspect (`#atlas-dates-<aspect>`) with "N competing datings,
side by side" and each dating (`#atlas-d-<id>`) with who dates it, confidence, cited evidence and
note; a relationship's datings appear in its item under "When it held".

**Timeline and trails** ([ADR 0100](../adr/0100-the-public-timeline-is-a-progressive-ordered-list-with-relative-trails.md)).
When datings are published, `/atlas/` ends with a timeline (`#atlas-timeline`): an ordered list of
periods, each the century in which a dated aspect's earliest absolute dating begins
(`#atlas-period-bce-5`, with "No earliest year stated (open start)" first), holding dated aspects
in display order with every dating in full; then "Not placed in time" (aspects dated only
relatively or stated unknown) and "Relative chronology" (every relative dating as an attributed
sentence linking both entries). A relative dating links to the other entry's datings, and that
entry's page lists "Dated relative to this entry" with links back, so relative chronology is
followed one asserted step at a time; nothing is inferred. The page loads
`<ob-atlas-timeline>` (`/assets/components/ob-atlas-timeline.js`), which adds a "Show" aspect
filter, "Only aspects with competing datings", "Go to period" and a status line. Filters show or
hide whole dated aspects, never one dating or its evidence or note; print shows everything and
hides the toolbar; nothing animates.

Clearing an approval removes the item, and an entry's relationships, from the next build;
while the site publishes its atlas, a saved Admin atlas change rebuilds at once and its response
carries the outcome as `build` (`ok`, and `error` when it failed). A
published atlas that cannot be read or validated stops `build` and `check` before anything is
written, naming the file only. `atlas` is a reserved page and post path while the atlas is
published. The atlas pages join the sitemap; feeds, search, `llms.txt` and portable exports do
not include them.

### Query projection

[ADR 0168](../adr/0168-the-atlas-query-projection-is-derived-from-the-public-atlas-alone-and-is-one-more-listed-artifact.md),
[ADR 0169](../adr/0169-the-query-projection-is-bounded-clips-text-visibly-and-is-refused-whole-over-a-bound.md),
[ADR 0170](../adr/0170-queries-are-exact-lookup-and-a-bounded-trail-that-infer-nothing.md) and
[ADR 0171](../adr/0171-the-query-file-carries-the-pages-wording-and-a-works-source-and-its-lookup-is-one-shared-algorithm.md).
While the atlas is published the build also writes `/atlas-query.json`, derived by
`openblog_core::atlas_query::AtlasQuery::project` from the public atlas above and nothing else, as
bounded page data for components and search. It is not a page and is not in the sitemap.

```json
{
  "format": "openblog-atlas-query",
  "formatVersion": 1,
  "limits": { "maxTextChars": 240, "maxListedEdges": 50, "maxTrailDepth": 3, "maxTrailSteps": 50 },
  "entries": [
    { "id": "plato", "kind": "person", "kindLabel": "Person", "label": "Plato",
      "aliases": ["Aristocles"], "preview": "An Athenian philosopher.", "previewClipped": true,
      "url": "/atlas/plato/", "out": ["r-authored"] },
    { "id": "republic", "kind": "work", "kindLabel": "Work", "label": "Republic",
      "source": "plato-republic", "url": "/atlas/republic/", "in": ["r-authored"] }
  ],
  "edges": [
    { "id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
      "label": "authored", "inverseLabel": "authored by",
      "assertedBy": { "kind": "source", "source": "scholar-book" },
      "assertedByText": "A study",
      "confidence": "plausible", "confidenceText": "Plausible",
      "standing": "contested", "standingText": "Contested: 1 recorded dissent.", "dissents": 1,
      "evidence": [{ "source": "republic-slings", "locators": [{ "kind": "page", "value": "514" }],
                     "text": "Platonis Rempublicam, p. 514" }],
      "uncertainty": "Authorship of some dialogues is disputed.",
      "url": "/atlas/plato/#atlas-r-r-authored" }
  ],
  "sources": [
    { "id": "plato-republic", "text": "Politeia" },
    { "id": "republic-slings", "text": "Platonis Rempublicam" },
    { "id": "scholar-book", "text": "A study" }
  ],
  "terms": [
    { "term": "aristocles", "entries": ["plato"] },
    { "term": "plato", "entries": ["plato"] },
    { "term": "republic", "entries": ["republic"] }
  ]
}
```

- Entries, edges, sources and terms are sorted; the file is compact, deterministic, has root-relative
  URLs that follow the base path and escapes `<`, `>` and `&`. It has no `version` key.
- `formatVersion` stays 1 while the format is unreleased, and adding an optional field to it is not
  a version change (a reader ignores fields it does not know); removing or renaming a field, or
  changing what one means, raises it (ADR 0171).
- Display text is computed in Rust with the pages' own wording and is the only wording a component
  shows: `kindLabel` on an entry; on a relationship `assertedByText` (the site author's public name
  for an author-asserted position, a source's public title, or the named party), `confidenceText`
  and `standingText`; on each evidence item `text`. A work's `source` is the id of the source it
  stands for; `sources` holds the public text of every source an entry or relationship cites or is
  attributed to.
- An entry lists the ids of the relationships that start (`out`) and end (`in`) there, at most 50
  each, and counts the rest as `moreOut` and `moreIn`; `edges` holds every published relationship.
  A relationship is read in its stored direction; `dissents` is a count and the dissents themselves,
  datings and the full summary stay on the pages and in `atlas.json`.
- `preview` is the first paragraph of the summary, cut to 240 characters with an ellipsis;
  `previewClipped` and `uncertaintyClipped` say when what is shown is less than what is published.
- `terms` maps a label or alias, normalized as below, to every entry that has it. A shared term lists
  all of them; nothing resolves it. A label or alias longer than 80 characters is not indexed.
- **Lookup normalization** is exact and is the same in Rust (`atlas_query::normalize_term`) and
  JavaScript (`web/components/atlas-terms.js`), tested against the shared fixtures in
  `tests/fixtures/atlas-lookup.json`: split the text on Unicode `White_Space` code points (U+0009 to
  U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000),
  drop the empty pieces, join with one U+0020, and apply the default Unicode lowercase conversion
  (`str::to_lowercase`; `toLowerCase`), which writes a final sigma as `ς`. Nothing else: no
  normalization form (a composed and a decomposed `Café` are different terms), no case folding (`ß`
  stays `ß` and is not `ss`), no stripping of format characters (U+FEFF and U+200B are ordinary
  characters, unlike in JavaScript's `\s`), no stemming, translation or fuzzy match.
- A projection over 2,000 entries, 10,000 relationships or 4 MiB (counted with the site's base path
  in front of every address, as written), or one that is not internally consistent, gets no file;
  `atlas.json` and the pages are unaffected, the build prints a `boundary:` warning, and the Admin
  preview says why, with the reason `over-limit` or `inconsistent`.
- The Rust API (`entry`, `edge`, `source`, `lookup`, `edges_of`, `trail`) is closed and read-only.
  `trail` is a breadth-first walk to depth 3 and 50 steps over either direction, crossing each
  relationship once so a cycle ends it, and says nothing beyond its steps.
- The publication-boundary manifest lists the file as the `atlas-query` projection, with one item
  per entry and relationship and the fields each copies, and one item per source it holds. The
  build refuses the file if it names an entry, relationship or source that the atlas projection or
  the query projection does not publish, wherever it names it: in the items it lists, in `from`
  and `to`, in `terms[].entries`, and in every source id (`sources[].id`, `evidence[].source`,
  `assertedBy.source`, `entries[].source`).

### Concept links in articles

[ADR 0172](../adr/0172-an-article-links-a-term-to-an-atlas-entry-only-where-the-author-writes-an-atlas-link-and-only-if-the-entry-is-published.md).
In a post, `[the allegory of the cave](atlas:allegory-of-the-cave)` links the words to the atlas entry
with that id. It is an ordinary Markdown link, so the label reads as written in any editor or copy
that does not know the syntax, and nothing is linked unless the author writes it: prose is never
scanned and a repeated term is linked only where the author linked it.

- The destination is `atlas:` and an entry id (lowercase letters, digits and single hyphens, at
  most 64 bytes), written as an inline link or a full, collapsed or shortcut reference link. An
  autolink (`<atlas:id>`) has no label and is not supported: it renders as nothing and the build
  warns to write `[label](atlas:id)`. An image can never have an `atlas:` address (its description
  is shown as plain text, with a warning); code is not a link. Only posts resolve the syntax:
  anywhere else (a page, a series description, the home introduction) every `atlas:` link shows its
  label and no address, title or id reaches the page. A post without it renders as it did.
- The build resolves each link against the public atlas projection and nothing else. A published
  entry becomes `<a class="ob-concept" href="/atlas/<id>/" data-atlas-entry="<id>"
  data-atlas-kind="<kind>">label</a>` (the address follows the base path): a plain link that works
  without JavaScript.
- A malformed id, an id the published atlas has no entry for (unknown, not approved or withdrawn),
  or any concept link while `knowledgeAtlas.publish` is off becomes the label as plain text, with a
  warning in `build`, `check` and Admin of the form
  ``posts/x.md: concept link `atlas:id` is shown as plain text: <reason>`` (with a count when
  repeated). It names the file and the id the author wrote, never an entry's label or private text.
  The page does not say the entry exists. Nothing stored changes.
- Feeds, portable HTML and Markdown and other copies keep the label as plain words and carry no
  link and no `atlas:` destination; the authored file keeps the syntax.
- The per-post publication-boundary manifest lists each published linked entry once as an
  `atlas-page` item under `context-links`, and each unpublished one as withheld with the reason
  `page-not-published`.
- `conceptEntryId` in `web/components/atlas-terms.js` and `concept_links::entry_id` apply the same
  destination rule, tested against `tests/fixtures/concept-links.json`.
- A resolved link also carries visually hidden words after the label (` (atlas entry)`), and the
  theme underlines it with dots, so it reads and looks as a link to an entry
  ([ADR 0173](../adr/0173-a-concept-link-is-only-a-link-where-it-can-be-one-and-every-other-place-shows-its-words.md)).
  An `atlas:` link inside an image's description keeps its label as the alt text and warns. Inside
  a heading the link is described by one hidden hint (`aria-describedby`) rather than carrying inline
  hidden words. In a
  page, a series description or the home introduction the label is shown as plain text and the load
  warns (``<file>: atlas link `atlas:id` is shown as plain text: ...``); only posts resolve links.

### Entry previews

[ADR 0174](../adr/0174-contextual-entry-previews-read-the-public-query-file-and-enhance-an-ordinary-link.md).
A post that has a resolved concept link, on a site whose build writes `atlas-query.json`, ends with
`<ob-concept-previews src="/atlas-query.json?v=<hash>" data-bytes="<size>"></ob-concept-previews>` (the address follows
the base path, and `<hash>` is 16 hex digits of the file's own BLAKE2s hash, so the address changes
exactly when the file does) and loads `/assets/components/ob-concept-previews.js`. No other page does.

- Without JavaScript nothing changes: the link goes to the entry's page.
- The component reads `atlas-query.json` from the site's own origin, once, at the first
  interest in a link (focus, hover or a press; on a touch screen a concept link scrolling into view,
  unless the reader asked to save data or the file is 256 KiB or more: the element's `data-bytes`
  says the file's size, and a missing or larger size waits for the first tap), never on load or when the page is idle, and validates it: `format` `openblog-atlas-query`, `formatVersion` 1, each entry, relationship and
  source on its own. A file it cannot fetch or read, or an entry whose page is not the link's own
  destination, leaves that link an ordinary link.
- A preview shows only that file's public fields, as text: the entry's `kindLabel` (its type), the
  line "From the author's approved Knowledge Atlas" (its provenance), the first paragraph of its
  summary and whether the page has more, a work's `source`, and up to two relationships with
  `assertedByText`, `confidenceText`, `standingText`, `uncertainty` and the evidence `text`, and how
  many more the page lists; and one link, "Read the full entry".
- Keyboard and touch behave as the citation previews do: focus opens it and describes the link with
  it, Tab continues into its link, there is no focus trap, Escape closes it and returns focus,
  hovering opens it, the first tap opens it and a second follows the link, the page never scrolls,
  and the animation is off under `prefers-reduced-motion`.
- `previewModel` and `readQuery` in `web/components/ob-concept-previews.js` are tested against
  `tests/fixtures/concept-previews.json`, whose fields a Rust test checks the real projection
  writes.

### Relationship trails

[ADR 0175](../adr/0175-a-relationship-trail-is-a-static-ordered-list-of-published-steps-with-direction-and-evidence-and-filters-only-by-script.md).
Every entry page with at least one published relationship ends its relationship lists with a
"Relationship trail" region (`#atlas-section-trail`): the bounded walk of ADR 0170 (breadth first,
either direction, each relationship crossed once, at most three steps away and 50 steps) as an
ordered list of distances ("One step from X", ...), each an ordered list of steps, readable without
CSS or JavaScript. It is rendered from the query projection that writes `atlas-query.json`; when
that projection is not written (over its bounds, or not consistent) the page has no trail and keeps
its relationship lists. A site that does not publish its atlas has no trail.

- A step is `<li id="atlas-trail-<relationship id>" class="ob-trail-step">` with `data-depth`,
  `data-kind`, `data-direction` (`forward` or `backward`: which way the walk crossed it; `symmetric` for a kind that reads the same both ways), `data-kind-label`,
  `data-standing` (`asserted` or `contested`), `data-uncertain` (`true` when an uncertainty is
  stated) and `data-again` (`true` when it arrives at an entry already on the trail). Its sentence
  is the relationship in the direction it was stated; a list of facts gives its type, its direction
  (as stated, and as followed, or that the kind reads the same both ways), who asserts it, how
  firmly (never how widely accepted), its standing, its evidence (reference and locator) and its
  uncertainty (clipped visibly, with a link to read it in full; an unstated one says that is not a
  claim of certainty). It links to the relationship in full. That list of facts is on the first step
  out only; a step two or three away is its sentence, which way it was followed and the link, and
  every step keeps its data attributes for the filters. When every entry page's trail together
  would pass 20 MB, every trail is one step deep and the build prints a `warning:`. Under either
  direction filter a `symmetric` step stays visible.
- A step that arrives at an entry already on the trail says so and does not continue from it, so a
  cycle is a sentence. Each reached entry links to its own page, which continues the trail from
  there. When the walk was cut at 50 steps the page says so; when it stopped at three steps it says
  to follow an entry's link to go further. A skip link leads to a focusable end line.
- A trail is not a line of influence: nothing infers a relationship that was not published, joins
  steps, ranks, scores or draws them. Private or withdrawn entries and relationships cannot appear.
- `<ob-atlas-trail>` (`/assets/components/ob-atlas-trail.js`, loaded only by a page with a trail)
  adds a labelled group of native controls above the list (relationship type, direction followed,
  how far, only contested or uncertain) and a `role="status"` line naming every filter in force.
  A filter shows or hides a whole step and never changes a shown step; hidden steps are not
  reachable by Tab; a reset button keeps focus; print shows the whole trail without the controls.
  It reads only the page's markup and fetches and stores nothing.
- `filterSteps` and `statusText` in the component are tested against
  `tests/fixtures/atlas-trail.json`, whose steps a Rust test checks against the real walk and
  renderer.
