# ADR 0284: The voice library travels as one previewed, all-or-nothing export that keeps each item's folder

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#464](https://github.com/journey-to-code-org/open.blog/issues/464)
- Parent story: [#426](https://github.com/journey-to-code-org/open.blog/issues/426)
- Parent epic: [#410](https://github.com/journey-to-code-org/open.blog/issues/410)
- Builds on: ADR 0266, ADR 0267, ADR 0279 (and the portable-guide provenance rule recorded with ADR 0280)

## Context

An author should be able to take their voice library with them, and to bring it into another project, without
a hosted service and without any step quietly making private writing public. The repository already has a
pattern for this in `openblog paths export|import` (ADR 0217): one deterministic JSON file, a dry run unless
`--write`, all-or-nothing writes. The existing `openblog export <slug>` is about one post and is not the right
home, since samples are Assistant context and not posts.

## Decision

- **Two commands**: `openblog voice export [--out <file>] [--include-private] [--write]` and
  `openblog voice import <file> [--overwrite] [--as private] [--write]`. Both are dry runs unless `--write`.
  Export without `--out` prints the file; with `--out` and no `--write` it says what would be created. An
  export never replaces an existing file.
- **The file** is `openblog-voice-export` version 1: `samples` (each `visibility`, `file`, `content`) and an
  optional `guide` (`visibility`, `content`). `content` is the stored file's text byte for byte, so a valid file
  exports and imports byte-identically, and equal libraries give equal export bytes (sorted by file name, then
  folder). Pure code lives in `openblog_core::voice::exchange`; the CLI module `voice_exchange` does the I/O.
- **Private stays private by default.** Export carries the portable folder only. `--include-private` adds the
  private samples and the private guide, and then the file may be written only outside the project or under
  `.openblog/private/`, never where a build, a feed or Git could pick it up. One guide travels (the portable one
  when both exist, as the Assistant prefers it).
- **Import checks everything before it writes anything.** Every sample goes through the core parser (the same
  one that reads a hand-edited file), its file name must match the prompt, day and stage it holds, files over
  64 KiB, an export over 8 MiB or 100 samples, duplicate names and unknown visibilities are refused. A newer
  export version, or a sample in a newer sample format, is refused with a sentence telling the author to
  update. The preview lists `create`, `replace` or `unchanged` for each file and the folder it goes to; any
  problem means nothing is written. The write holds the voice store lock and puts every file back if a later
  one fails.
- **Visibility is explicit and one-directional.** An item lands in the folder the export says. An import never
  moves a sample between folders: a name that already exists in the other folder is a problem. `--as private`
  lands everything private and is the only override; there is no `--as portable`. When an import would write to
  the portable folder, the preview says that Git tracks it.
- **A rough draft is never replaced**, with or without `--overwrite`; an identical one is `unchanged`, a
  different one is a problem. A polished draft that differs is replaced only with `--overwrite`, and only when
  the stored file is the polished draft of the same rough draft. A polished draft needs its rough draft in the
  same folder, already stored or in the same import. Rough drafts are created by import without an open session:
  the session rule guards the writing of new text, and an import writes text the author already wrote.
- **The guide provenance rule holds on both sides.** A guide whose provenance line lists `private` sources is
  refused in a portable position on import and left out on export. The check is one function in the core
  (`voice::guide::quotes_private_samples`) that Admin's save also calls. A differing stored guide is replaced
  only with `--overwrite`.
- **No message echoes text from the input**; problems name file names (which passed validation) and fields.
- Admin has no import or export screen: the file moves between projects, and the command line is the
  place for it.

## Considered options

- **Put it in `portable_export`.** Rejected: that module renders one post. Samples are not posts.
- **One file per sample in a zip.** Rejected: a single text file reviews and diffs, and needs no archive code.
- **Let import choose a folder per item.** Rejected: one-way promotion is exactly the silent leak the epic rules out.

## What would trigger revisiting this

- More than a hundred samples in one library: raise the limit, or add chunked exports.
- An Admin import screen: it would call the same plan and apply functions.

## Consequences

- A library can be moved, backed up or shared on purpose, and an accident cannot make private text portable.
- The export is deliberately not a sync format: it has no deletions and never replaces rough drafts.
