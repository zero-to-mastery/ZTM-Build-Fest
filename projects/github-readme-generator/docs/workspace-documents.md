# Multi-README workspace

Version 1.5.0 lets one local workspace hold profile and repository READMEs together. Existing drafts are documents; there is no second copy of their source or separate storage to synchronize.

## Navigate and configure

Use **Documents** in the workspace bar or **Save → Workspace documents**. Search by name, repository, path or branch. Documents appear under **Profile**, **Repositories** and **Local documents**. The current item is marked in text and with an accessible current state. The existing Current draft dropdown is a grouped quick switcher. Keyboard selection returns focus to that switcher.

The Documents dialog also opens **Evidence snapshots** for the current document: read-only records of its GitHub target's branch head, README revision, manifests, lockfiles and linked files. See [Evidence snapshots](evidence-snapshots.md).

**Check document links** compares relative links and anchors with the paths and current Source of documents in this workspace. It is local and read-only, reports missing/ambiguous documents and missing anchors, and also runs before export for a path-aware current document. See [Cross-document link checks](document-link-checks.md).

Create a **New document**, or use existing templates, import, audit and draft duplication. **Create documentation suite** prepares an explicitly selected, exact-reviewed set of local files as one atomic batch; see [Documentation suites](documentation-suites.md). Use **Manage drafts** to rename, duplicate, delete or export a document. Each document has independent Markdown, builder metadata and GitHub target. The workspace retains the existing limit of 500 local documents.

In Documents, edit the current document's group and, if applicable, repository (`owner/repository`), branch and relative README path. These are validated local settings; saving them does not contact GitHub. Selecting Local documents explicitly clears its target. Profile and repository groups organize the list, without asserting repository ownership or access.

**Publish to GitHub** suggests the document's saved target only when that repository appears in the authorized repository list. Loading the remote source and reviewing/confirming a write are still required. Targets can differ by branch and path, including `docs/README.md`. Publishing workflows keeps its separate workflow target flow.

## Audit queue and existing work

Open in Studio or Improve README from the repository audit/attention queue reopens a matching local document when its repository, branch and path match. Repository names compare case-insensitively; branches and paths remain case-sensitive. Local edits win: refreshed remote source does not silently overwrite them. If several copies share a target, the first workspace document matches; use Documents to choose another copy explicitly.

A repository not yet open still uses the existing exact-source or reviewed-template workflow. Re-import/merge remains available separately when you want to incorporate remote changes.

## Independent state and recovery

Switching flushes the current document to local storage and updates preview and Health for the selected document. Old Health workers are disconnected when their panel is replaced. Analysis is recomputed from that document, rather than sharing another document's findings.

Undo and Redo survive switches within this tab and cannot cross document IDs. History is session-only: reload, workspace restore or memory eviction resets it. Each active Store retains its existing 80-checkpoint / 8 MB bounds; inactive document histories share a 32 MB budget, evicting older histories first. Eviction never removes current Markdown. Neither history nor active GitHub/AI credentials enter portable exports.

**Download all drafts backup** preserves all document sources, builder data, targets, workspace settings and [evidence snapshots](evidence-snapshots.md). Restore validates before applying and retains existing collision/recovery behavior. A Studio project carries one document and its target, never its evidence snapshots, which stay machine-local. Deleting a document also deletes its evidence snapshots; the confirmation says so. Plain README export remains exact Markdown without Studio metadata. Malformed builder data can still recover source as Custom Markdown. Existing imported/published target metadata is recognized without rewriting older drafts; drafts without a valid target remain usable locally.

If browser storage fails, source stays in memory and the existing recovery notice offers backup. Download it before closing the tab. No account or network connection is required for local editing, navigation, Health or export after the app loads.

## Shared documentation

[Shared components](shared-components.md) reuse common Markdown across these documents. Saving a definition never changes a README; selected insertions and updates are reviewed with per-document diffs and explicit approval.
