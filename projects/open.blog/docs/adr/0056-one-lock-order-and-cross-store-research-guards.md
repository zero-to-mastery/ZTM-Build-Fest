# ADR 0056: Take research locks in one order and refuse removals that would break the atlas

- Status: Accepted
- Date: 2026-10-25
- Decision issue: [#49](https://github.com/journey-to-code-org/open.blog/issues/49)
- Parent story: [#21](https://github.com/journey-to-code-org/open.blog/issues/21)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0035](0035-private-notebook-storage-and-admin-capture.md),
  [ADR 0055](0055-private-knowledge-atlas-storage.md)
- Contract: [Knowledge Atlas format](../specs/knowledge-atlas.md)

## Context

Three private files now depend on each other: the notebook points into the library, and
the atlas points into both. ADR 0035 made notebook writes take the notebook lock and then
the library lock, and made a source removal check the notebook under the library lock. The
atlas adds a third lock and two new ways to break a valid file: removing a source the atlas
cites, or a passage its evidence points to. A refused atlas would be worse than a refused
notebook entry, because an atlas that fails to parse blocks every later atlas change.

## Decision

- **One lock order: atlas, then notebook, then library.** An atlas write takes all three in
  that order and holds them while it reads, validates and renames. A notebook write takes the
  notebook then the library lock, and a library write the library lock, as before. Each
  writer takes a suffix of the one order, so no two writers can wait on each other. Nobody
  takes a lock that comes earlier in the order than one they hold.
- **Readers of a dependent store hold the dependency's writer out.** A store that only reads
  a file that depends on it does so while holding its own lock. Every writer of that
  dependent file also holds this lock for its whole critical section, so the read is stable:
  a source removal reads the notebook and atlas under the library lock, and a notebook change
  reads the atlas under the notebook lock.
- **A source the atlas uses cannot be removed.** `source_store::remove` asks
  `atlas_store::uses_of_source` (work entries, evidence, assertion and dissent attribution)
  after the notebook check and refuses with `still-used`, naming the atlas ids.
- **A passage atlas evidence points to cannot be removed.** `notebook_store::remove_passage`
  asks `atlas_store::uses_of_passage` and refuses with `still-linked`, naming the
  relationship ids and never the quoted text. So removing a passage can never leave the atlas
  unparseable.
- **An unreadable atlas blocks removals, not edits.** If the atlas cannot be read, removing a
  source or a passage is refused, because it cannot be shown to be unused. Other library and
  notebook edits are not blocked by an atlas that was already broken.
- **Edits that would break a valid atlas are refused.** Every notebook change, and every
  library update or CSL import, re-validates a stored atlas that was valid before the change
  against the changed store, and refuses the change if the atlas would become invalid (for
  example, re-pointing a reference so an evidence page locator turns ambiguous). This is the
  same rule ADR 0035 applies to the notebook.

## Consequences

- Removing the last use of a source or passage takes two steps: change the atlas, then
  remove the source or passage.
- Atlas writes serialise with notebook and library writes; all are short and wait at most
  two seconds for a lock.
- A future store that depends on the atlas takes its lock before the atlas lock, extending
  the order at the front.
