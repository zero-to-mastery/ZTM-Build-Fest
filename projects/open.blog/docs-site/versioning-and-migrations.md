---
title: Versioning and Migrations
nav_order: 9
---

# Versioning and Migrations

Use this section to communicate change impact clearly across releases.

## Release communication model

- **Patch**: fixes, no expected workflow changes.
- **Minor**: new capabilities, backward-compatible defaults.
- **Major**: behavior or format changes that may require migration.

## Changelog strategy

For each release, include:

1. **What changed** (features/fixes).
2. **Who is impacted** (authors, operators, contributors).
3. **Required actions** (if any).
4. **Verification steps** (`openblog check`, build, preview).

Recommended source of truth:

- repository changelog for canonical release entries,
- docs migration pages for operator-facing runbooks.

## Breaking change template

When shipping a breaking change, document:

- Previous behavior.
- New behavior.
- Migration steps.
- Rollback path.
- Validation checklist.

## Migration guide checklist

- Backup content and configuration.
- Apply migration steps in a staging branch.
- Run `openblog check` and `openblog build`.
- Verify Admin panel critical paths.
- Publish only after successful validation.

## Suggested docs workflow

When a release lands:

1. Update this section and any dedicated migration page.
2. Link migration notes from affected CLI/Admin pages.
3. Add “upgrade required” callouts to relevant guides.
