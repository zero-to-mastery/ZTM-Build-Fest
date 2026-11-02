# ADR 0240: Reader annotation validation is strict, scoped to the record, and never repairs or repeats reader text

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#84](https://github.com/journey-to-code-org/open.blog/issues/84)
- Parent story: [#30](https://github.com/journey-to-code-org/open.blog/issues/30)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0237, ADR 0238, ADR 0239

## Context

The document crosses a trust boundary whenever a reader imports a file: it is untrusted data, possibly
hostile or damaged, and it will later be shown in the page. A failure must leave what the browser already
holds untouched and say which record is at fault.

## Decision

- **No repair, no partial acceptance.** `readDocument` returns either a new frozen copy or the full list
  of problems, each `{ code, object, message }` with `object` such as `annotations[2] (quote-1)`. The
  caller keeps its existing data on any problem. The value passed in is never changed.
- **Messages name the field, never the text.** A message never repeats a reader's note, title, URL or
  path.
- **Unknown fields, kinds, versions and formats are refused with a code**, not ignored, so a newer or
  foreign file is not silently reduced.
- **Text rules.** Notes keep newline and tab; every other control character, bidirectional embedding,
  override or isolate, and any lone surrogate is refused, because they can make text display differently
  from what it says. Titles allow no control characters at all. Text is stored exactly as typed: no
  trimming or normalization.
- **URL rules.** A saved source is either a `url` or a `work` on a site, never both. A `url` is http(s)
  only, without credentials or spaces, in the form the URL parser writes. `javascript:`, `data:` and
  `file:` are `unsafeScheme`. Paths refuse traversal, encoded dots and separators, queries and fragments.
- **Trails** are one ordered line of at most 200 steps naming annotations or saved sources by id, once
  each. A trail never names a trail, and a dangling or repeated step is a problem.
- **Bounds.** A document is at most 4 MiB of UTF-8, counted before parsing; at most 2,000 annotations,
  500 saved sources and 50 trails; a note at most 10,000 characters; a title at most 200; a URL at most
  2,048; a path at most 512.
- **Escaping.** The contract returns data. Any page showing it writes it as text (`textContent`), never
  as markup, and builds links only from validated URLs and paths.
- **Where it lives.** `web/components/reader-annotations.js`, dependency-free and DOM-free, tested in
  `tests/web/reader-annotations.test.mjs` against `tests/fixtures/reader-annotations.json`.

## Consequences

- #85 to #87 call one reader and one exporter, and every failure is already scoped.
- Hostile-input and privacy regressions are fixtures, so they run in the ordinary web test suite.
