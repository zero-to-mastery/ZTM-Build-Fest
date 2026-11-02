# ADR 0150: One research readiness report across Admin, check, build and preview

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#194](https://github.com/journey-to-code-org/open.blog/issues/194)
- Parent story: [#189](https://github.com/journey-to-code-org/open.blog/issues/189)
- Parent epic: [#15](https://github.com/journey-to-code-org/open.blog/issues/15)
- Builds on: [ADR 0123](0123-the-research-review-before-publication-adapts-todays-findings-to-the-completeness-contract.md),
  [ADR 0124](0124-review-acknowledgements-are-a-private-revisioned-file-of-keys-and-fingerprints.md),
  [ADR 0125](0125-one-publication-boundary-previewed-from-and-enforced-on-the-builds-own-projections.md),
  [ADR 0146](0146-one-research-completeness-contract-with-one-owner-per-check.md),
  [ADR 0147](0147-acknowledgements-never-resolve-a-finding-and-go-stale-when-it-changes.md),
  [ADR 0149](0149-the-publication-review-is-a-view-of-the-research-completeness-contract.md)

## Context

Research checks surfaced in different places in different shapes: evidence findings and source
review lines in `openblog check` and `openblog build`, atlas and claims notices as `notice:`
lines, the review before publication in Admin for one post, and nothing for the site as a whole.
An author could see a code in Admin that the terminal never printed, in another order, or not at
all. #194 asks for one readiness report, built on the unified contract, that Admin, `check`,
`build` and the preview that serves a build all show.

## Decision

- **One report, one gatherer.** `openblog_cli::readiness` gathers, for the saved site, each
  owning validator's findings through the loaders the build and the review already use
  (`research_review::read_published`), and hands them to
  `research_completeness::CompletenessReport`. Nothing is validated again. The report is
  grouped by `PublicationReview::scoped(.., ReviewScope::Site)` (ADR 0149): what the next
  build refuses first, then detected, potential and needs-review. Its JSON is the review's
  JSON (findings, groups, counts, `unmatchedAcknowledgements`, `notReviewed`, the
  acknowledgements file's revision, `applies`); there is no score, total, pass, ready or
  resolved field. The words in the name are the issue's; the report says it is prompts.
- **Same codes, same order, same words everywhere.** The terminal text is
  `PublicationReview::text`: one line per finding in the groups' order, then the counts, the very
  sentence Admin shows:

  ```text
  research <group> (acknowledged): <place>: <message> Repair: <repair> [<validator>: <code>]
  Research checks: <counts>
  ```

  A finding whose acknowledgement went stale says `(acknowledgement stale)` there instead.
  Core writes `tests/fixtures/research-readiness/report.json` and `report.txt` from fixed
  findings; the Rust tests prove the contract produces them, and the Admin tests read the same
  files and prove Admin lists the same codes in the same order with the same counts sentence.
- **Four surfaces, one report.**
  - Admin: `GET /admin/api/research/readiness` (authenticated and read-only like every Admin
    route) returns the report. **What will be public** shows it under the projections with the
    review's own renderer, `createPublicationReview` in its `embedded` and `site` variants, and
    **What this post makes public** shows the one post's review, embedded. The Research panel
    beside a draft shows the draft's counts and a button that opens the existing review. No
    second list, renderer or route was added.
  - `openblog check` prints the report after its existing output, whether or not those checks
    stopped early, so the findings behind a refusal use the same codes; it fails if anything
    blocks. `openblog check --json` prints the report as deterministic JSON and nothing else.
  - `openblog build` and `openblog serve` print the report after the build report (the preview
    serves the same build). The build reads it before it writes anything: a failure of a
    private file the build reads refuses the build while the output folder is exactly as it
    was.
  - A site with no research (no research or cited post, no stored research file, no finding)
    is not reported on: `check` and `build` print exactly what they printed before.
- **Blocking is the build's own refusal.** Only a `refuses` finding blocks the next build. A
  citation the build refuses once published (`refuses-when-published`) is listed under Detected
  for the site, with its reason in words, because a draft only warns; it blocks only in the
  review of the post being published (ADR 0123). A stale approval withholds one comparison and
  blocks nothing. Everything else is the author's to decide, and acknowledging it changes
  nothing but the private acknowledgements file.
- **Failures are object-scoped and non-destructive.** A file the build reads that cannot be read
  is one finding scoped to that file (or its own diagnostics), the parts that depend on it are
  listed as not reviewed instead of blaming another file, and a stored file the build does not
  read that cannot be read is listed as not reviewed. Reading writes, repairs and replaces
  nothing; an unreadable acknowledgements file is reported and acknowledging is disabled.
- **Provenance and missing details.** The report adds no data of its own: a finding names ids,
  fields and the stated values its validator already names, an imported record's provenance stays
  with its record, and a missing detail is stated as missing (the check's next action says
  where to record it) and never filled in.
- **Author-only and private.** Messages are the validators' own. No statement, note, excerpt,
  label or rights note, and no fingerprint input (`facts`) is serialized or printed; the report
  is Admin and terminal output only and reaches no public page, feed, export or log. Tests
  scan the JSON, the terminal text and every public artifact for sentinels.
- **One fixed set of posts.** The report is about every saved post, whatever a load holds back.
  `readiness::report` reads the saved site with its drafts and without the clock (kept per
  project for as long as its saved files are unchanged, so a rebuild of unchanged content, a
  second reader and `serve` pay for it once), and a caller that already holds every post
  (`check`) uses `report_of_all`. A draft or a post waiting for its date is warn-only in a site
  report, so reading it changes no outcome of a build, and Admin, `check`, `check --json`,
  `build` and `serve` list the same codes in the same order whether or not drafts are included.
  A post's own review gathers the source-review findings of that post too, so its codes are the
  site report's codes for that post.
- **`check --json` is always one envelope.** Standard output is the report plus an `error` field:
  `null` when the checks passed, the message when they did not or when the site could not be
  loaded (the report is then empty and `applies` is false). The exit status is `check`'s: nonzero
  when the site fails its checks or a failure of a private file the build reads refuses the next
  build.
- **A refusal carries the report.** A build error from a site with research prints the report
  beside the error (the build's own refusal usually fires first, on the file it cannot read), so
  the findings behind it use the contract's codes. The report's own refusal after a successful
  generation stays as a backstop for a file the build did not itself read.
- **Each finding is printed once.** When the report applies, `check` and `build` leave out the
  older `evidence ... [code]` and source-review lines, which the report lists with the same
  codes. Such lines exist only for a site with research, so a site without research is
  byte for byte what it was. A research site that raised nothing prints
  `Research checks: nothing to review`.
- **Scope-specific words.** A site report says a finding must be fixed "before the next build"
  and speaks of "the claims", not "this post's claims"; a post's review says "before
  publishing". The review's JSON names its `scope`. A place is named once, by the contract
  (`place` on each finding), in the terminal and in Admin's site report.
- **Accessible.** The embedded report is a labelled section whose heading sits under its
  panel's, groups are labelled lists, counts are in a polite status region, every link and the
  acknowledgement toggle (`aria-pressed`) are keyboard operable, and it reflows at 320 pixels
  with no sideways scroll, measured on each region.

## Consequences

- An author sees the same finding, in the same words and place in the order, in Admin and in
  the terminal, and a script can read it as JSON.
- A build that would have refused still refuses; what changes is that the refusal is listed
  with the contract's codes beside everything else, and that a refusal never follows a write.
- Nothing numeric is added: outcomes are counted apart.
- The report runs the loads a build runs, so a site with research pays about one more read of
  its private files per `check`, `build` and Admin refresh.

## Domain language

**Research readiness report** is defined in [`CONTEXT.md`](../../CONTEXT.md).
