# Documentation suites are explicit, atomic local batches

Implemented in v1.9.12.

A Documentation suite starts with no selected files. Project type limits the available typed templates, while each template owns one fixed relative path and a generic prompt that contains no project facts. The author selects files, edits their starting Markdown, reviews every exact path and source, then approves the whole Suite manifest. Any edit invalidates that review.

Creation revalidates the manifest at the app boundary and constructs every draft before writing. The complete candidate workspace is persisted once; only a successful write replaces in-memory state. A stale workspace, path collision, limit conflict, malformed content or storage failure creates no document and changes no existing Source.

Generated drafts are Local documents with their intended path in workspace metadata. Suite creation does not infer a repository target, fetch evidence or publish. We rejected automatically selecting a recommended set because relevance is a project-owner decision. We also rejected creating files one at a time because a partial suite after quota failure would violate the reviewed batch.
