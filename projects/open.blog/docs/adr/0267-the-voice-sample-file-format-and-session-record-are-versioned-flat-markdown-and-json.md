# ADR 0267: The voice sample file format and session record are versioned, flat Markdown and JSON

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#430](https://github.com/journey-to-code-org/open.blog/issues/430)
- Parent story: [#411](https://github.com/journey-to-code-org/open.blog/issues/411)
- Parent epic: [#406](https://github.com/journey-to-code-org/open.blog/issues/406)
- Builds on: ADR 0266

## Context

Every later feature (CLI sessions, Admin sessions, Assistant context) reads and writes the same files. Files
people keep for years are a one-way door: once authors have a library, a format change must never lose or
rewrite it. So the format is small, versioned from the first byte, and conservative about what it accepts.

## Decision

### The sample file

- **A Markdown file**: front matter, one blank line, the author's text, one final newline. The reader removes
  exactly that one blank line and one final newline and nothing else, so the author's own blank lines and
  indentation survive. CRLF is read as LF, a byte order mark is dropped, and a non-UTF-8 file is refused.
- **Flat front matter.** The repository's front matter parser is a deliberately small flat subset, with no
  nested maps. The `voice` block of the epic is therefore written as dotted keys: `voice.format`,
  `voice.catalog`, `voice.pack`, `voice.prompt`, `voice.stage`, `voice.timeLimitSeconds`, `voice.words` and
  `voice.roughOf`. The post parser treats them as unknown keys, so a sample accidentally placed in
  `content/posts/` would parse rather than crash (and the store never writes there). The other keys are
  `title`, `subtitle`, `slug`, `date` (RFC 3339 with a time), `description` and `tags`.
- **`voice.format` is the file format version** (this release writes 1 and reads 1). A file with a newer
  format is refused with a sentence telling the author to update, and is never rewritten. `voice.catalog` is
  the prompt catalog version the prompt came from; a newer one is refused the same way (ADR 0268).
- **Strict where it protects the library.** Unknown `voice.stage` values, a polished draft without
  `voice.roughOf`, a rough draft with one, a `roughOf` that is not the file name of a rough draft for the same
  prompt, an empty body, null characters and ids that are not lowercase kebab-case are all refused, each with
  a sentence naming the field. Files are at most 64 KiB.
- **Lenient where it protects the author.** Keys this release does not know (including unknown `voice.*`
  keys) are kept and written back, after the known keys, in alphabetical order, so a newer release's additions
  survive an older one's save. `voice.words` is informational and is not checked against the text.
- **Deterministic.** Equal samples serialize to equal bytes: known keys in a fixed order, then the rest
  alphabetically. A valid file written by this release parses and serializes back byte-identically.
- **File name**: `<YYYY-MM-DD>-<prompt-id>-<stage>.md`. The day is the day the rough draft was written; a
  polished draft takes the day of its rough draft, so each rough draft has at most one polished draft and the
  pair sorts together.

### Where samples live

`assistant/context/voice/` (portable) or `.openblog/private/context/voice/` (private), beside the other
Assistant context. Neither is read by a build.

### From a polished draft to a post draft

`VoiceSample::to_post_draft(existing_slugs)` is pure. It copies `title`, `subtitle`, `slug`, `date`,
`description`, `tags` and the body into post front matter, drops the whole `voice` block and every unknown key
(they may be private notes), and adds `draft: true`, the existing convention that keeps a post out of a normal
build. The suggested file is `<day>-<slug>.md`. Only a polished draft can become a post draft, because the
rough draft is never the thing an author would publish and never changes; the post is a copy and the sample
stays where it is. A slug already used by a post is an error naming the slug, never renamed silently. The
result loads through the ordinary post loader (tested).

### The store

`crates/openblog-cli/src/voice_store.rs` is the only code that reads or writes sample files.

- **Contained, bounded, revision-checked.** Paths are resolved with `assistant_storage::contained_target`
  (a symlinked folder cannot redirect a write), files are at most 64 KiB of UTF-8, and a change to a polished
  draft carries the revision (SHA-256 of the file's bytes) the caller read. A different current revision is a
  `Stale` error that says what the revision is now, and nothing is written. Writers hold a lock file under
  `.openblog/private/voice/`.
- **Rough is create-once.** `write_rough` is allowed only while a session record is open for that prompt
  (below), creates the file with a no-replace atomic write, and refuses everything afterwards, with one
  exception that is not a change: writing the identical bytes again (a lock repeated after a crash) succeeds
  and touches nothing. No other function replaces a file that is, or claims to be, a rough draft.
- **Polished is update-with-revision.** `write_polished` requires the rough draft to exist in the same folder
  with the same prompt, takes its own file name from it (so there is one polished draft per rough draft),
  and replaces only a polished draft it can read: the existing file must parse in this release's format, be
  polished, and carry the same prompt and `roughOf`. A file in a newer format, or one that does not parse, is
  left as it is. Keys the existing file has and the new save lacks are carried over.
- **Moving and erasing.** A move copies the pair's bytes unchanged, checks the copies, then removes the
  originals, polished first and rough last; it never overwrites a different file. A byte-identical copy already
  at the target counts as moved, so an interrupted move is finished by repeating it. Once an original has been
  removed, no copy is ever deleted; the failure says the move is partly done. Erasing a rough draft that has a polished one needs both to be named.
- **Listing never hides trouble.** Every `.md` file in either folder is listed. A file that cannot be read
  (not UTF-8, too large, bad front matter, a name that disagrees with its content, a link instead of a file,
  a polished draft whose rough draft is gone) is listed as invalid with a sentence on how to repair it.
- **Opt-in by construction.** Reads and listing create nothing. The first write creates the folders. A private
  write, and every session start or save (the record holds the draft), adds `/.openblog/private/` to a Git project's `.gitignore` if it is not already ignored, as landing
  history does (ADR 0264).
- **Never public.** A build reads only the content folder; tests prove a build is byte-identical with and
  without samples, that no sample text reaches any built file (including a drafts preview build), that
  `openblog init` creates nothing voice-related, and that publishing never stages `.openblog/private/` (it
  refuses if one is force-added). A portable sample is committed only if the author's `publish.paths`
  includes `assistant`, like other portable Assistant context.

### The session record

`.openblog/private/voice/session.json` (always private, whatever the sample's folder will be) is the only
state of a voice session: `{ format: "openblog-voice-session", version: 1, promptId, pack, catalogVersion,
startedAt, deadline, timeLimitSeconds, draft, surface, visibility }`.

- **One per site.** Starting a second session is refused with `AlreadyOpen` (and says whether the first has run
  out of time), so the surface can ask the author to lock or scrap it. A prompt already written today cannot be
  started again, which keeps the rough file name unique.
- **Resumable on any surface.** Resuming reads the record: with time left it returns the remaining seconds and
  the draft, with the original deadline; the clock is never restarted.
- **Expiry locks from the saved text.** Resuming an expired session locks the rough draft from the last saved
  draft (an expired session with nothing saved is discarded). A final text handed over at zero is accepted
  within 10 seconds of the deadline, to allow for a request in flight; later than that the saved text wins.
  Saving a draft takes no such grace: it is refused from the deadline on. A record whose deadline is later
  than its start plus its time limit is treated as damaged.
- **The only way a rough draft is born.** Locking calls `voice_store::write_rough`, which requires this record
  to be open for that prompt, and then removes the record. The record is also removed by a scrap (which writes
  nothing). Both are repeatable after a crash: a lock whose rough file already holds identical bytes succeeds.
- **Crash-safe.** The record is written to a temporary file, flushed, and renamed over the old one, so a crash
  leaves the old record or the new one, never half of one.
- **Versioned.** A record with a newer `version` is reported and never rewritten, removed or scrapped by this
  release; a damaged one can be scrapped.
- Line endings in the draft are normalized to LF when saved. No other change is ever made to the text.

## Considered options

- **Nested `voice:` map as in the epic text.** Rejected: it needs a second front matter parser, and a
  different parser reading the same file differently is exactly the bug a one-way door must not have.
- **JSON files.** Rejected: authors should be able to read and edit their polished drafts in any editor.
- **One file with both stages.** Rejected: the rough file must be written once and never touched, which is
  only simple to enforce when it is a file of its own.

## What would trigger revisiting this

- A field authors need that cannot be an additive key. That is `voice.format: 2`, with a documented upgrade
  and the rule that an older release never overwrites a newer file.

## Consequences

- Equal bytes in, equal bytes out lets the store prove a moved rough draft was not changed.
- The store and the session record are the two places that decide what may be written; every surface calls them.
