# Example provenance is explicit Source metadata

Implemented in v1.9.14.

Each structured documentation code field and Code Sample block owns a local status and verification note. Its Markdown emits only an inert, portable status comment and content fingerprint immediately before the fence. New fields default to Placeholder; Verified requires a note; changing example text resets the claim to Placeholder. The fingerprint also makes a claim stale if raw Source changes without using the builder. Imported and legacy examples remain unclassified until the author explicitly edits provenance or example content and saves it; opening a form or editing an unrelated field does not classify them.

Copy and export use a bounded, container-aware Markdown scan of fences and status comments. Placeholder, unclassified, stale, unbound, invalid, orphaned, duplicated or incomplete results require an explicit unchanged-Source continuation guarded by a fresh source snapshot. This applies to whole documents, section forms and saved blocks. Studio never runs commands or examples and does not infer verification from repository contents, filenames or successful application behavior.

We rejected automatic command execution because imported source is untrusted and environment-dependent. We rejected silently treating authored text as verified because provenance is a claim the author must make explicitly. Notes stay local because they may describe internal verification context and are not needed by README readers.
