---
title: Quick Start
nav_order: 2
---

# Quick Start

This walkthrough gets you from zero to a working local blog with optional GitHub Pages publishing.

## 1) Install

Install the CLI (requires Rust toolchain):

```bash
cargo install --git https://github.com/journey-to-code-org/open.blog openblog-cli
```

Verify installation:

```bash
openblog help
```

## 2) Create a blog

```bash
openblog init my-blog --github-pages
cd my-blog
```

This creates starter content, themes, configuration, and a Pages-ready baseline.

## 3) Run locally

```bash
openblog serve
```

Default preview is `http://localhost:8080`.

## 4) Create your first post

```bash
openblog new "Hello open.blog" --tags docs,intro
```

Edit the generated Markdown file under `content/posts/`.

## 5) Validate and build

```bash
openblog check
openblog build
```

The static site is written to `dist/`.

## 6) Use Admin Panel (optional)

```bash
openblog serve --admin
```

Use Admin for draft editing, scheduling, preview, and publishing workflows.

## 7) Publish with Git

```bash
openblog publish "Publish initial docs"
```

If your repository is configured for GitHub Pages, the deploy workflow will publish your site.

## Next references

- [CLI Overview](./cli/overview)
- [Admin Panel Overview](./admin-panel/overview)
- [Markdown Style Guide](./content/markdown-style-guide)
