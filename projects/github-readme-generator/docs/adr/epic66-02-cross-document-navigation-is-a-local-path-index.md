# Cross-document navigation is a local path index

Implemented in v1.9.13.

Cross-document checking indexes only explicit workspace paths: a Documentation suite's intended path in one local namespace, or a repository document's validated target path scoped to its canonical repository and exact branch. It resolves relative links against that index with case-sensitive paths and checks anchors against the target's current Source. Documents without a path are named as not checked. External URLs, images and repository files that are not open workspace documents are not fetched or inferred.

The result is derived, byte-bounded and never persisted. Missing, ambiguous, invalid, unchecked and above-root targets are advisory findings; no path or Source is rewritten. Before export, unresolved or truncated navigation requires an explicit choice to export the exact current Source anyway, guarded from the start of the check by a fresh snapshot of the active document and every checked workspace path and Source.

We rejected repository fetching because the story is about the current multi-document workspace and because a remote read would make offline export depend on network state. We rejected automatic link repair after a move because a filename change can be intentional and source-preserving guarantees require the author to make that edit.
