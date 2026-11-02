# ADR 0151: The scholarly-safeguard corpus exercises every matrix row through its real emitter

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#195](https://github.com/journey-to-code-org/open.blog/issues/195)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md),
  [ADR 0147](0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md),
  [ADR 0148](0148-source-review-prompts-identifiers-versions-quotation-locations-and-citation-consistency.md),
  [ADR 0150](0150-one-research-readiness-report-across-admin-check-build-and-preview.md)
- Documentation: [Research checks](../research-checks.md)

## Context

The research-completeness contract has 177 matrix rows owned by 12 validators. Each had unit tests
beside its validator, but nothing proved that every row can still be produced by the validator that
owns it, that the distinctions authors record (original work, edition, translation, witness,
reference, citation, source location, research note, claim, evidence, interpretation, contextual
entry, scholarly disagreement) fail independently, or that none of it leaks private research.

## Decision

- **One invented corpus** in `tests/fixtures/scholarly-safeguards/`: `corpus.json` (cases that are
  overlays on one clean project), `hostile.json` (hostile inputs built by changing one thing in a
  valid document, and refused change operations) and `import.json` (CSL items). Every work, person,
  passage and claim is invented; nothing is an authoritative dataset or a real excerpt.
- **Every matrix row, through its real emitter.** Each case names the findings it must produce.
  Every prompt row, including `claims: file-unreadable`, runs through
  `openblog check --json` and `openblog build` (Rust, `tests/scholarly_safeguards.rs` in the CLI
  crate); integrity rows run through the owning parser or change operation (core
  `tests/scholarly_safeguards.rs`). The site report once never loaded the claims file, so an
  unreadable one refused the build without appearing in the report, and the corpus kept that row in
  an Admin-only layer; the report now reads it with the other files the build reads, and the row runs
  like every other. A core test fails when any matrix row has
  no case, or a case names a row the matrix lacks.
- **Each distinction fails independently and can pass.** Every distinction has a case that emits
  findings and a case that emits none, and a case emits exactly what it names, in either direction.
  Every distinction also has a failing case that tags it alone, and each such case names only
  findings from the validators that own that distinction, so one distinction cannot fail through
  another's rows.
- **No fixture implies influence from similarity alone.** Passages that read alike and people born a
  year apart are recorded with no relationship; an `influenced` relationship must cite evidence;
  neither the findings nor a built page speaks of influence.
- **Imports keep provenance and invent nothing.** An imported item keeps a stable id from its own,
  lists what the library cannot hold, never imports private notes, and stays bare when it is bare.
  The hostile import fixture changes nothing in a corpus library.
- **Non-destructive and private.** Running `check` writes nothing; no finding, terminal line, JSON
  or built file repeats a statement, rationale, note or excerpt. A case that approves something is
  scanned for the words of every item it did not approve, and for the rationale, uncertainty and
  notes of those items.
- **A pinned list of what v0.39.0 let an author acknowledge** stays acknowledgeable, so no stored
  acknowledgement silently stops matching; additions are the source-review rows of ADR 0148.
- **Documentation** (`docs/research-checks.md`) explains each code in plain language with its fix,
  what acknowledging does and does not mean, and what stays private. A test fails when a row's
  code is not explained there, and the documentation link check covers its links.

## Consequences

- Adding a matrix row without a corpus case, or a case without its documentation, fails a test.
- The corpus is test data only: it is never read by a build, never shipped, and adds no dependency.
