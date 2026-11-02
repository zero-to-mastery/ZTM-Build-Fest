# Citation format

The contract defined by [ADR 0042](../adr/0042-citation-keys-are-source-identifiers.md) to
[ADR 0047](../adr/0047-citation-picker-in-the-visual-editor.md), implemented by
`openblog_core::citations`, and published by `openblog_core::bibliography`
([ADR 0048](../adr/0048-citations-publish-through-the-one-publication-projection.md),
[ADR 0049](../adr/0049-built-in-citation-styles-locales-and-accessible-notes.md)). A citation
points at a record in the [source library](research-source-library.md) and reuses the
[notebook's locators](research-notebook.md). The resolver never reads the notebook.

## Syntax

```markdown
Plain: [@plato-republic]
Located: [@republic-slings-2003, page 514 to 520]
Compound: [@republic-slings-2003, page 514; canonical 514a to 520a; x-stephanus 514a]
```

| Part | Rule |
| --- | --- |
| key | A source identifier: lowercase ASCII slug, at most 64 bytes. Archived records resolve. |
| locator | `kind value`, optionally `kind value to end`. At most eight, separated by `;`. |
| kind | `page`, `folio`, `line`, `section`, `chapter`, `canonical`, `timestamp`, or `x-` plus a slug. |
| value, end | Unicode text, at most 200 characters, no `;`, `[`, `]`, ` to ` or control or bidirectional override characters. Timestamps are seconds or `h:mm:ss`. |

The scanner reads Markdown with the renderer's own parser, so a citation is found exactly where
the renderer shows `[@...]` as text. Not citations: code (fenced, indented, inline, also inside
block quotes and over line breaks), raw HTML and comments, `\[@key]`, links and images
(`[@key](url)`, `[@key][ref]`, and a shortcut `[@key]` that a `[@key]: url` definition turns
into a link), definitions, and footnotes. Backslash escapes inside a citation are read as the
renderer shows them, and an escaped `\]` does not close it. A citation sits on one line with no
formatting inside it. Malformed or unknown ones are reported with their line and left as text.
Limits: 1 MiB of Markdown and 2,000 citations per document.

## Resolution and public output

`resolve_citations` takes the scanned citations and the source library. Unknown keys and
ambiguous locators (a page on a work, a folio off a witness) are reported per citation and
omitted; others resolve. The result lists each citation with the number of its reference in
order of first citation, and each reference once.

Public: the key, the locators (kind, value, end) and the reference description (kind, title,
creator names and roles, issued, language, identifiers in the schemes `doi`, `isbn`, `issn`,
`url`, `pmid` and `pmcid`, preserved CSL variables) with its
plain-text rendering. Private and never present: notebook content, archived flag,
relationships, unknown fields (also on locators), identifiers in any other scheme, credits.

## CSL interoperability

See [ADR 0046](../adr/0046-csl-interoperability-policy.md) for the table of stored, preserved,
private-dropped and unsupported CSL variables and the citation-item mapping. In short: the first
locator becomes CSL `label` and `locator`; the full ordered list travels in `openblog-locators`;
every loss is reported; failures are scoped to one citation or item and change no file.

## Admin citation picker

The Write view's **Cite** action ([ADR 0047](../adr/0047-citation-picker-in-the-visual-editor.md))
inserts or edits one citation in either writing mode. Both routes are signed-in, `no-store`, and
write nothing.

| Route | Behaviour |
| --- | --- |
| `GET /admin/api/citations/library` | `file`, `revision` (of the source library), `sources`, and the notebook's live `passages` as `id`, `source`, a 160-character `preview` and `locators` (kind, value, end only). `notebookAvailable` is `false`, with no passages, when the notebook cannot be read. |
| `POST /admin/api/citations/check` | JSON body (at most 16 KiB, with the CSRF token) `{ revision, citation: { key, locators: [{ kind, value, to }] } }`. Only those locator fields are read. Returns `markdown`, `key`, `locators`, `reference`, `formatted` and `revision`. A different library `revision` is `409` with the latest `revision` and `sources`; a citation that fails to format, scan back or resolve is `422` with `diagnostics`; a missing revision is `400`. |

In Visual mode every citation is an atomic chip that serializes back to its exact Markdown, so
hand-written and generated citations round-trip byte for byte. A citation typed or pasted in
Visual mode becomes a chip. A block whose `[@` text the visual editor cannot read exactly as the
scanner does (an escaped backslash before it, a link or `(` after it, a malformed bracket, link
text, or overlapping emphasis) is a protected **Citation text** block, kept verbatim. Neither
mode inserts a citation inside code, a link or a protected block; the dialog explains why and
stays open. Undo (Ctrl+Z or **Undo
citation**) restores the exact prior draft and caret while nothing else has changed.

## Publication

A post opts in with `citations: notes` or `citations: bibliography` in its front matter
(`citationLocale`: `en`, `de`, `fr` or `es`, defaulting to the site language). Without it, or
with no citation in the body, the post publishes exactly as before.

| Step | Rule |
| --- | --- |
| Scan and resolve | The core scanner and resolver. For a post the load publishes, any diagnostic, a missing library or an unreadable library refuses the post with its file line, key, code and a repair hint, before anything is written. A draft, a post held back until its date and, in an Admin preview, every other document get a warning instead and keep their citations as text. |
| Rewrite | Each citation becomes a footnote reference `[^cite-N]` (`cite2-` and so on when the author already uses `cite-` plus a number as a footnote or as literal `[^cite-N]` text, or has a footnote or heading id, written or slugged, of the form `cite-N` or `cite-N-ref-K`, in any case). `bibliography` adds ` (locators)` after the marker. A following `(`, `[` or `:` is escaped. |
| Notes | Appended under `## Notes` or `## References` (localized) as `[^cite-N]: reference, locators.` in order of first citation: one per distinct citation (`notes`) or per reference (`bibliography`). Text is escaped Markdown from the public reference only. |
| Check | The result is parsed again; it must hold one generated marker per citation and one note per number, or the post is refused. |
| Publish | `Post::publication_markdown` feeds the native page and the portable projection (portable HTML, Markdown, text, RSS, JSON Feed, `llms.txt`, destinations). The authored file never changes. |

A source library edit (`update`, CSL import or removal) that would stop a published, opted-in
post's citations from resolving is refused with `still-used`, naming the post's path and line.

## Checks

`openblog_core::citation_review` ([ADR 0050](../adr/0050-offline-citation-checks-and-portable-bibliography-exports.md))
reviews every post that opts in, offline, and reports evidence findings that `openblog check`,
builds and Evidence Studio show with the post's path and line:

| Code | Outcome | When |
| --- | --- | --- |
| `citation-syntax` | detected | a citation cannot be read (malformed, invalid key or locator, too large) |
| `citation-unresolved` | detected | unknown key or ambiguous locator |
| `citation-identifier-unpublished` | potential | a PMID or PMCID not in its standard form, left out of notes and exports |
| `citation-reference-incomplete` | potential | the cited reference has no title; no creator (work, edition, translation); no date (edition, translation, or any CSL type); no container title (journal article, chapter, entry, paper, blog post); no publisher (book, report, thesis, untyped edition); no web address (web page, post). `field` names the detail |
| `citation-location-review` | needs-review | one per post, listing the lines of resolved citations that give a location: only a person can check that the passage is there |

No finding says whether a source is true, relevant or supports a claim, and nothing is looked
up online. Posts that do not opt in get none.

## Bibliography exports

A published post's cited references, in order of first citation, export as CSL JSON
(`export_cited_csl_json`) or BibTeX (`export_cited_bibtex`) from the same public description
the notes show: no `custom` envelope, relationships, locations, archived flags, unknown fields
or private identifiers. Each export lists `losses` (`sourceId`, `field`, `reason`) for what the
format cannot carry.

| Where | Behaviour |
| --- | --- |
| `openblog export <slug> --format csl-json\|bibtex` | Dry run prints the content and each omission; `--out <path> --write` writes atomically and never overwrites; `--json` prints `{ version, sourcePath, canonicalUrl, representation, outputFile, bytes, count, offline, omissions, content }`. A post that publishes no citations is refused and nothing is written. |
| `POST /admin/api/preview` | For a post that publishes citations, `citations` holds `style`, `locale`, `citations`, `notes`, `references`, `offline: true` and `exports` with `csl-json` and `bibtex` entries (`filename`, `mediaType`, `count`, `content`, `losses`); otherwise `null`. |

On the native page a generated marker is
`<sup class="footnote-reference ob-citation"><a href="#cite-1" id="cite-1-ref-1" role="doc-noteref"><span class="ob-visually-hidden">Citation </span>1</a></sup>`
and each note ends with one `doc-backlink` per citing marker. The generated heading and notes
are one `<section class="ob-citation-notes" role="doc-endnotes" aria-labelledby="…">` named by
that heading's id, which steps aside from the post's own `{#id}`s, footnote labels and raw HTML
ids so no other element has it (the author's own headings keep the ids they have without
citations), and each generated note has `tabindex="-1"`, so following a marker moves focus
to its note without JavaScript; the author's own footnotes stay outside it, unchanged. The
reached note or marker is outlined (`:target`), long addresses wrap, and print hides only the
back links ([ADR 0060](../adr/0060-citation-navigation-is-static-html-checked-at-build.md)).
Portable copies keep ordinary footnotes that link to the note on the canonical article.

## Reader references

[ADR 0059](../adr/0059-published-reference-data-for-citation-previews.md) defines the data a
citation preview reads, `openblog_core::reader_references::ReaderReferences`
(`Post::reader_references`), projected from the published citations and absent for a post that
publishes none.

| Field | Content |
| --- | --- |
| `version`, `style`, `locale` | `1`; `notes` or `bibliography`; the notes' locale |
| `references[]` | `id` (the citation key, distinct per work, edition, translation and witness), `number` (order of first citation), `preview` (the public description, ADR 0044), `formatted` (plain text), `link` (DOI resolver or plain HTTP(S) address, else absent) |
| `citations[]` | `marker` (`cite-N-ref-K`), `note` (`cite-N`), `reference` (an id above), `locators` (kind, value, end), `formatted` (the locators as readers see them in the notes' locale, `pp. 514–520, l. 3`; absent without locators) |

Every citation names a listed reference, every reference is cited, and `check_page` confirms the
page holds each marker and note id, so each citation resolves to a visible reference without
JavaScript: exactly one element carries each id and the region's label, the marker links to its
note, and the page links back to the marker. The build runs it on every finished post page and in the Admin preview, and
stops with `<source path>: the page's citation anchors do not match its reference data: …` when
they disagree (for example, authored HTML that repeats a generated id, which the message names
with a request to rename it). Only the reference `id` is
stable across revisions: `marker` and `note` ids are
positional (order of first citation, occurrence and the post's label prefix), valid for the one
revision whose page carries them, and must not be stored. A durable target uses the reference id,
or the passage and annotation selectors of #80 and #84. The document is written inline as
`<script type="application/json" id="ob-references">` with `<`, `>`, `&` and U+2028/9 escaped
(`to_script_element`) in the `<head>` of the post's page, after the JSON-LD, and nowhere else;
there is no separate file in version 1.

## Citation previews

[ADR 0061](../adr/0061-citation-previews-are-a-progressive-non-modal-component.md) defines
`<ob-citation-previews>` (`web/components/ob-citation-previews.js`). Only the page of a post that
publishes citations loads it: its module script follows the `ob-references` element in the
`<head>`, and one empty `<ob-citation-previews note-label="Go to note">` (`Go to reference` for a
bibliography, in the citation locale) ends `<main>`.

| Use | Behaviour |
| --- | --- |
| Keyboard | Focusing a marker opens its preview straight after the marker, so Tab continues into its links; the marker is `aria-describedby` its text while it is open. Escape closes it and returns focus to the marker. Enter follows the marker's link. |
| Pointer | Hovering a marker opens it after 250 ms; leaving the marker and preview closes it after 300 ms. A click follows the link. |
| Touch | A first tap opens the preview; its "Go to note" link or a second tap follows the link. Only a click that ends a touch press on the same marker is a tap: Enter, a script or a screen reader's activation always follows the link. |
| Anywhere else | Focusing or pressing outside the marker and preview closes it. One preview is open at a time. |

The preview (`role="group"`, named by its marker) shows the reference's `formatted` text, the
citation's `formatted` locators, the reference's `link` when it is an absolute `http(s)` address
with no credentials, and the link to the note, all as text. It never fetches, stores or changes
the marker; data of another version, unreadable data or a marker that no longer links to its
note leaves the page as it is. It stays inside the viewport, opens above the marker when only
that fits, fades in only without a reduced-motion preference and is not printed.

### Guarantees

These hold for every release and are pinned by `crates/openblog-core/tests/citation_navigation.rs`,
`crates/openblog-core/tests/citation_preview_regressions.rs`, `tests/web/citation-previews.test.mjs`
and the browser specs `tests/browser/citation-navigation.spec.mjs`,
`tests/browser/citation-previews.spec.mjs` and `tests/browser/citation-preview-regressions.spec.mjs`.

| Area | Guarantee |
| --- | --- |
| Links | A web address links only when it is an absolute `http(s)` address with a host and no credentials, and a DOI only to its `https://doi.org/` address. The source library refuses any other `url` or DOI where it enters; the reader data and the browser check each link again, and anything else is dropped while its text is kept. |
| Escaping | Titles, names and other metadata are text everywhere: escaped in the notes, written into the `ob-references` element with `<`, `>`, `&`, U+2028 and U+2029 as `\u` escapes, and shown by the preview with `textContent`. A page of hostile sources has exactly the elements and attributes of the same page with harmless ones. |
| Content security policy | The data element is `application/json` and never runs. The component is a same-origin module that needs only `script-src 'self'` and `style-src 'self'`: it adds no inline script, markup style or event handler and positions the preview with custom properties set through the CSS object model. Admin previews serve it under the preview policy. |
| Requests and storage | The component makes no request of its own (a link in a preview is fetched only if the reader follows it), and reads or writes no storage, cookie or history entry. |
| Focus and reading position | The marker stays the link: its `href`, role, name and id never change. Focus returns to the marker on Escape. The preview is absolutely positioned and the host element is not displayed, so enhancement never moves the text, and following a citation, its way back and the browser's Back button behave exactly as without JavaScript. |
| Responsive and print | The preview fits the visible width (the root element's `clientWidth` less 8px on each side) at any zoom; notes wrap long addresses. Print hides the preview and the ways back and keeps every note. |
| Without JavaScript | Every marker links to its focusable note and every note links back, checked when the page is built. A slow, failing or broken component, or data over its 1 MB budget, leaves exactly that page. |
| Publication | Only the page of a post that publishes citations carries the data and loads the component. Indexes, feeds, search data, `llms.txt` and portable copies carry the notes and never the data, and pages of posts that publish no citations are byte for byte what they were before previews. Output is deterministic, whatever order the library lists its sources in. |

### What previews do not verify

A preview shows what the author's own source library says about a source, as the notes do. It
does not check, and must not be read as saying:

- that the source exists, or that its title, authors, date or publisher are right;
- that a DOI is registered or resolves, or that a web address is reachable, current or the
  version that was read (nothing is fetched to find out);
- that the cited passage is at the given location, or that it supports the sentence it is
  attached to;
- that a source is authoritative, peer reviewed, reflects scholarly consensus, or may be quoted
  or reused (copyright permission).

The [offline citation checks](../adr/0050-offline-citation-checks-and-portable-bibliography-exports.md)
make the same limits explicit to the author.
