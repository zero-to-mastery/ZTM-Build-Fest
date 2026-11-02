# Research notebook format

Version 1 of the private passage and research-note contract defined by
[ADR 0034](../adr/0034-private-passages-and-research-notes.md), implemented by
`openblog_core::research_notes`. It points into the
[source library](research-source-library.md). It is stored and edited as described in
[ADR 0035](../adr/0035-private-notebook-storage-and-admin-capture.md); builds never read it.

```json
{
  "version": 1,
  "passages": [
    { "id": "cave-opening", "source": "republic-slings-2003", "visibility": "private",
      "excerpt": { "text": "ὁ δὲ Σωκράτης…", "language": "grc" },
      "locators": [
        { "kind": "page", "value": "514" },
        { "kind": "canonical", "value": "514a", "to": "520a" },
        { "kind": "x-stephanus", "value": "514a" }
      ] }
  ],
  "notes": [
    { "id": "why-a-cave", "kind": "question", "visibility": "private",
      "text": "Why does the image start underground?",
      "passages": ["cave-opening"], "sources": ["plato-republic"], "concepts": ["allegory"] }
  ]
}
```

## Fields

| Entry | Field | Rule |
| --- | --- | --- |
| both | `id` | Required. Lowercase ASCII slug of at most 64 bytes, unique across passages and notes, never changes. |
| both | `visibility` | Optional on read, always written. Only `private`; any other value is refused (`not-private`). |
| passage | `source` | Required. An existing source-library id (archived records resolve). Never changes. |
| passage | `excerpt` | Required object: `text` (verbatim, at most 20,000 characters) and optional `language` tag. |
| passage | `locators` | Optional, at most eight, in order, none repeated. |
| locator | `kind` | `page`, `folio`, `line`, `section`, `chapter`, `canonical`, `timestamp`, or `x-` plus a lowercase slug. |
| locator | `value`, `to` | Text up to 200 characters; `to` ends a range. Timestamps are seconds or `h:mm:ss`. |
| note | `kind` | Required. `observation` or `question`. |
| note | `text` | Required author prose, at most 20,000 characters. |
| note | `status` | Optional, questions only: `open` or `resolved`. Absent means open. |
| both | `archived` | Optional boolean, written only when `true`. Sets the entry aside; it never changes visibility. |
| note | `passages`, `sources`, `concepts` | Optional id lists (at most 100, no repeats). Passages must exist in the notebook, sources in the library; concepts are slugs checked for shape only. |

Pages cannot address a work and folios need a witness, resolving a reference through its
`of` chain. Unknown fields are kept verbatim at the notebook, entry, excerpt, and locator
levels but may not reuse a defined name. Credit field names are refused. Text may contain
`\n` and tabs in excerpts and notes, never other control characters or Unicode bidirectional
override and isolate controls.

## Limits and diagnostics

At most 4 MiB as read and as written, 10,000 passages and 10,000 notes. A newer version is
refused. Diagnostics carry a kebab-case `code`, `collection`, zero-based `index`, `id`, a
`field` path, and a message that never repeats quoted or noted text. Failed changes
(`upsert_passage`, `upsert_note`, `remove_passage`, `remove_note`) leave the notebook
unchanged; removing a passage still linked by a note is `still-linked`, and changing a
passage's source is `source-changed`.

## Storage and Admin API

The notebook is one file, `.openblog/private/research/notebook.json`, in canonical form
(deterministic pretty JSON, trailing newline). Its **notebook revision** is the SHA-256 of
the stored bytes, or of the empty notebook while no file exists. Every change names the
revision it was based on and is refused with `409` when the file has changed, including by
hand edit. Changes are validated against the stored source library, written to a temporary
file and renamed under a lock, so a refused or interrupted change leaves the file as it was.
A damaged, oversized or newer-version file is reported with its path and never replaced.

| Route | Purpose |
| --- | --- |
| `GET /admin/api/research/notebook` | `file`, `revision`, `stored`, `passages`, `notes`, and the library's `sources` for choosing from. |
| `POST` / `PUT /admin/api/research/passages` | Body `{ revision, passage }`. Create refuses an id any entry uses; update refuses an unknown id. |
| `POST` / `PUT /admin/api/research/notes` | Body `{ revision, note }`. Same rules. |
| `DELETE /admin/api/research/passages`, `/notes` | Body `{ revision, id }`. A passage a note links to is refused (`still-linked`). |

All routes require an Admin session and, for changes, the CSRF token; requests are at most
256 KiB and responses are `no-store`. Successes return the new `revision`, the lists, and
the saved entry. `409` carries `conflict`, the latest `revision`, and the stored `current`
copy; `422` carries entry-scoped `diagnostics`. Removing a source-library record that a
passage or note still uses is refused with `still-used`.

## Search and backlinks

Defined by [ADR 0036](../adr/0036-private-notebook-search-and-backlinks.md) and implemented by
`openblog_core::research_search`. Nothing is indexed on disk: every request reads the stored
notebook and library and computes the answer.

A question note may carry `status` (`open` or `resolved`); absent means open and is not written
back, and an observation may not carry one.

| Route | Purpose |
| --- | --- |
| `POST /admin/api/research/search` | JSON body (at most 16 KiB, so research text never appears in a URL or access log) with `q` (all words must match, at most 200 characters and 16 words), `source` (a source and its editions, translations, witnesses and references), `locator` (a locator kind), `concept`, `state` (`open` or `resolved`). Returns `hits`, `total`, `truncated` (at most 100 hits), `counts`, `broken`, `revision`. |
| `POST /admin/api/research/backlinks` | JSON body `type` (`source`, `passage` or `concept`) and `id`. Returns `entries`, each with a `relation` (`quotes`, `notes`, `via-passage`) and the `through` source it goes by, plus `broken`. |

Words are matched case-insensitively with whitespace collapsed and the Greek final sigma folded;
diacritics are not folded. Hits are ordered by score (prose or quoted text 3, id or concept 2,
source or locator 1), then notebook order. Each hit carries a bounded plain-text snippet, its
source (with `archived` and `missing`), locators, concepts, the passages a note is about and the
notes that link a passage. `concept` and `state` select notes; `source` and `locator` apply to a
note through the passages it links. Bad filters are `422` with a diagnostic on `q`, `source`,
`locator`, `concept` or `state`; no match is an empty `200`. Both routes are read-only,
`no-store`, and need an Admin session.

## Archive, export and import

Defined by [ADR 0037](../adr/0037-private-notebook-lifecycle-export-and-leak-guards.md) and
implemented by `openblog_core::research_bundle` and `notebook_store`.

| Route | Purpose |
| --- | --- |
| `POST /admin/api/research/archive` | Body `{ revision, type: "passage" or "note", id, archived }`. Revision-checked; changes only `archived`. |
| `POST /admin/api/research/export` | Body `{ includePrivate: true }`, refused (`400`) without it. Returns `filename`, `mediaType`, the counts, the `revision` and the bundle as `content`. Read-only and `no-store`. |
| `POST /admin/api/research/import` | Body `{ revision, bundle, apply }` where `bundle` is the parsed bundle object (at most 4.25 MiB). `apply: false` previews; `apply: true` applies when nothing conflicts and something would be added. Returns `plan` (`counts` and one `entry` per passage or note with `create`, `unchanged` or `conflict`, never any text). A conflict is `422` with the plan; a stale revision is `409`. |

Search accepts `includeArchived: true`; hits and linked entries carry `archived` when set, and
`counts.archived` totals them while `openQuestions` and `resolvedQuestions` count live entries only.

A bundle is one JSON object, written deterministically with a trailing newline:

```json
{
  "format": "open.blog/research-notebook",
  "version": 1,
  "private": true,
  "contains": ["passages", "notes"],
  "sources": [{ "id": "republic-slings-2003", "kind": "edition", "title": "Platonis Rempublicam" }],
  "notebook": { "version": 1, "passages": [], "notes": [] }
}
```

`notebook` is read by the same rules as the stored file, against the stored source library, so
unknown sources, non-private entries, credit fields, control characters and oversized or
newer-version bundles are refused with field-scoped diagnostics that never repeat text. Import only
adds: an id that exists with different content, or that the other kind of entry holds, is a conflict
that refuses the whole import. Importing the same bundle again changes nothing.

## Publication guards

Builds never read the notebook. `openblog build`, `serve`, Admin rebuilds and `openblog check`
also refuse to run when a file under `content`, `static` or `themes` has the shape of a research
bundle or a notebook copy (the path is reported, never its contents), and `openblog publish`
refuses to commit one from a publishable folder. Regression tests seed a sentinel into every field
and prove none reaches any generated or exported artifact, error body or log.
