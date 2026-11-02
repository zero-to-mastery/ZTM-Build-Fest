# Generated asset publishing

## Deterministic local manifest

Banner Builder can download `readme-studio-assets.json` alongside its SVG files. This schema-version-1 manifest is a deterministic description of one generated package: generator identity, files sorted by relative path, each file's role, media type, UTF-8 byte size and `fnv1a32` content fingerprint, plus the exact portable Markdown that references those files. The same normalized package feeds optional GitHub publishing, so downloaded references and published paths cannot silently diverge.

The manifest contains no timestamps, application version, SVG source, README source beyond the generated picture markup, credentials or repository target. Identical banner settings produce byte-for-byte identical manifest downloads. The fingerprint detects accidental content drift; FNV-1a is not cryptographic and does not establish authenticity. Review the SVG files themselves before committing them.

Package paths must be visible relative paths of at most 240 characters. Directory segments use ASCII letters, digits, `_` and `-`, with dots or spaces allowed between visible characters; filenames may also use dots. Root-level filenames are supported. Absolute paths, leading/trailing directory dots or spaces, hidden segments, traversal and duplicate destinations are rejected. A package contains 1–32 files, each from 1 byte through 250 KB, and every path must occur in its exported Markdown. The manifest is a download/review aid, not an import format, filesystem writer or publish instruction. Downloading it never edits README Source, uploads a file or starts GitHub publishing.

Save or insert a banner in Banner Builder, then open **Publish to GitHub**. Select the repository/branch/README, enable **Include generated banner SVG files**, and choose a visible relative asset directory (default `assets/readme`). Load remote README to prepare the entire plan. This is optional; SVG downloads remain available without authentication.

Each generated light/dark file is one row of the [Change set](github-publishing.md#change-set-review): its path, action (create, update or unchanged: no write), Base SHA, Result SHA, byte size and an expandable textual source diff. Existing SVG source is displayed as text, never injected into the UI. A filename absent from the prepared README raises an advisory unreferenced-file warning. Review the prepared README and every listed asset before confirming.

The server generates each SVG again from validated banner settings and compares it byte-for-byte with the requested content. Arbitrary SVG/filesystem uploads are not supported. Paths must be relative, in visible folders, with an SVG filename; absolute paths, traversal, hidden/token files and workflow directories are rejected. Assets are capped at 250 KB; files over 100 KB receive a size warning. No remote deletion occurs.

## Owned reference updates

Banner markup inserted by this version records its block identity and exact generated source. The optional path rewrite works only while that block and source remain unchanged and builder serialization still matches the draft. Manual Markdown editing detaches this reference; pre-existing raw banner links are never inferred as owned. Nested README paths receive correctly relative links. Rewrites affect the prepared publishing copy, not the local draft. Download the prepared README if you want to retain that version locally.

## Conflicts and partial completion

Every file in the Change set is re-read before the first write. A changed asset makes it a Stale change set: nothing is written, and the rebuilt set needs a fresh approval. The server checks again immediately before each Contents API update; GitHub enforces the SHA precondition. A conflict requires reloading and reviewing the plan. Assets are committed sequentially and README last. This is **not atomic**: if a later file fails, earlier commits remain. The result lists each successful commit, failed file and unattempted file. README is not attempted after an asset failure. Reload the plan before retrying; already identical files will be unchanged. A lost network response can make a write outcome uncertain—inspect GitHub before retrying.

The pre-publish source checkpoint remains downloadable/restorable as a new draft. Local README source and saved banner settings remain unchanged on both success and failure. See [authentication, permissions and recovery](github-publishing.md).

For a manual package check, generate both modes twice and confirm the manifest files are byte-identical; verify every listed path matches a downloaded SVG and occurs in `references.markdown`; then change the filename or folder and confirm both the path list and markup update together. Also confirm invalid traversal and colliding destinations are rejected before download or publishing.
