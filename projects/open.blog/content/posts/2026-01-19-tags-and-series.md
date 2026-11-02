---
title: Tags and series
date: 2026-01-19
series: getting-started
seriesOrder: 2
tags:
  - guide
description: Tags group posts by topic. Series put posts in reading order, and each series can have its own theme.
---

## Tags

List them in the front matter. Each tag gets a page at `/tags/<slug>/`, and `/tags/` lists
them all with counts. Tags are matched case-insensitively, so `Rust` and `rust` are one tag.

```yaml
tags:
  - guide
  - rust
```

## Series

A series is a file in `content/series/`. This one is `content/series/getting-started.md`:

```yaml
---
name: Getting started
description: Three short parts ...
theme: demo        # every post in the series renders with this theme
order: 1           # position on the /series/ page
---
Optional Markdown shown at the top of the series page.
```

A post joins a series with `series: getting-started`. Parts are ordered by `seriesOrder`,
or by date when it is missing. The post page then shows "Part 2 of 3", previous and next
links, and a list of all parts. If you reference a series that has no file, open.blog
creates it from the slug and warns you.

## Themes per series

Set `theme:` on a series and all of its posts switch theme, including this one. A single
post can override with `theme:` of its own. The themes available are the folders under
`themes/`; run `openblog themes` to list them. See `docs/themes.md` for how a theme is
built from design tokens, and `docs/theme-components.md` for the heading effect this
series is using.

Next: [Publishing and scheduling](/posts/publishing-and-scheduling/).
