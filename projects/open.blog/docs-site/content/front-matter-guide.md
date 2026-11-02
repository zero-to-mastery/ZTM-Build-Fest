---
title: Front Matter Guide
parent: Markdown Style Guide
nav_order: 1
---

# Front Matter Guide

Front matter controls publishing behavior and metadata while body Markdown stays content-focused.

## Typical metadata fields

- `title`
- `date`
- `tags`
- `series`
- `draft`
- profile-related fields where applicable (for example recipe/research workflows)

## Best practices

- Keep metadata canonical and consistently formatted.
- Prefer explicit dates/times for schedule-sensitive content.
- Keep taxonomy values stable (`tags`, `series`) for cleaner navigation.

## Workflow recommendation

- Edit metadata via Admin settings where possible.
- Validate metadata with `openblog check` before publish.
- Use preview + check + build before major releases.
