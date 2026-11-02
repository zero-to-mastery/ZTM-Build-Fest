# Portable Studio projects

**Save → Save Studio project** downloads `name.readme-studio.json`. The file contains the README source, supported builder blocks and ownership metadata (including Detachment records by section name and kind; the earlier text of a detached section, detached generated text and its titles, generated profile text whose section is gone, detached banner settings and section names you edited away are never included), active draft theme/banner settings, generated SVG asset manifest, non-secret GitHub references (including public profile and repository data fetched from GitHub, kept as fetched) and workspace preferences. **Download original recovery data**, offered only when browser storage cannot be read, is different: it is a verbatim copy of everything stored, including that removed text. Choose a different file name to save a separate copy; the active draft is not renamed or replaced.

This is distinct from browser autosave, single-draft legacy JSON and all-drafts backup. A project is one portable document. Workspace backups contain multiple drafts and global libraries. Saving a project is an explicit download; autosave never silently writes to your filesystem or GitHub.

Reusable snippets, badge collections and visual libraries remain workspace-global. **Include reusable libraries** is off by default. Enable it when the receiving browser needs those editable library definitions. Inserted Markdown does not depend on embedded libraries or on README Studio.

## Open and recover

Use **Open Studio project** from Save or from **Other ways to start** in [Guided start](guided-start.md). Before opening, Studio shows name, schema, file size, block count, asset count, creation date and GitHub-reference status. You can inspect exact source, cancel, or download recovered Markdown. Opening creates a new draft. Names receive numbered suffixes on collision; it never replaces the current draft or writes back to the original file.

Workspace preferences are applied only when selected. Embedded libraries merge only when selected, keeping both colliding entries. Authentication is never restored from a file. Public repository references and prior publish SHAs do not authorize a write: reconnect and review the current remote state.

If metadata cannot reproduce the README, asset validation fails or the schema is from a future app, choose **Open Markdown only**. The result is a newly named recovered Custom Markdown draft. The original file stays untouched. A complete `markdown` JSON string may be recoverable even from otherwise damaged JSON; incomplete/undecodable source cannot be reconstructed reliably. Files over 10 MB are rejected before parsing; retain the original for recovery outside the app.

Only exact Studio-generated banner SVGs are accepted as embedded assets. They are checked against normalized banner settings and are not injected into the UI as arbitrary SVG. Large binaries and arbitrary attachments are not supported. Use Banner Builder to download assets and commit them beside the README yourself, or use the separately reviewed asset publishing flow.

Legacy single-draft JSON can be opened through this flow. Whole-workspace backups still use **Restore backup**, including its separate merge/replace review. See [project schema](project-schema.md) and [migration policy](migrations.md).
