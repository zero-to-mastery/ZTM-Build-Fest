# Shared components

Version 1.5.1 reuses common Markdown across documents in one local workspace. Shared definitions are separate from saved snippets: they retain revision links so you can explicitly review later updates. READMEs still export as ordinary Markdown, with no comments, runtime or proprietary include syntax.

## Create and insert

1. Open **Create → Shared components** (also searchable in workspace commands).
2. Enter a name and Markdown, or choose an editable example: Contributing footer, Testing stack, Security section, Sponsor/contact block, Common badge row, or Organization/community links.
3. Replace example prompts and placeholder URLs with verified information. **Save shared definition** saves only the reusable definition.
4. Select the documents to receive it. Only the current document is selected initially.
5. Choose **Preview insertion**. Inspect the before/after source and diff for each document, approve **I reviewed all selected document diffs**, then **Apply reviewed changes**.

Insertion appends a linked Custom Markdown block. Existing source and other builder blocks remain intact. Repeated insertion creates another linked copy; no hidden deduplication or replacement occurs. After applying, each affected document has its own Undo/Redo checkpoint.

## Update deliberately

Select a saved definition, edit its Markdown and save it. Source changes increment its revision. This does **not** update any document.

Select documents and choose **Preview linked updates**. The preview includes only safe linked changes and explains skipped documents/copies. Approve and apply to update those copies. Documents not selected remain untouched and can update later. Rename does not create a content revision. Delete definition asks for confirmation and leaves all previously inserted source intact; it becomes unavailable for future linked updates.

If a definition or an affected document changes after preview, Apply refuses the stale review before changing any source. If local storage cannot persist the complete reviewed result, no document changes are applied. Resolve storage recovery before continuing; all-drafts backup remains available.

## Local edits and ownership

Editing the raw document detaches its shared copies conservatively, even if the change is elsewhere in that document. Source remains exact and future shared updates cannot replace it. Undo restores the prior source and links within the session history limits.

Editing a shared Custom Markdown block through the builder retains its source but makes that copy ineligible for updates when it no longer matches the saved inserted source. The update preview reports it as locally edited. You can retain the variation, or remove it manually and review a fresh insertion. No automatic merge attempts to guess your intent.

## Backup and limits

Download all drafts backup includes the version-1 shared library and each document's linked copies. Restore validates definitions and preserves source. Merge keeps both colliding definitions, gives incoming names suffixes, remaps IDs in incoming copies, and leaves existing links alone. Malformed storage follows the normal recovery flow; original bytes remain available for download.

A single Studio project or README carries its document/source, not the workspace shared library. Use a workspace backup to move definitions and linked copies together. Missing definitions never prevent editing or exporting a document.

Up to 200 definitions are supported, each up to 100,000 source characters. Definitions are local, not hosted or synced across browsers. Undo/Redo for document application follows the workspace's bounded session history; it does not undo the library definition itself. You can edit a definition back to an earlier value and preview another update.

All fields are untrusted. Source previews use textareas/diff text, never executable HTML; they make no remote image requests. Normal README preview sanitization still applies after insertion, while exported Markdown remains the user source. Shared components do not publish to GitHub automatically.

## Workspace-wide changes

v1.5.2 adds [Cross-README updates](cross-readme-updates.md): preview all linked pending changes, see the affected count, and select recipients beside their diffs. No recipients are preselected in workspace-wide mode; changing recipients clears approval.
