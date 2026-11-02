# ADR 0062: Media moments locate attributed quotations and observations in a shared source

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#174](https://github.com/journey-to-code-org/open.blog/issues/174)
- Parent story: [#149](https://github.com/journey-to-code-org/open.blog/issues/149)
- Parent epic: [#143](https://github.com/journey-to-code-org/open.blog/issues/143)
- Builds on: [ADR 0008](0008-public-source-attribution.md),
  [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0045](0045-citation-locators-reuse-notebook-locators.md)

## Context

Contributors to a shared reflection want to pin what they say to a place in the source they all
watched, heard or read: a timestamp or range in a video or podcast, or a page or chapter in a book.
They also quote the source. The project already has three of the pieces. Shared reflections have a
source identity: the record's ordered source references (ADR 0008). The notebook has a locator type
with timestamp rules (ADR 0034), which citations reuse (ADR 0045). And the notebook keeps someone
else's words (a quoted excerpt) apart from the author's own (a research note). A second source
identity, a second locator type, or a stored transcript would duplicate these, and all three are
out of scope.

## Decision

- **A media moment** (`openblog_core::media_moment::Moment`) points by id (`source-N`) at one of the
  shared publication's own source references. It never copies the source or carries a URL of its
  own. It keeps its source for life: locating another source means making a new moment. A
  publication's moments may point at any of its sources.
- **Locations are the notebook's `Locator`s**, one to eight in order. They follow the citation shape
  rules (`citations::check_locator`), so a moment's locators can be cited unchanged. Timestamps are
  seconds or `h:mm:ss`, with an optional fraction. A moment has at most one timestamp, and a range
  must end strictly after it starts, compared exactly (`timestamp_value`). The notebook's private
  `extra` locator fields are refused. Locators must fit the kind of source:
  - Timestamps need a timeline, so they are refused for a Book or Article. An audiobook or a talk is
    Other.
  - Pages need text, so they are refused for a Video or Podcast.
  - A folio is never valid, because a shared source is never a manuscript witness. This is the
    shared page and folio rule from ADR 0045.
  - Chapter, section, line, canonical and `x-` locators fit any source.
- **Unknown duration is normal.** Nothing stores or requires a duration. `within_duration` answers
  only when a caller knows one.
- **Four things stay apart:**
  - The *quotation* is someone else's words. It is stored exactly as quoted, with no trimming,
    normalization or markup interpretation, and it is at most 1,000 characters: moments quote, they
    never hold a transcript.
  - The *speaker* is a plain, one-line name for whoever said the words in the source.
  - The *source attribution* is the record's source reference: its title, link and type.
  - The *participant* is the moment's owner and the author of its *observation*, which is the
    participant's own untrusted Markdown.

  A moment needs a quotation, an observation, or both.
- **Attribution comes from the session.** The participant is the authenticated requester, and a
  request cannot name it. The stored form denies unknown fields, so no one can slip in another
  identity, a credit, a token, a visibility flag or a URL.
- **Rights and provenance are explicit on every quotation, with no default.** Rights is the
  participant's statement: `unknown`, `briefQuotation`, `permission`, `openLicense`, `publicDomain`
  or `ownWords`. Provenance says where the text came from: `transcribed`, `copied` (from published
  text, captions or a published transcript) or `supplied` (by the speaker or rights holder).
  Neither is ever a legal determination. A quotation whose rights are `unknown` may stay in a
  private moment, but it cannot be proposed for the piece (ADR 0063).
- **Untrusted input fails safely.**
  - Quotations and observations refuse control characters (except newline and tab), line and
    paragraph separators, and bidirectional override and isolate controls.
  - Observations are at most 8 KiB. They refuse raw HTML, headings, footnotes, links that are not
    absolute HTTP(S) addresses, and images, because a remote image would tell its host who read it.
  - Errors name a field or a rule from the requester's own submission, and never repeat the text
    that was submitted.
- **Links are derived, never stored.** `Moment::link` starts from the source reference's stored
  address and normalizes it again. For a recognized YouTube address, it rebuilds a link that starts
  at the moment (`t=<seconds>s`). For every other provider, it returns the original link unchanged,
  so missing, blocked or unsupported media still leaves a working link to the source. A source with
  no address gives no link.

## Consequences

- One source identity, one locator type and one quotation/observation split serve the notebook,
  citations and shared reflections.
- A page locator on a book assumes that the shared source describes the copy the participants read.
  Shared sources have no edition records to check against.
- Changing a source's kind can leave a moment whose locators no longer fit. `unresolved` reports
  such moments so that a later gate can refuse them.
- Capture UI is #175, rights guidance is #176, and rendering is #177.

## Domain language

**Media moment**, **Moment quotation**, **Speaker**, **Moment observation** and **Quotation
rights** are defined in [`CONTEXT.md`](../../CONTEXT.md).
