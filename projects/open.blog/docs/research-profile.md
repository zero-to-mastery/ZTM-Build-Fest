# Research posts and Evidence Studio

Use the Research content profile for an article that should publish work-level scholarly
metadata and a visible, bounded reference list. The post remains portable Markdown: links,
footnotes, headings, and prose do not depend on a private citation format.

## Start a research post

Choose **Research** under **Settings → Content profile** in the admin, or add the fields by
hand:

```markdown
---
title: Measuring a small intervention
date: 2026-10-23
profile: research
doi: 10.1234/example.study
license: https://creativecommons.org/licenses/by/4.0/
---

## Abstract

State the question, method, important result, and limits in visible prose.

## References

1. [Prior work](https://doi.org/10.1000/prior)
2. [Dataset](https://data.example.org/study)
```

`doi` accepts a DOI name or an `https://doi.org/` resolver URL. The engine preserves the
identifier and normalizes valid output to the HTTPS resolver form. `license` must be an
absolute HTTP or HTTPS URL for the license that applies to the work. Neither field is
required, but an explicitly empty or malformed value produces a finding instead of being
silently treated as verified metadata.

For a complete runnable example, see the repository's
[research and contributor-credit post](../content/posts/2026-02-16-research-and-contributor-credits.md),
its adjacent [credit sidecar](../content/posts/2026-02-16-research-and-contributor-credits.credits.json),
and the synthetic contributor registry in [`openblog.json`](../openblog.json). Together they
demonstrate the Admin Studio workflow, ordered author/editor roles, visible contributions,
research findings, feeds, and structured data without borrowing a real person's ORCID.

The Abstract and References/Bibliography headings must be visible top-level document
sections. A matching heading inside a quote, list item, footnote, code block, or HTML block
does not define the section. References can be list items or prose; resolvable HTTP and HTTPS
links inside the bounded References/Bibliography section become citation URLs. Links
elsewhere in the post do not.

## What readers and machines receive

A research post keeps the ordinary article page and adds:

- a visible work-details panel for a valid DOI resolver link and license link;
- `ScholarlyArticle` JSON-LD with explicit DOI identifier, valid license URL, and bounded
  citation URLs when present;
- `citation_title`, `citation_author`, and `citation_publication_date` Highwire metadata when
  the post resolves at least one actual author. A work-credit sidecar emits one
  `citation_author` tag per `crossref:author`, in authored order.

The engine deliberately does not invent journal, conference, volume, issue, pages,
publisher, funding, contributor roles, or peer-review status. It does not emit partial
venue metadata, `citation_doi`, or Dublin Core fields in this release. Metadata helps a
consumer understand the page; it does not guarantee Google Scholar inclusion, search rank,
an AI citation, or verification of the work.

## Evidence Studio and command-line checks

Open **Evidence** in the admin or press `Alt+9`. The view uses the publishing engine's audit
of the current unsaved document and groups findings as Detected, Potential, or Needs review.
It also shows the authored DOI (normalized to a resolver URL when valid), valid absolute
license URL, and number of linked references. The
Abstract and References toolbar actions consult that same parser before inserting a missing
section, so examples and nested headings are not mistaken for document structure.

The same findings appear during read-only validation, builds, and the startup build report
from the development server:

```sh
openblog check
openblog build
openblog serve
```

Each finding includes a stable code, source field or line and column, outcome, explanation,
and repair. Current codes are:

| Code | Meaning |
| --- | --- |
| `abstract-missing` | No visible top-level Abstract section was found. |
| `references-missing` | No visible top-level References or Bibliography section was found. |
| `doi-invalid` | The authored DOI is empty or lacks broad DOI name structure. |
| `license-url-invalid` | The authored license is not an absolute HTTP or HTTPS URL. |
| `footnote-unresolved` | A Markdown footnote reference has no definition. |
| `reference-link-review` | A reference entry has no resolvable HTTP or HTTPS link and needs human review. |
| `doi-link-non-preferred` | A DOI reference link should use the preferred `https://doi.org/` resolver form. |

These checks establish source structure and syntax only. They do not test whether a DOI
resolves on the network, a source is authoritative, a method is sound, a citation supports a
claim, or a work was peer reviewed. No empty finding list is presented as a quality score.

## Private source library

Works, editions, translations, witnesses, and references you reuse across research posts
can be kept in a private source library at `.openblog/private/research/sources.json`. It
is never content: nothing in `.openblog/` is copied into the site, feeds, search index, or
exports, even if a static or theme directory is configured to contain it. A build reads the
library only to resolve the citations of a post that opts in (see
[Citations, notes and bibliographies](#citations-notes-and-bibliographies)), and publishes
only the cited references' public description. New projects ignore `.openblog/private/` in Git, so the library stays on
your machine unless you choose otherwise.

`openblog check` validates a stored library and lists each problem with the source's
position, identifier, and field. Changes are revision-checked and atomic: a change based on
an outdated read, an invalid change, or an interrupted write leaves the stored file exactly
as it was, and a damaged or newer-version file is reported rather than replaced. See the
[format and storage contract](specs/research-source-library.md) and
[ADR 0010](adr/0010-private-source-library-storage.md).

Admin Studio manages the library under **Sources** in the research workspace
(`#/research/sources`, also in the command palette): create, edit, archive, restore, search,
and filter each source type. A stale edit shows a conflict and keeps your draft without
overwriting newer data; see
[ADR 0011](adr/0011-admin-source-library-management.md).

Sources also imports CSL JSON (for example from Zotero) after a preview that lists what would
be created, updated, kept, and not imported, and exports CSL JSON or BibTeX. Importing never
removes anything or discards richer details and is safe to repeat; see
[ADR 0012](adr/0012-source-library-interchange.md).

## Citations, notes and bibliographies

Any post (not only a research post) can cite library sources as `[@key]` or
`[@key, page 514; canonical 514a]`, typed by hand or inserted with **Cite** in the Write view.
Citations are opt-in: they stay plain text until the post's front matter asks for them.

```markdown
---
title: The cave
date: 2026-10-23
citations: notes          # or: bibliography
citationLocale: de        # optional: en, de, fr or es; defaults to the site language
---

The prisoners see only shadows [@republic-slings-2003, page 514 to 520].
```

- `notes` gives each distinct citation a numbered note under **Notes**; a repeated identical
  citation reuses its note.
- `bibliography` lists each cited source once under **References** and keeps the locators
  next to the marker in the text, such as `¹ (pp. 514–520)`.

Notes show the authors, title, editors and translators, container, place and publisher, date,
a DOI or web link, and the locators, in the post's language. Every page, portable copy, feed
and `llms.txt` shows the same notes with the same numbers; on the page each marker and note
link to each other for keyboard and screen-reader users. Only the key, the locators and the
source's public description are published, never notes, private identifiers or anything from
the research notebook.

On the page, a reader with JavaScript also gets a **citation preview**: focusing or hovering a
marker, or tapping it once on a touch screen, shows the note's reference, the cited location and
its DOI or web link right beside the marker, and Escape closes it. The marker is still the link to
its note, nothing is fetched or stored, and without JavaScript the page reads exactly the same.
A preview shows only what your library says. It does not check that a source exists or is
described correctly, that a DOI or web address resolves, that the passage is at that location or
supports your sentence, or that a source is authoritative or may be reused; see
[what previews do not verify](specs/citations.md#what-previews-do-not-verify).

A citation the build cannot resolve (an unknown key, a page cited on a whole work, a malformed
bracket, or no library) stops that post with its file line and a fix; write `\[@` for literal
text. See [ADR 0048](adr/0048-citations-publish-through-the-one-publication-projection.md) and
[ADR 0049](adr/0049-built-in-citation-styles-locales-and-accessible-notes.md).

For the product boundary and supporting standards research, see
[Research and evidence publishing](research/research-evidence-publishing.md) and
[ADR 0002](adr/0002-research-profile-and-evidence-capability.md).

Every code the research checks can report, with what it means and how to fix it, is explained in
[Research checks](research-checks.md).
