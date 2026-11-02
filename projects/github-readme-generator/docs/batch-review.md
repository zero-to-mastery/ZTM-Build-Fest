# Batch review

v1.5.3 connects the README Attention Queue with the multi-document workspace. v1.9.16 re-certifies its bounded queue and per-recipient apply boundary against the current regression suite. v1.9.17 adds an interruption-safe local progress journal and Recovery review. Progress is local: reviewing a document does not assert that its remote README is fixed, published, or removed from future audit results.

## Improve next

1. Audit repositories and open **README Attention Queue**.
2. Set filters for the repositories you want to review. **Improve next** starts a batch from filtered, non-deferred attention items, preserving queue order. Narrow filters if more than 200 match. Replacing an existing batch requires confirmation; documents remain intact.
3. The first pending repository opens directly in the workspace with exact fetched source, or its existing local document if already open. Missing READMEs start empty. Repository templates remain available separately when wanted.
4. Review and edit normally. Use **Mark reviewed & improve next** in the batch bar when satisfied. The decision is explicit; edits, Health results and shared updates never auto-resolve an item.
5. Open **Review → Batch review** to reopen any item, skip the current item, return a reviewed/skipped item to pending, or end the batch. **Improve next** chooses the first pending item in queue order.

The batch bar shows remaining work and the current target. Mark reviewed requires that target's document to be active, preventing accidental decisions about another document. Progress survives reload. Reviewed/skipped decisions do not alter the attention queue's ignore/intentionally-minimal preferences or remote GitHub state.

## Reviewed common section

In Batch review, select **Include owner/repository** for the recipients. None is selected by default. Choose **Prepare common section for selected repositories**.

Existing local documents are reused. Missing local documents are fetched and saved one at a time, then Shared components opens with an editable **Contributing footer** prompt and only those document recipients preselected. Replace placeholder text with your real contribution guidance and save the shared definition. Saving the definition still changes no README.

Choose **Preview insertion** to inspect every resulting document diff. Adjust recipients beside the diffs, explicitly approve the selected diffs, then apply locally. Independent Undo remains available. Adding the section does not mark items reviewed automatically.

Changing recipients after preview clears approval. Excluded recipients are outside the apply plan: later edits to an excluded document do not block selected work, and Apply leaves its exact source unchanged. A changed selected recipient invalidates the whole reviewed plan before any document is written.

There is no mass publish operation. Publish to GitHub remains a separate single-document flow requiring remote source review and confirmation. Batch review makes only read-only GitHub requests.

## Failures, cancellation and recovery

Opening documents uses the existing GitHub README endpoint, session cache, timeout/rate-limit handling and one-at-a-time requests. A failed item remains pending; retry or explicitly skip it. Previously opened exact source remains in the workspace. Cancel or closing/replacing the batch dialog aborts pending fetches. Preparing a common section applies no content edits until the subsequent diff review.

Every successful open and explicit reviewed, skipped or return-to-pending decision appends an allowlisted event to a 500-event local journal. An open checkpoint records only the local document ID, repository target identity, exact-source fingerprint and time. It never stores README content, credentials or a remote write instruction. Legacy batch progress migrates when read.

Opening **Batch review** performs a local **Recovery review**. Each item is shown as matching its last opened source, changed since then, missing, target-changed or not yet opened. This check reads the current workspace only: it makes no GitHub request and changes nothing. A changed document remains the author's exact local document and an explicit reviewed/skip decision is still required.

Progress is versioned workspace metadata referencing repository/branch/path, not copied README content. All-drafts backup contains progress alongside actual document sources. Replace restore restores incoming progress; merge keeps the current workspace's review batch. Invalid progress triggers existing safe storage recovery, preserving original recovery bytes; documents remain recoverable.

No recovery path contains or replays a publish operation. Publishing remains a separate single-document review with its own fresh remote checks and approval.

The existing 500-document workspace limit still applies. Storage must be writable for batch progression or newly opened sources; failures remain visible without replacing existing source. Already-open matching documents can be reopened offline. Fetching a repository not yet in the workspace requires connectivity.
