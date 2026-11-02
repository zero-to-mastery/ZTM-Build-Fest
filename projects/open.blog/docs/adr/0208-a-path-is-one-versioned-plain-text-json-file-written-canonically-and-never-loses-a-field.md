# ADR 0208: A path is one versioned plain-text JSON file, written canonically, and never loses a field

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#76](https://github.com/journey-to-code-org/open.blog/issues/76)
- Parent story: [#28](https://github.com/journey-to-code-org/open.blog/issues/28)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0207](0207-a-reading-path-is-its-own-content-type-and-never-a-series.md)
- Contract: [Reading paths](../specs/reading-paths.md#file)

## Context

A path is public, author-written content that Admin and a text editor must both be able to change
without disagreeing. Its steps are nested records with their own rationale and transition, which
the front matter parser (a YAML subset for flat post metadata) does not model, and the existing
sidecar for work credits (`<post>.credits.json`) already shows the repository's answer for nested
public data beside Markdown: a small versioned JSON file.

## Decision

- **Where and what.** `content/paths/<slug>.json`, format `openblog-reading-path`, `version` 1. The
  slug is the file name (a lowercase ASCII slug of at most 64 characters), so it can never disagree with
  a field and a rename is a file rename. The file holds `title`, optional `summary`, `status`
  (`draft` when absent, so leaving a field out publishes nothing), `listed` (ADR 0212) and `steps`.
- **Versioned.** `format` and `version` are required. Another version is refused with its number,
  never read as version 1.
- **Lossless: keep what is not defined, refuse what is defined wrongly.** This is the atlas and
  notebook idiom (ADR 0053, ADR 0034). Fields this release does not define are kept as written, at
  every level (the file, a step, a target, a transition), and written back after the defined ones in
  name order, so a parse followed by a save loses nothing and an older release still reads a newer
  file's known fields. Kept fields are inert: never read, never in the public value. A defined
  field of the wrong type or outside its list of values is refused, naming the field and never the
  value, and another `version` is refused. A repeated key is refused rather than collapsed to the
  last one, because a hand edit that pastes a field twice must be told. (The first draft of this
  ADR refused unknown fields; review #76 replaced that so an older binary can read a newer file.)
- **Messages never echo a value.** The file is read by hand, not through a generic deserializer
  whose errors quote what was written, so a message names a field (`` `status` must be `draft` or
  `published` ``) and a hostile value never reaches a log or an Admin error.
- **Canonical and deterministic.** `ReadingPath::to_canonical_json` writes two-space JSON in a fixed
  field order, omits absent optional fields, uses `\n` and ends with one newline. Parsing it gives the same
  path and writing that gives the same bytes, so an Admin save and a hand edit of the same path
  differ only when the content differs. The step order is the author's and is never sorted.
  A checked-in golden file is tested byte for byte.
- **Plain text only.** Every text field is plain text on one line, escaped wherever it is shown.
  Control and bidirectional-direction characters are refused, and so is an `atlas:` link, which a
  path does not resolve (ADR 0173 shows such words as typed; here the author is told instead, as
  nothing can show them as a link). Titles hold 120 characters, a transition, rationale
  or summary 600, a prerequisite note 400; a path holds 100 steps, a file 256 KiB and a site 200 paths.
- **Failures are scoped and write nothing.** Parsing is pure. A refused file yields problems that name the
  file, the step id and a rule (never a step's text) and leaves every other file loading. The
  loader reads the bytes it is given and writes nothing, so a refusal leaves canonical files
  unchanged. Admin (#77) owns conflict-safe, atomic saves through the existing store seams.
- **No addresses are stored.** A step names a post slug or an atlas id, never a URL or a file path,
  so there is no scheme or traversal to validate and a moved post cannot leave a stale address.

## Consequences

- The file is easy to review in a pull request and to diff, and a mistake is one scoped message.
- A hand-edited path with a field from a future release is read for what it defines and saved
  without damage to the rest.
- A field that changes meaning still needs a version bump, because an older release would keep it
  and not act on it.

## Domain language

**Reading path** is defined in [`CONTEXT.md`](../../CONTEXT.md).
