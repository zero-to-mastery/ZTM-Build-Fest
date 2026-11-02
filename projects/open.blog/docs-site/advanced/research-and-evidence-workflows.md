---
title: Research and Evidence Workflows
parent: Advanced Capabilities
nav_order: 2
---

# Research and Evidence Workflows

open.blog includes first-class workflows for research-oriented publishing, not just plain blog posts.

## Capability highlights

- Research profile rendering and metadata.
- Evidence-oriented authoring and review loops.
- Claim/evidence readiness checks integrated into validation flows.
- Structured outputs suitable for transparent citation-oriented publishing.

## Recommended workflow

1. Draft post content in Markdown/Admin.
2. Add citations/evidence and supporting metadata.
3. Run `openblog check` to surface readiness gaps.
4. Review in Admin preview and finalize.
5. Build + publish through standard release flow.

## Quality gates to enforce

- Explicit claim support quality.
- Source traceability and consistency.
- Final rendered context for readers.

## Related command patterns

```bash
openblog check
openblog build
openblog export <slug> --format csl-json
```

Use export formats for research portability and downstream citation tooling.
