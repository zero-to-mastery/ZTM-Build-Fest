# ADR 0072: The claims file takes its lock after the atlas, and guards the sources and passages it uses

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#45](https://github.com/journey-to-code-org/open.blog/issues/45)
- Parent story: [#20](https://github.com/journey-to-code-org/open.blog/issues/20)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0056](0056-one-lock-order-and-cross-store-research-guards.md),
  [ADR 0071](0071-private-claims-storage-checked-against-the-saved-draft.md)

## Context

ADR 0056 ordered three research locks: atlas, then notebook, then library. The claims file is a
fourth store that, like the atlas, points into the notebook and the library but not into the
atlas, and nothing points into it. A removal elsewhere that left an evidence link dangling would
make the claims file unreadable and block every later claims change.

## Decision

- **One order: atlas, claims, notebook, library.** A claims write takes the claims lock, then the
  notebook lock, then the library lock, and holds all three while it reads, validates and
  renames. An atlas write takes atlas, notebook and library as before, and never the claims lock;
  a claims write never takes the atlas lock. A notebook write takes notebook then library, and a
  library write takes library. Every writer takes its locks in the one order, skipping those it
  does not need, and nobody takes a lock earlier in the order than one they hold, so no two
  writers can wait on each other. Claims sit after the atlas so that a future store depending on
  both still extends the order at the front, as ADR 0056 intended.
- **Readers hold the writer out.** A source removal reads the claims file under the library lock,
  and a notebook change reads it under the notebook lock; every claims write holds both for its
  whole critical section, so those reads are stable.
- **A source a link rests on cannot be removed.** `source_store::remove` asks
  `claims_store::uses_of_source` after the notebook and atlas checks and refuses with
  `still-used`, naming the link ids.
- **A passage a link points to cannot be removed.** `notebook_store::remove_passage` asks
  `claims_store::uses_of_passage` and refuses with `still-linked`, naming the link ids and never
  the quoted text.
- **An unreadable claims file blocks removals, not edits.** If the file cannot be read, removing
  a source or passage is refused because it cannot be shown to be unused; other library and
  notebook edits continue.
- **Edits that would break a valid claims file are refused.** Every notebook change, and every
  library update or CSL import, re-validates a claims file that was valid before against the
  changed store and refuses the change if it would become invalid, as for the atlas.

## Consequences

- Removing the last use of a source or passage takes two steps: change or remove the evidence
  link, then remove the source or passage.
- Claims writes serialise with notebook and library writes but never with atlas writes.
