# Multilingual documentation

README Studio can keep language editions as separate workspace documents. Each edition preserves its exact Markdown and may have an explicit GitHub repository, branch, and path. Language metadata never publishes or rewrites a file.

## Configure an edition

Open **Documents**, choose the document group and complete its target. Set **Document language**, then choose either **This is the source edition** or another workspace document as **Translation source**. A translation cannot use another translation as its source. Each source/language pair and each repository/branch/path combination must be unique, so collisions fail without saving.

Supported manual selections are English, Spanish, French, German, Brazilian Portuguese, Japanese, Simplified Chinese, and Korean. The selected locale is a declaration by the author; Studio does not attempt language detection.

Language metadata is versioned local document metadata. A translation stores the source document ID, a SHA-256 revision digest, and up to 100 opaque section-identity digests, order positions, ambiguity flags, and section digests. Removed heading text is not retained in this metadata, and it does not store or infer translated prose. All-drafts backups and Studio projects retain this metadata; an ordinary Markdown export contains only the exact document source.

Revision tracking accepts at most 1 MB of UTF-8 Markdown per source document so synchronous local comparison stays responsive. Larger Markdown remains editable and exportable, but language revision metadata is not created until the source is reduced below that bound.

## Review translation drift

Open **Review → Translation review** from a translation document. The review compares the saved source revision with the current linked source:

- **Unchanged** means exact section bytes and order match.
- **Changed**, **Added**, **Removed**, or **Reordered** names the observed source difference.
- **Unknown** means repeated or missing section identities prevent a safe match, or the 100-section comparison bound was reached.

If a standalone Studio project is opened without its linked source, or that source was deleted, the saved link remains explicitly unavailable instead of invalidating the translation. Reconnect a source in **Documents** before acknowledging a new revision.

The review never guesses a correspondence between differently worded translated headings. Review the affected source and translation manually. Only after checking the acknowledgement can you mark the current source revision reviewed; the new metadata is persisted before the live review state changes and neither Markdown source is edited. A change to the source, translation, or localization settings while the dialog is open rejects the older review.

## Language-aware Health boundaries

Rendered heading structure and repeated section identities are language-independent and remain available. English wording and conventional-section heuristics are identified as **Unknown** for non-English editions; this avoids presenting English-specific guidance as evidence about another language. Link, media, security, compatibility, and exact-source checks continue to run in README Health, but all findings remain advisory.

Configuration, comparison, and acknowledgement run locally and make no network request. They work offline after the application and lazy review tools have been cached. Native labels, controls, status announcements, keyboard focus, and 320 CSS-pixel reflow are covered by automated browser checks; those checks are not assistive-technology certification.
