---
title: Imports and Migrations
parent: Advanced Capabilities
nav_order: 6
---

# Imports and Migrations

open.blog supports migration-oriented workflows so existing content can move into a Markdown-first architecture.

## Typical scenarios

- Importing from external blogging platforms.
- Migrating contributor metadata conventions.
- Preserving URL and SEO continuity during platform change.

## Command patterns

```bash
openblog import hashnode <host> --limit <n>
openblog contributors migrate --id <stable-id> --write
```

## Migration runbook

1. Run import in dry-run/limited scope.
2. Validate generated content and metadata.
3. Resolve media/path and front matter inconsistencies.
4. Run `openblog check` and full build.
5. Perform staged publication and verify redirects/SEO metadata.

## Post-migration verification

- Slug consistency and canonical URLs.
- Feed correctness.
- Open Graph and schema correctness.
- No broken internal links.
