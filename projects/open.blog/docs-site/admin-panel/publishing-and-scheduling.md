---
title: Publishing and Scheduling
parent: Admin Panel Overview
nav_order: 2
---

# Publishing and Scheduling

## Scheduling model

Posts can be scheduled by date/time metadata and will publish on the next build after schedule criteria is met.

## Publish flow options

- **Admin-driven**: publish from the Admin interface.
- **CLI-driven**: run `openblog publish "summary"`.

Both approaches rely on git-backed content and deployment workflows.

## Suggested release process

1. Final review in Admin preview.
2. Run `openblog check`.
3. Publish changes.
4. Confirm deployment status in your hosting pipeline.

## Failure handling

If a release does not render as expected:

1. Run `openblog check` locally.
2. Rebuild with `openblog build`.
3. Validate front matter and file paths.
4. Re-publish after corrections.
