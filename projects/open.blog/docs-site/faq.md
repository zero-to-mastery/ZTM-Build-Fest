---
title: FAQ
nav_order: 10
---

# FAQ

## CLI and Setup

### How do I install the CLI?

Run:

```bash
cargo install --git https://github.com/journey-to-code-org/open.blog openblog-cli
```

Then verify with:

```bash
openblog help
```

### How do I create a new blog quickly?

```bash
openblog init my-blog --github-pages
cd my-blog
openblog serve
```

### How do I create a new post?

```bash
openblog new "My Post Title" --tags docs,guide
```

Edit the generated file under `content/posts/`.

## Admin Panel

### How do I open the Admin panel?

```bash
openblog serve --admin
```

Then open `/admin` in your browser.

### Why can’t I log in to Admin?

Create or update a user:

```bash
openblog user add <name>
openblog user passwd <name>
openblog user list
```

### Does Admin edit the same files as CLI?

Yes. Admin writes the same Markdown content and metadata used by CLI build/publish flows.

## Markdown and Content

### What Markdown style should I follow?

Use the project guide:

- [Markdown Style Guide](./content/markdown-style-guide)
- [Front Matter Guide](./content/front-matter-guide)
- [Content Quality Checklist](./content/quality-checklist)

### Why is my post not showing on the site?

Common causes:

- post is still draft,
- publish date is in the future,
- front matter or content validation errors.

Run:

```bash
openblog check
openblog build
```

## Build and Deploy

### How do I validate before publishing?

```bash
openblog check
openblog build
```

### How do I publish changes?

```bash
openblog publish "Publish content update"
```

### Why didn’t GitHub Pages update?

Check:

1. The docs workflow run status.
2. Repository Pages source set to **GitHub Actions**.
3. Your latest commit contains the expected docs/content changes.

## Troubleshooting

### Which page should I use for deeper issue resolution?

Use [Troubleshooting](./troubleshooting) for operational diagnostics and recovery flow.

### Where should I look for release-impact changes?

Use [Versioning and Migrations](./versioning-and-migrations) for upgrade and breaking-change guidance.
