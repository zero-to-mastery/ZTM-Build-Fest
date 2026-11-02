# ADR 0008: Publish only the approved source attribution, as front matter

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#158](https://github.com/journey-to-code-org/open.blog/issues/158)
- Parent story: [#144](https://github.com/journey-to-code-org/open.blog/issues/144)
- Builds on: [ADR 0004](0004-portable-projections-from-canonical-work.md),
  [ADR 0007](0007-private-shared-publication-records.md)

## Context

ADR 0007 keeps each shared publication in a private record that never reaches the build. A
reader of the finished work still needs to see what prompted it: the original source and the
guiding question. That must work in the native page, Admin preview, feeds, and portable exports
without leaking participants, invitations, drafts, or other collaboration state.

## Decision

- The public attribution is the guiding question plus the first source's title, link, and type
  (`Public source attribution` in CONTEXT.md). Source IDs, provenance, creator, publisher, date,
  ISBN, later sources, and every participant, contribution, approval, and policy field stay
  private. Later sources are not published until a story defines how.
- It travels on the resulting Post as four flat front matter keys: `guidingQuestion`,
  `sharedSourceTitle`, `sharedSourceUrl`, `sharedSourceType`. The Post stays the canonical
  public work; no new store, API, or output path exists, so preview, build, feeds, and exports
  cannot disagree. `SharedAttribution::from_record` builds the approved subset and
  `front_matter_lines` writes it, so the later publish operation (#169) has one seam.
- Values are validated on load, not trusted: the link must be absolute HTTP(S) with no
  credentials (the record's own normalisation), the type one of the five known kinds, text one
  line within the record's byte limits without control or bidi characters. A violation fails
  the post load with a message naming the key, so a failed or tampered value publishes nothing.
  `from_record` drops a link that is no longer a safe public address and keeps the title.
- The source is always rendered as a plain link, never an embed. Supported providers (YouTube,
  CodePen) therefore need no fallback, and an unsupported provider degrades to the same link.
  Native, portable HTML, Markdown, and text show identical values; the portable projection
  lists the question, title, and link as required semantic facts, so a representation that
  loses one fails instead of exporting silently. Markdown escapes `<` and `&` as well, so an
  untrusted title cannot become raw HTML in an export.
- `llms-full.txt` lists the same two lines per post. Drafts remain excluded from every public
  output; authenticated preview reads the same Post.

## Consequences

- Posts without these keys render byte-for-byte as before.
- Embedding the source video, several public sources, and per-destination policies are
  deliberately left to later work; each can extend the keys without changing existing posts.
- The record is not read at build time, so editing or deleting it never changes published output.
