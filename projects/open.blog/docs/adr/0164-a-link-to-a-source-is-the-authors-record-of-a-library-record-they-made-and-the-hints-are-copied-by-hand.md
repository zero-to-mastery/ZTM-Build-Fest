# ADR 0164: A link to a source is the author's record of a library record they made, and the hints are copied by hand

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#228](https://github.com/journey-to-code-org/open.blog/issues/228)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0157](0157-converting-a-suggestion-is-an-explicit-author-action-that-records-an-id-and-never-enters-the-source-library.md), [ADR 0160](0160-editors-read-suggestions-in-the-one-inbox-and-copying-one-into-a-research-note-is-an-explicit-unverified-export.md), [ADR 0009](0009-research-source-library-identity.md), [ADR 0085](0085-rights-are-the-authors-declaration-per-version.md)

## Context

An accepted suggestion of a source may end up as a record in the author's private Source Library. The
library holds stable identities and per-version rights; a reader's hints are untrusted statements.

## Decision

- **Nothing writes the library.** Admin never creates, edits or reads a Source Library record on
  behalf of a suggestion. The inbox offers the author the suggestion's hints, from the core's
  `library_candidate` (the same actors, only for an accepted suggestion, never a question): the
  link, type, title, creators, year, publisher and identifiers, marked `unverified`, as plain lines
  inside a disclosure. Never the reader's words, name or contact, and rights stay the author's
  declaration. The author copies what they choose into a record of their own making, through the
  library's own screens, which validate it as any record.
- **The conversion records the id the author gave the record**, as a `library-source` link: a lowercase
  ASCII id of at most 64 characters, as the library keeps them. It is not checked against the library
  (the library is private and Admin does not read it here), and it is not followed. A link to a draft
  or series is the slug of one, as the site writes slugs, and likewise unchecked.
- **The explicit export stays two separate acts**: the research note copy
  ([ADR 0160](0160-editors-read-suggestions-in-the-one-inbox-and-copying-one-into-a-research-note-is-an-explicit-unverified-export.md))
  records no link, and a link copies no text. An author may do either, both or neither.
- **Output is deterministic**: the hints come out in a fixed order, from the same stored record,
  and a site that has no link and no candidate prints what it printed before.
