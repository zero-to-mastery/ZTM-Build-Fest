---
title: Admin Panel Overview
parent: open.blog Documentation
has_children: true
nav_order: 4
---

# Admin Panel Overview

The Admin Panel is the browser-based authoring workspace launched with:

```bash
openblog serve --admin
```

## What Admin provides

- login-protected writing workspace,
- publishing-faithful themed preview,
- front matter managed in UI settings (not in editor body),
- SEO and answer-readiness guidance,
- uploads, drafts, scheduling, and publish actions.

## Recommended usage model

1. Draft/edit content in Admin.
2. Resolve guidance and quality checks.
3. Validate with CLI (`openblog check`).
4. Publish through Admin or CLI publish flow.

## Security and operations notes

- Admin edits the same Markdown files under your content directory.
- User management is handled through `openblog user ...` commands.
- Treat Admin as an authoring surface over git-backed content.

Continue with [Drafting and Preview](./drafts-and-preview).
