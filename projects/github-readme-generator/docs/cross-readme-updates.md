# Cross-README updates

Version 1.5.2 previews shared changes across the workspace before choosing recipients. There is no global automatic write and no GitHub publication.

## Update a shared Testing Stack

1. Open **Review → Cross-README updates**, or **Shared components**.
2. Choose your saved Testing Stack definition. Edit and save it if needed. Saving changes only the definition.
3. Choose **Preview across workspace** to find linked copies with safe pending changes. Example: **Affected: 8 READMEs · Selected: 0**.
4. Inspect each document's full before/after source and diff. Repository, branch and path are shown when configured, helping distinguish similarly named documents.
5. Check **Update [document name]** beside the diffs you want to receive the change. **Select all affected** and **Clear document selection** are explicit shortcuts.
6. Approve **I reviewed all selected document diffs**, then **Apply reviewed changes**.

Nothing is selected automatically in workspace-wide previews. Changing recipients clears approval. Empty selections cannot apply. Documents omitted from the selection stay exactly as they were; a later preview still offers their pending changes. Closing the preview applies nothing.

The existing **Preview insertion** and **Preview linked updates** workflows remain available for the preselected Documents to preview list. Their review panes now also allow removing recipients before Apply.

## Safety and scope

Affected means documents with safe source changes available, not every linked document or number of copies. Multiple matching copies in one README count as one document. Already-current copies are unchanged; locally edited copies are skipped and reported. Raw source edits detach shared ownership, so they are not candidates for propagation. See [Shared components](shared-components.md).

Apply checks the selected document snapshots and definition against the preview. If a selected document or definition changed, review again. An unselected document's edits do not block application because it is never written. All selected results persist before Store changes; persistence failure leaves sources untouched. Undo remains independent per document, subject to session memory limits.

These are local workspace changes. Normal README export and explicit publishing remain separate. Source preview is inert text, makes no remote requests, and introduces no proprietary include syntax into README files.
