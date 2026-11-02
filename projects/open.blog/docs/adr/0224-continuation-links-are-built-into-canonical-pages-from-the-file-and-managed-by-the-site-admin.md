# ADR 0224: Continuation links are built into canonical pages from the file and managed by the site Admin

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#231](https://github.com/journey-to-code-org/open.blog/issues/231)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: ADR 0218 to ADR 0223, [ADR 0181](0181-features-publish-from-community-perspectives-json-beside-third-perspectives-json-and-read-strictly.md)

## Context

The semantics (ADRs 0218 to 0223) were pure. Readers need the links on the pages, and editors need a way to make, remove and audit them, without the static site ever depending on the hosted service.

## Decision

- **Build.** The site load reads `continuations.json` beside the other published files, strictly: a damaged file refuses the build, naming the file and never its contents. Each edge goes through `resolve` against the posts published now (not a draft, not waiting for its date) and the series those posts name. An edge that does not stand is absent and only warned about, with the edge id and a fixed reason. The section is rendered on the canonical page of both ends: "Where this question went" on the earlier page, "Earlier questions this continues" on the later one, as plain links with the no-causation notice and nothing else. The two sections have distinct ids (`ob-continuations`, `ob-continuations-earlier`) and each item an anchor (`ob-continuation-<id>`). Feeds, search, `llms` files and portable copies carry nothing of it, as for featured reflections.
- **Approved at build time.** The build cannot ask the hosted service, so it treats every edge in the file as approved. The file is written only by Admin for a submission it saw approved, and Admin removes the edges when that stops being true. This keeps static reading complete without a service.
- **Series.** The later page's own series slug is recorded, so reordering a series changes nothing about a link. No series rename mechanism exists yet, so the alias map is empty; a slug no post uses drops only the series label.
- **Admin.** Routes, all the site Admin's and denying everyone else: `GET engagement/continuations` (the links with their standing and the published works), `POST .../preview` and `.../link` (the kind, the earlier page and the series come from the hosted submission and the site, never the request; the item must be approved, its text kept, and both pages published; a stale version is refused), `POST .../unlink` and `POST .../sweep`. The note passes the same lint as on file read, and a refused note names the rule, never a reader's words.
- **Taking links off.** When a moderation decision leaves a submission not approved (remove, withdraw, reject) or erases its text, or an upheld report takes it down, Admin drops its links in the same request and rebuilds. A submission withdrawn on the hosted side is found by the audit, which marks the link `notApproved`, and removed by the sweep. A hosted service that cannot be asked marks a link `unknown` and the sweep keeps it: nothing is dropped on a guess.
- **Portable copies.** Canonical page only, like featured reflections; a portable copy keeps its link to the canonical page.
- **Out of scope.** Subscriptions (#232) and automatic related-content inference.

## Consequences

A withdrawal on the hosted side leaves the public link until an editor runs the sweep. It shows only a title and the editor's note, never the reader's words, so the cost is a stale link, not a leak.
