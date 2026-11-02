# ADR 0226: A comparison is its own public content type and one versioned file

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#88](https://github.com/journey-to-code-org/open.blog/issues/88)
- Parent story: [#31](https://github.com/journey-to-code-org/open.blog/issues/31)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)

## Context

The private source library already records an *interpretation* (ADR 0087): who rendered or read one
located place in one version of a source. It is private research and is never published. Story B7
needs something different: an author's public, side-by-side comparison of several attributed readings
of one subject, with audience-level explanations. Reusing the library record would put public text in
a private file and risk publishing by accident; folding it into a post would make it impossible to
compare across posts or to project it on its own.

## Decision

- **Its own type and file.** `content/comparisons/<slug>.json`, format
  `openblog-interpretation-comparison`, `version` 1, holding `title`, `subject`, `status` (`draft` when
  absent, so leaving a field out publishes nothing), `interpretations`, `relations` and
  `explanations`. The slug is the file name (never a Windows device name). It changes no post, source,
  claim or atlas entry, and nothing else reads it yet.
- **Reading-path idiom (ADR 0208).** The file is read by hand so no message echoes a value; a repeated
  key and another version are refused; fields this release does not define are kept and written back
  after the defined ones; `to_canonical_json` is byte-stable (two-space JSON, fixed order, `\n`, one
  final newline). A golden file is tested byte for byte.
- **Plain text, bounded.** Control and bidirectional-direction characters are refused (statements and
  explanations may span lines). Limits: 50 interpretations, 150 explanations, 200 relations, 20
  evidence references per item, 512 KiB per file.
- **Scoped, write-nothing failures.** Parsing is pure. A problem names the file and an item id, never
  the item's text, and one bad file leaves the others loading. Admin saves (#89) use the existing
  revision-checked atomic seams.
- **Opt-in.** A site without `content/comparisons` is unchanged.

## Consequences

- Posts, recipes, research, series and contributor credits are untouched.
- A comparison's interpretation cannot be cited as a source: it is a reading, not a record.

## Domain language

**Interpretation comparison** is defined in [`CONTEXT.md`](../../CONTEXT.md).
