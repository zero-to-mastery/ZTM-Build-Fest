---
title: Writing a post
subtitle: Front matter, Markdown, images, and code blocks in one file.
date: 2026-01-12
series: getting-started
seriesOrder: 1
tags:
  - guide
  - markdown
description: What goes in a post file, which Markdown features work, and how images and code blocks are handled.
---

A post is a Markdown file in `content/posts/`. The file name can start with a date
(`2026-01-12-writing-a-post.md`); the rest becomes the slug, so this post lives at
`/posts/writing-a-post/`. Add `slug:` to the front matter to choose a different one.

## Front matter

```yaml
---
title: Writing a post
subtitle: Optional. A one-line subheading shown under the title.
date: 2026-01-12           # or a full time: 2026-01-12T09:30:00Z
tags: [guide, markdown]    # inline lists work too
description: Optional. Used in feeds and search results.
cover: /images/cover.png   # optional; the first image in the body is the fallback
draft: false
---
```

Dates without a time are midnight UTC. A post dated in the future is *scheduled* and stays
hidden until that moment (part three has the details).

## Markdown that works

CommonMark plus the GitHub extensions: tables, task lists, footnotes, and strikethrough.
Headings get ids and anchor links, so `#markdown-that-works` links here.

| Feature | Syntax |
| --- | --- |
| Task list | `- [x] done` |
| Footnote | `text[^1]` |
| Strikethrough | `~~old~~` |

- [x] Write the post
- [ ] Publish it

Callouts draw attention to a note, a tip, or a warning:

> [!TIP]
> Write `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, or `> [!CAUTION]`
> on the first line of a quote.

Regular code blocks are read-only: they keep the original syntax colouring, line numbers,
highlighted lines, and copy button. This one demonstrates that decorative presentation:

```rust title="Read-only example · src/lib.rs" {2}
pub fn greeting(name: &str) -> String {
    format!("Hello, {name}!")
}
```

Add `runnable` only when readers should be able to edit and execute a self-contained Rust
example. A runnable block deliberately becomes an editor with controls and inline output:

```rust runnable playgroundLink=false title="Live example · try changing the name" {2} showLineNumbers
fn main() {
    let name = "reader";
    println!("Hello, {name}!");
}
```

The two fences begin with ```` ```rust title="..." ```` and
```` ```rust runnable playgroundLink=false title="..." ```` respectively. Leave out
`playgroundLink=false` when you want the external Playground fallback. Add
`showLineNumbers=10` to a read-only block to count from 10, or `showLineNumbers=false` to
drop the numbers. Running the live example sends its edited source to the official Rust
Playground. To change highlighting and numbering for the whole blog, see `code` in
`openblog.json`.

## Check your understanding

```quiz
What happens when a post is dated in the future?
- [ ] It is published immediately with a future date
- [x] It stays hidden until a build runs after the scheduled time
- [ ] It is automatically saved as a draft
> A future-dated post becomes public in the first build run after its scheduled time.
```

## Images

Put files in `static/`; they are copied to the site root. `static/images/photo.png` is
`/images/photo.png`:

```markdown
![A short description](/images/photo.png)
```

The admin editor uploads and inserts images for you, including by drag and drop or paste.

Next: [Tags and series](/posts/tags-and-series/).

[^1]: Footnotes render at the end of the post.
