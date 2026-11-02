# ADR 0286: Job archives are derived from job posts and page like the home page

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#493](https://github.com/journey-to-code-org/open.blog/issues/493)
- Parent story: [#476](https://github.com/journey-to-code-org/open.blog/issues/476)
- Parent epic: [#471](https://github.com/journey-to-code-org/open.blog/issues/471)
- Builds on: ADR 0285

## Context

Finished work should be browsable the way customers look for it: all of it, by trade, and by service within a
trade. Tags already give an archive page per tag, but a trade and a service are fields of the `job` mapping, not
tags an author has to keep in step.

## Decision

- **Three kinds of archive, derived, never authored.** `openblog_core::job_archive::plan` groups the site's job
  posts into `/jobs/`, `/jobs/<trade>/` and `/jobs/<trade>/<service>/`. The service sits under its trade, so two
  trades can each have a `repair` service. The plan is pure, ordered (all, trades by name, services by trade and
  service) and has no entry for a group with no jobs, so an empty archive is never emitted and a site with no
  jobs builds as before.
- **Rendered like a tag page.** The renderer uses the same section, heading, post list and tag-cloud list
  styling, so themes need no change. The all-jobs page lists trades with counts and a trade page lists its
  services.
- **Paged like the home page.** Tag archives are one page. Jobs are the work a business wants to show and can
  run to hundreds, so archives use `postsPerPage` with the same pager; page 2 is `/jobs/page/2/`. A group that
  fits on one page is exactly one page, like a tag. `page` cannot be a trade or service id because it is the
  pagination path.
- **Sitemap yes, feeds no.** The first page of every archive is in `sitemap.xml`. RSS and JSON Feed carry jobs
  as ordinary posts and gain no archive entries.

## Considered options

- **Generate tags from `trade` and `service`.** Rejected: it would change every job's tag list and every tag
  archive, and break the rule that a site not using jobs is unchanged.
- **A flat `/jobs/<trade>-<service>/`.** Rejected: it hides the hierarchy and can collide.

## What would trigger revisiting this

- A reader need for filtering by town: that would be a new archive kind, still derived from the job mapping.

## Consequences

- Adding a job never means editing an archive; the right pages appear.
- The archive URLs are public and stable, so renaming a trade or service id changes them.
