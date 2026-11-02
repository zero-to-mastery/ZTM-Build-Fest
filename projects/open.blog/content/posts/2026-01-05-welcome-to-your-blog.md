---
title: Welcome to your blog
date: 2026-01-05
tags:
  - meta
description: This is the first post on a fresh open.blog. Edit it, or delete it, to make the blog yours.
---

You are looking at `content/posts/2026-01-05-welcome-to-your-blog.md`. Everything on this
site comes from Markdown files like it. There is no database to set up and nothing to
export later: your posts are plain text in a folder you own.

## Three ways to write

1. **A text editor.** Open the file, change it, save. `openblog serve` rebuilds the site
   while it runs.
2. **The admin editor.** Run `openblog user add you`, then `openblog serve --admin` and
   open `/admin`. It edits these same files, with a live preview.
3. **The command line.** `openblog new "A post title"` creates a file with today's date.

## What a post needs

The block between the `---` lines at the top is the front matter. Only `date` is required,
plus a `title` unless the body starts with a `#` heading. `tags`, `description`, `series`, `cover`, `draft`, and `theme` are optional;
the [Getting started](/series/getting-started/) series walks through them.

## Make it yours

- Set the title, description, author, and address in `openblog.json`.
- Replace this post, or keep it as a reminder of how the pieces fit.
- Pick a theme in `openblog.json`, or write one in `themes/`.
