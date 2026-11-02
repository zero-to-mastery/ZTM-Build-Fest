---
title: Publishing and scheduling
date: 2026-01-26
series: getting-started
seriesOrder: 3
tags:
  - guide
description: Build the site, host it anywhere, keep a draft private, and schedule a post for later.
---

## Build and host

```sh
openblog build
```

writes a complete static site to `dist/`: pages, RSS and JSON feeds, a sitemap, a search
index, and the assets. Upload that folder to any static host, or run `openblog serve` to
host it yourself.

## Drafts

`draft: true` keeps a post out of every build and feed. `openblog serve --drafts` previews
drafts locally. The admin editor shows drafts with their own badge.

## Scheduling

Give a post a date in the future and it is *scheduled*:

```yaml
date: 2026-12-25T09:00:00Z
```

Scheduled posts stay out of the pages, feeds, sitemap, and search index. When the time
comes, `openblog serve` rebuilds by itself. On a static host, any `openblog build` after
that time publishes it, so a daily build (a cron job or a scheduled workflow) is enough.

## The admin editor

For editing from a browser, including on the server that hosts the blog:

```sh
openblog user add you
openblog serve --admin
```

Then open `/admin`. It writes the same Markdown files, so you can mix both ways of
working. `docs/admin.md` covers running it safely on the public internet.

## Feeds and cross-posting

`/rss.xml` carries the full post HTML and `/feed.json` is JSON Feed 1.1. Most newsletter
and cross-posting tools accept either. If you republish a post elsewhere, set the copy's
canonical URL to its address here; for a post that was first published elsewhere, set
`canonical:` in its front matter.

Continue with [Safely cross-posting your blog](/posts/automated-cross-posting/) for a
review-first workflow covering Hashnode, DEV, Medium, Ghost, and WordPress.

That is the whole workflow. Delete this series when your own posts arrive, or keep it as
a reference.
