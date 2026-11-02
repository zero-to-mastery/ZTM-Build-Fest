# ADR 0219: Continuations publish from continuations.json, are read strictly and name pages by stable canonical path

- Status: Accepted
- Date: 2026-10-27
- Decision issue: [#215](https://github.com/journey-to-code-org/open.blog/issues/215)
- Parent story: [#206](https://github.com/journey-to-code-org/open.blog/issues/206)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0181](0181-features-publish-from-community-perspectives-json-beside-third-perspectives-json-and-read-strictly.md), ADR 0218

## Context

Static reading must work without a service, and the file lives in a public repository.

## Decision

- `continuations.json` in the content folder: version 1 and an `items` list, canonical output (sorted by origin page, day and id, two-space indent, final line break, LF only), at most 500 items and 2 MiB. A reader refuses a newer version, an unknown field, a repeated id, a repeated origin-and-target or any broken rule, naming the item by position and never its contents or the name of an unknown field.
- Public fields only: ids, paths, slug, relation, note, day. No reader text, name, contact, receipt, editor or time of day; the strict reader refuses each as a field this version does not define.
- Pages are named by canonical path (`/posts/slug/`), series by slug. A **renamed series** follows an alias map to its current slug (`rename_series` rewrites the file; `resolve` also follows aliases at build time). An **unknown series** drops only the label and keeps the link. A path that is not published hides the edge.
- A site without the file is byte-for-byte what it was. The build reads the file with the other published files (ADR 0224); it adds no hosted column, setting or environment variable.
