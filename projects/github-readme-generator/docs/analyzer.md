# README Analyzer

Health inventories headings, links, images, badges, widgets, code, HTML and sections. Its Overview and category views explain advisory findings without a score. Source buttons select the relevant editor text. A stale result cannot select text in a changed draft.

Offsets use JavaScript UTF-16 characters; lines and columns start at one. CRLF, CR and Unicode source remain unchanged. Nested parser constructs may have approximate ranges, explicitly labeled in the UI. Code samples, escaped tags and HTML comments are not treated as live markup. HTML scanning is conservative and is not a full browser DOM parser.

Statistics count source words (including Markdown syntax), not prose quality. Section boundaries follow successive headings, with neutral image/link/code counts. Multiple H1s, empty group headings, decorative images and repeated links can be intentional. Width warnings inspect declared attributes, never remote image dimensions. Clutter thresholds are heuristics: eight badges per source line, 25 per section, four consecutive widgets, eight separators or decorative headings, and 20,000 characters per section.

Analysis runs in a coalescing worker after editing settles. The structural and compatibility passes share a one-document token cache inside that worker. Preview remains independently sanitized on the UI side; no analyzer output rewrites source or export. Findings are capped at 1,000 per document to bound diagnostic growth. Analysis makes no network requests.

Run `npm test` for source ranges, hostile markup, parser exclusions and large-document checks. `tests/browser/analyzer.spec.js` verifies category navigation and keyboard source selection in all configured browser engines.
