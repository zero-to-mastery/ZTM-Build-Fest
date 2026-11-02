---
title: Publishing and Syndication
parent: Advanced Capabilities
nav_order: 3
---

# Publishing and Syndication

Beyond “build and deploy,” open.blog supports portable publishing and multi-channel distribution.

## Publication surfaces

- Primary static site output.
- Exported Markdown for downstream channels.
- Citation formats (`csl-json`, `bibtex`) for scholarly pipelines.

## Command patterns

```bash
openblog publish "Release summary"
openblog export <slug> --format markdown --write
openblog syndicate <slug> --target a,b --write --publish
```

## Suggested editorial release flow

1. Validate with `openblog check`.
2. Build and sanity-check local output.
3. Publish canonical source.
4. Export/syndicate per channel policy.
5. Track channel-specific post-publication issues.

## Guardrails

- Keep canonical source in repo.
- Avoid channel-specific drift by regenerating exports.
- Store release notes for every publish window.
