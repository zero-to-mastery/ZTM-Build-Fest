# Refreshing generated GitHub content

Open **Refresh GitHub data** to inspect generated profile identity, public stats, biography, avatar, links, language summaries, projects and repository sections/badges. It reads local ownership records; opening the dialog sends no requests. Fetch age is informational, not a claim that GitHub has changed or a repository is abandoned.

## Review and apply

Select sources, or Refresh all owned sources. Only public GitHub endpoints are used, with no credentials, token, polling or proxy. Repository fetches are deduplicated and limited to 50 per operation. Profile fetching uses the existing bounded public-profile/repository loader. Offline refresh explains the limitation while existing content, preview and export remain usable.

Each successful source has a change summary and expandable Current Markdown / Generated Markdown views. Long source views are populated only when expanded. Select which sources to apply, or skip all changes. Failed sources are listed separately. An incomplete repository summary never replaces generated stats, languages or profile-project summaries; successful profile fields and independently loaded repositories can still be accepted. A multi-repository section remains unchanged if any of its required repositories failed.

Applying uses one undo checkpoint and the normal autosave path. Save failures remain visible. A review of an older draft state is rejected; reopen and review again. Accepted refresh invalidates the temporary network Health cache without starting a new scan. README import source versions remain separate from generated metadata fetch times.

## Ownership and manual edits

Project fields reuse the existing generated-value comparison: a description or homepage changed by you is manual and is preserved. Profile identity refresh touches only recorded placeholder paths, never unrelated Custom Markdown or newly typed placeholders. Recorded profile contact URLs and generated sections keep their existing ownership rules. Where a whole section is the safe boundary (stats, biography, repository lists), editing its source prevents automatic replacement. The dialog reports preserved manual values/sections. Deleted unowned content is not reconstructed automatically.

Raw editor changes detach generated ownership only for the generated sections they touch; other generated sections keep refreshing. Studio retains up to 200 normalized source records locally, without trying to locate or rewrite fragments in your manual source. Detached sources are unchecked by default. **Recreate generated version** explicitly fetches and previews an appended version; your current Markdown remains intact. This can create intentional duplicate content, which you can edit or remove manually. Undo restores both source and ownership.

The centralized registry is derived from existing profile/project/section records rather than becoming a second mutable source of truth. Records track source, generated value, ownership and fetch time. Normalized public snapshots, selected generation options and detached records participate in Studio JSON and workspace backups. Raw README.md exports contain none of this internal metadata. Unknown optional source metadata is ignored while Markdown remains editable.

No AI prose, dependency scanning, private data access, GitHub writes or automatic publishing is involved.
