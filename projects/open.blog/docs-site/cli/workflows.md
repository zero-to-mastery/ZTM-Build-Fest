---
title: CLI Workflows
parent: CLI Overview
nav_order: 2
---

# CLI Workflows

## Authoring workflow

```bash
openblog new "Post Title" --tags docs,cli
openblog check
openblog serve --admin
```

1. Generate a new Markdown post.
2. Validate content and metadata.
3. Review in live preview.

## Release workflow

```bash
openblog check
openblog build
openblog publish "Publish release notes"
```

1. Validate the full content set.
2. Build static artifacts.
3. Publish through git-based workflow.

## Draft and schedule workflow

```bash
openblog serve --admin --drafts
openblog build --drafts
```

Use `--drafts` in preview contexts to inspect unpublished content and future-dated entries.

## CI-friendly checks

```bash
openblog check --json
```

Use JSON output for machine-readable quality gates in CI pipelines.

## Recovery and diagnostics

- Run `openblog check` after migration or bulk edits.
- Re-run `openblog build` before deployment if templates/themes changed.
- Use `openblog help` for complete command options.
