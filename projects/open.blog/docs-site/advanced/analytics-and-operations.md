---
title: Analytics and Operations
parent: Advanced Capabilities
nav_order: 5
---

# Analytics and Operations

open.blog includes privacy-respecting analytics patterns that fit static deployment models.

## Capabilities

- Cookie-free view counting patterns.
- Backup and merge workflows for view count durability.
- Hosted counter options (Worker/Node/Function variants).

## Command patterns

```bash
openblog analytics backup
openblog analytics pull <url> --secret <secret>
openblog analytics worker [dir]
openblog analytics service [dir]
```

## Operational best practices

- Run scheduled backups for analytics state.
- Document recovery runbooks for counter service outages.
- Keep secrets out of repo history.
- Validate analytics merge results after restore operations.

## Reliability checklist

- Counter endpoint health check present.
- Backup cadence defined.
- Restoration path tested.
- Dashboard values match expected trends.
