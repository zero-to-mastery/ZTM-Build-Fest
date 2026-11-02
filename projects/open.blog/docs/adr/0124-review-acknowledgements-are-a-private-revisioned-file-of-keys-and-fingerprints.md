# ADR 0124: Review acknowledgements are a private, revisioned file of keys and fingerprints

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#62](https://github.com/journey-to-code-org/open.blog/issues/62)
- Parent story: [#24](https://github.com/journey-to-code-org/open.blog/issues/24)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0034](0034-private-passages-and-research-notes.md),
  [ADR 0123](0123-the-research-review-before-publication-adapts-todays-findings-to-the-completeness-contract.md)
- Coordinates with: ADR 0147 on `story/rw9-research-completeness`, which defines the
  acknowledgement and its fingerprint and leaves where they are kept to the report that shows
  them, and [#194](https://github.com/journey-to-code-org/open.blog/issues/194)

## Context

The review before publication (ADR 0123) lets an author acknowledge an advisory finding, so a
prompt they have considered (a whole-work source that needs no locator, a doubt with no source
behind it) stops asking for attention without being called resolved. RW9's contract defines what
an acknowledgement is and when it stops applying, and leaves storage to the report that shows
acknowledgements. #62 is the first such report, so it decides storage now; #194 inherits it.

## Decision

- **One private file.** Acknowledgements live at
  `.openblog/private/research/acknowledgements.json`, beside the other research files, inside
  the Git-ignored private directory that no build, feed, search index or export reads, and that
  the private-research guards already refuse to copy into public inputs or output.
- **Exactly ADR 0147's record.** The file is `{ "version": 1, "acknowledgements": [...] }`. Each
  record is the finding's `validator`, `code`, `object`, optional `path`, `id` and `field` (the
  key) and its `fingerprint` (32 lowercase hexadecimal characters). There is no note, person,
  time or `resolved` field, and unknown fields are refused, so a record cannot claim more or
  carry anything private. Records are kept sorted and duplicate-free; at most 5,000, and the
  file at most 2 MiB.
- **Only what the contract allows.** A record is accepted, stored or applied only for an
  advisory code of its owning validator. A request to acknowledge an integrity or privacy
  failure is refused with 422 and nothing is written; a stored record that names one is never
  applied, and a file with any invalid record is refused whole and reported, never partly used.
- **Two routes, revisioned and atomic.** `PUT /admin/api/research/review/acknowledgements` adds
  one record and `DELETE` withdraws exactly one (its key and fingerprint), so another finding
  under the same key keeps its own. Each names the revision (SHA-256 of the file's bytes, or of
  the empty file while none exists) the review returned; a stale one is refused with 409 and the
  current revision. A change is written to a temporary file, flushed and renamed over the old one
  under a lock, so a refused, failed or interrupted change leaves the stored file exactly as it
  was. Reading never creates a file or directory. Both routes sit behind the session, CSRF token
  and deny-by-default router, and a body over 16 KiB is refused.
- **Never resolved.** The review marks a finding `current` when a record has its key and
  fingerprint and `stale` when a record has its key but a fingerprint no finding under that key
  has now. An acknowledged finding is still listed, still has its outcome and is still counted in
  `found`; `acknowledged` counts current ones per outcome; a stale one counts for nothing.
  Records no finding matches are counted as `unmatchedAcknowledgements` and never shown as
  resolutions. The Admin says "You acknowledged this. It stays listed and counted until the
  record itself changes", or that it changed since.
- **Unreadable is reported, not repaired.** If the file cannot be read, the review still runs,
  shows no acknowledgements, disables acknowledging and names the file to repair by hand.

## Consequences

- Acknowledging is reversible and survives sessions and devices that share the project.
- The file holds keys that name post paths and research ids, as the research files already do,
  and nothing more; it is private like them.
- #194 reads and writes the same file and records; adopting RW9's richer fingerprints only makes
  some records stale, which asks the author again rather than hiding anything.

## Domain language

**Finding acknowledgement** is defined in [`CONTEXT.md`](../../CONTEXT.md).
