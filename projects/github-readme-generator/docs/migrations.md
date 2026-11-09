# Migration and recovery policy

Application versions and public file schema versions are separate. The supported Studio project schema is 1. README Studio 1.x is intended to preserve schema-1 source opening or provide an explicit, tested migration. Structured recovery must never take priority over original Markdown.

Project migrations run sequentially through a pure registry. Each step must advance by exactly one schema version and retain `document.markdown` byte-for-byte as a JavaScript string. Missing steps, future versions and failed source checks stop structured opening. The file is not written back. Users may open a newly named Markdown-only recovery draft or cancel.

The legacy single-draft adapter is represented internally as migration version 0. This does not claim that pre-project releases used a public schema 0. Its timestamps are deterministic epoch defaults when no project date exists. Compatible blocks and metadata survive; unsupported structured data falls back to the original source. Whole-workspace version-1 backups retain their own validated restore flow and are not misidentified as a single project.

Block IDs are stable on normal workspace reload and structured project open. Import/restore paths that generate new IDs remap exact banner references; ambiguous duplicate references detach rather than claim ownership of the wrong section. IDs are document-scoped. Fresh drafts and merged library entries receive independent identifiers, with deterministic numbered name suffixes on collision.

Future public schema changes require fixtures for every supported transition, exact-source assertions, round-trip coverage and explicit future-version behavior. Deprecations should retain source recovery, announce the replacement and avoid removing supported fields without a documented migration. Patch releases fix defects; minor releases add compatible capabilities; breaking public-schema behavior requires a major version and an explicit recovery path.

Snippet-pack version 1 migrates to version 2 by retaining the validated metadata, snippets and badge collections exactly and adding an empty `extensions` collection. The migration is in memory: import never rewrites the selected file. New exports use version 2 so older readers reject the envelope instead of silently dropping extension manifests. Version 3 and other unknown versions are rejected.

Local storage is not a public interchange API. Use versioned downloads for portability. Corrupted or unsupported browser storage must stay untouched until the user explicitly restores/replaces it; recovery downloads preserve the unreadable original where possible.
