---
title: CLI Overview
parent: open.blog Documentation
has_children: true
nav_order: 3
---

# CLI Overview

The `openblog` CLI is the primary operational interface for:

- project initialization,
- content creation,
- validation and build,
- local serving,
- publish and analytics workflows.

## Core command groups

- **Project setup**: `init`, `new`
- **Build and run**: `check`, `build`, `serve`
- **Publish**: `publish`, `publish setup`
- **Portability and syndication**: `export`, `syndicate`
- **Operations and users**: `analytics ...`, `user ...`

## Operating pattern

Typical day-to-day loop:

1. `openblog new "Title"`
2. Edit Markdown in `content/`
3. `openblog check`
4. `openblog serve --admin`
5. `openblog publish "summary"`

## Global behavior

- Most commands support `--root <dir>` to target another blog directory.
- Draft and scheduled content inclusion is controlled with `--drafts` where supported.
- `openblog help` gives command-level options.

Continue with [Command Reference](./commands).
