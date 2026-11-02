---
title: Troubleshooting
nav_order: 7
---

# Troubleshooting

## `openblog check` fails

- Read the exact file path and error message in output.
- Fix front matter formatting and required fields.
- Re-run `openblog check` before build.

## Build output missing content

- Confirm draft status and publish date.
- Rebuild with `openblog build --drafts` for preview scenarios.
- Verify content file placement under expected directories.

## Admin panel access issues

- Ensure `openblog serve --admin` is running.
- Confirm user exists via `openblog user list`.
- Reset credentials with `openblog user passwd <name>`.

## GitHub Pages not updating

- Check `docs-pages` workflow run status.
- Ensure Pages source is set to GitHub Actions.
- Confirm docs changes are in `docs-site/` and pushed.

## Theme/rendering inconsistencies

- Re-run `openblog build` after theme changes.
- Validate theme settings and inheritance.
- Confirm preview and deployed revision are aligned.
