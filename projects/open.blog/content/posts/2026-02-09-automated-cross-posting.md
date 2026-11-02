---
title: Safely cross-posting your blog
date: 2026-02-09
series: getting-started
seriesOrder: 4
tags:
  - guide
description: Publish here first, then send reviewable, canonical copies to DEV, Hashnode, Medium, Ghost, or WordPress.
---

Publishing in more than one community can help readers find your work, but your blog
should remain the source of truth. The dependable sequence is:

1. publish the article on your open.blog site;
2. make sure its final URL is live;
3. create drafts on the other platforms;
4. set each copy's canonical URL back to the open.blog article;
5. review the formatting, then publish the copies.

The canonical URL tells search engines which copy is the original. Deploying that URL
first also prevents every destination from pointing at a page that does not exist yet.

## Start with the feeds

Every open.blog site can expose full-content RSS at `/rss.xml` and JSON Feed at
`/feed.json`. Enable `feeds.rss`, `feeds.json`, and `feeds.fullContent` in
`openblog.json`. A feed automation service can then watch either URL and create a draft
when a new post appears.

Before connecting one, confirm that its destination action can:

- create a draft instead of publishing immediately;
- set the original article URL as canonical;
- update the same remote article rather than create a duplicate.

If it cannot do those things, use the destination's API or import flow instead.

## Pick the right setup for each platform

- **Hashnode:** its official GitHub Action can publish repository Markdown and supports
  drafts, dry runs, and canonical URLs. API publishing now requires a Hashnode Pro
  publication.
- **DEV Community:** its API accepts Markdown, supports drafts, and has a
  `canonical_url` field. Save the returned article ID so future runs update the same
  post.
- **Medium:** use **Import a story** after the original is live. Medium does not accept
  new API integrations; its importer adds the original URL as canonical automatically.
- **Ghost:** its Admin API supports drafts and custom canonical URLs. Keep the Admin API
  key on a trusted server or in CI, never in browser JavaScript.
- **WordPress:** its REST API supports drafts, but core WordPress has no portable field
  for an external canonical. Only syndicate automatically if your particular SEO plugin
  or site configuration exposes and verifies one.

The repository's
[complete cross-posting guide](https://github.com/journey-to-code-org/open.blog/blob/main/docs/cross-posting.md)
walks through credentials, API requests, CI safety, updating instead of duplicating, and
the official documentation for each platform. It also includes a complete GitHub
Actions template that waits for deployment, verifies the canonical URL, and creates or
updates a DEV draft from the deployed JSON Feed.

## Keep publishing credentials private

Store tokens as encrypted CI secrets. Never put one in Markdown front matter, the
generated site, or code that runs in a reader's browser. Start every integration in
draft mode and test it with one disposable article.

Once that works, automation can handle the repetitive copying while you keep the final
review. Your Markdown stays authoritative, every public copy points home, and a failure
on one community does not prevent the original article from reaching your readers.
