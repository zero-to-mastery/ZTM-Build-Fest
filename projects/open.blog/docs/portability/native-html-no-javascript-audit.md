# Native HTML and no-JavaScript audit

- Status: audit of current behavior; no portability transformations added
- Date: 2026-10-24
- Issue: [#108](https://github.com/journey-to-code-org/open.blog/issues/108) (Task P2.2)
- Parent story: [#94](https://github.com/journey-to-code-org/open.blog/issues/94) · Parent epic: [#92](https://github.com/journey-to-code-org/open.blog/issues/92)
- Related matrix: [capability-matrix.md](./capability-matrix.md)

## Scope and method

This audit follows the generated markup in `crates/openblog-core/src/markdown.rs` and
`crates/openblog-core/src/render.rs`, the custom-element entry point
`web/openblog.js`, component behavior in `web/components/`, and base presentation in
`web/base.css`. “No JavaScript” means the generated document is viewed without the
`/assets/openblog.js` module. “No CSS” means both base and theme stylesheets are absent.
Native browser behavior (for example radio selection, links, and `<details>`) is
distinguished from component behavior.

This is an implementation audit, not a security certification or WCAG conformance claim.
The accessibility auditor emits source-scoped `detected`, `potential`, and `needs-review`
findings; these are guidance, not proof that a page conforms
(`crates/openblog-core/src/accessibility.rs:10-47,74-125`; [Admin documentation](../admin.md)).

## Custom-element inventory

| Element | Server-rendered host content | Enhancement and runtime dependency | Without JavaScript | Without CSS / remaining gap |
| --- | --- | --- | --- | --- |
| `<ob-code>` | Wraps the post/page prose and ordinary `<pre><code>` blocks. | `ob-code.js` tokenizes code, optionally numbers/highlights lines, and adds copy buttons when Clipboard API is available (`web/components/ob-code.js:1-130`). | Source code remains selectable and readable; copy/highlight/numbering enhancements are absent. Tokenizer failures leave source text intact. | The semantic `<pre><code>` survives, but colors, spacing, and line presentation are lost. |
| `<ob-rust-playground>` | A `<pre><code>` block containing the authored Rust source (`markdown.rs:531-585`). | `ob-rust-playground.js` adds an editor, run/reset/copy controls, status/output, and optional external Playground link. Running sends edited source to the official Rust Playground (`web/components/ob-rust-playground.js:1-147`). | Original code remains available; there is no editor or execution. No code is sent. | The source block is hidden by CSS only after enhancement; with scripts disabled it stays visible. If CSS is disabled while scripts run, both source and added editor can be visible. |
| `<ob-code-runner>` | A `<pre><code>` block and configured endpoint/language attributes (`markdown.rs:531-585`). | `ob-code-runner.js` adds editing and sends source/stdin to the configured external runner only when the reader activates Run (`web/components/ob-code-runner.js:1-130`). | Original source remains available; no editor, network request, or execution occurs. | Source is hidden only by a CSS selector after JS enhancement (`web/base.css:844`); without CSS it can appear alongside the editor. |
| `<ob-web-sandbox>` | Escaped source in `<pre><code>` for the `html`, `css`, and `js` sections (`markdown.rs:549-585`). | `ob-web-sandbox.js` adds editors and a preview iframe. The iframe is sandboxed with `allow-scripts` only and a CSP blocks external resources and network APIs (`web/components/ob-web-sandbox.js:1-121`). | Authored source remains visible as code; no preview is created and nothing executes. | After JS starts, the component hides the original `<pre>` using the native `hidden` attribute and shows editors/iframe. Without CSS, the preview remains functional but visually unstructured; source is still available in the editors. |
| `<ob-quiz>` | A labelled section with custom element, `<fieldset>`, `<legend>`, labelled radio choices, and initially hidden feedback/retry button (`markdown.rs:214-365`). | `ob-quiz.js` scores answers, reveals feedback and correct-answer state, supports retry, and stores the selected option in browser local storage (`web/components/ob-quiz.js:1-86`). | The question and choices remain readable and radios are selectable, but there is no score, answer feedback, explanation reveal, or retry. Correctness is present in the HTML `data-correct` attribute; this is not an assessment boundary. | Native fieldset/radio semantics remain. Styling is lost. The initial `hidden` feedback stays hidden because the component does not run. |
| `<ob-compare>` | Two `<figure class="ob-compare-pane">` elements, each an `<img>` with `alt` and a `<figcaption>` that starts with its label, inside a custom element (`crates/openblog-core/src/compare.rs`). | `ob-compare.js` moves the pictures under one native range input with a drag handle; the captions stay below. It does nothing when the reader prefers reduced motion and switches live if that changes. | Both pictures and captions are visible side by side (stacked on a narrow screen); nothing is hidden. | Native figure, image and caption semantics remain. Styling is the base stylesheet's grid. |
| `<ob-reading-modes>` | A wrapper around the article prose of a post with supplements; every `.ob-supplement` group is written out visible with its label, quote and end line, and no `hidden` is written (`render.rs`, `reading_depth.rs`). | `ob-reading-modes.js` adds a Reading mode radio group, hides supplements the chosen mode does not show (never one that holds a warning), announces changes and keeps the choice in local storage (`web/components/ob-reading-modes.js`). | Nothing is hidden and no control exists, so the whole page reads in order. | Labels, quotes and end lines are structure, so each supplement is still set apart; only the group border and inset are lost. |
| `<ob-recipe>` | Summary card, ingredient/step sections, and ordinary lists (`render.rs:1460-1645`; `markdown.rs:620-735`). | `ob-recipe.js` adds configured scaling, checklists, timers, cook mode, print controls, and per-device checklist state (`web/components/ob-recipe.js:1-100,160-405`). | Recipe content and instructions remain plain HTML lists; all controls and stateful conveniences are absent. | Text and lists remain; grouping and action affordances lose their visual treatment. |
| `<ob-comments>` | A paragraph explicitly says “Comments require JavaScript.” (`render.rs:1145-1161`). | `ob-comments.js` replaces the placeholder, loads approved comments, and optionally submits comments to the configured endpoint (`web/components/ob-comments.js:1-104`). | Placeholder is the only content; no remote read or write occurs. Locked discussions are also only described by the fallback text. | The placeholder remains legible. Once JS runs, comments/form content is constructed as DOM text, but the layout is lost. |
| `<ob-search>` | GET form, labelled search input, live-status paragraph, and result list; a `<noscript>` message links to archive and tags (`render.rs:1925-1936`). | `ob-search.js` fetches the search index, uses WASM ranking or a JavaScript substring fallback, and updates results in the page (`web/components/ob-search.js:1-128`). | The form does not provide server-side search results; the explicit `<noscript>` message offers archive/tag navigation. | Form and fallback links remain browser-operable but are unstyled. |
| `<ob-theme-toggle>` | A button is rendered inside an element with the native `hidden` attribute (`render.rs:675-681`). | `ob-theme-toggle.js` removes the hidden state, toggles theme tokens, and optionally remembers the preference (`web/components/ob-theme-toggle.js:1-52`). | The control remains hidden; system/default theme is used. | If JS runs with CSS absent the button is revealed and still operable, but unstyled. |
| `<ob-share>` | A navigation list of ordinary destination anchors (`render.rs:1350-1419`). | `ob-share.js` optionally adds the device share sheet and a copy-link button (`web/components/ob-share.js:1-47`). | Configured share anchors work as links; no share-sheet or clipboard button is added. | Anchors remain usable; list/navigation styling is lost. If no share networks are configured, the navigation has no links and the enhancement has no native destinations to supplement. |
| `<ob-views>` | A baked-in count is inserted as text when available (`render.rs:1034-1046`). | `ob-views.js` requests a live count unless privacy settings or session state choose a read-only count; it honors DNT/GPC and avoids automated browsers (`web/components/ob-views.js:1-60`). | Baked text remains. An empty element has no count; no analytics request occurs. | Any baked text remains. Empty elements have no content (`web/base.css:1481-1483` hides them when CSS is present). |
| `<ob-back-to-top>` | An empty custom-element host appended to generated pages (`render.rs:616-623`). | `ob-back-to-top.js` creates a labelled button after module execution and adds scroll/focus behavior (`web/components/ob-back-to-top.js:1-30`). | Empty element; no button or back-to-top action. This is an optional convenience, not a content path. | If JS runs without CSS, the button exists and works but lacks its fixed/visibility styling. |
| `<ob-citation-previews>` | An empty host at the end of `<main>`, only on the page of a post that publishes citations, whose markers are `doc-noteref` links to focusable notes and whose head carries the `ob-references` data ([ADR 0061](../adr/0061-citation-previews-are-a-progressive-non-modal-component.md)). | `ob-citation-previews.js` opens a preview of the cited reference beside a marker on focus, hover or a first tap, from the inline data only, as text; no requests or storage. | Markers link to their notes and back; nothing is lost, the preview is absent. | The preview text and links still appear after the marker while open, without its panel styling. Print hides it. |
| `<ob-passage-feedback>` | A "Questions and corrections" region after the post's navigation, only on an open post of a site that opts in to hosted feedback; its static text explains how to name a section, quote the words and give the printed passage revision, with the optional `engagement.feedbackContact` link, and the head carries the `ob-passages` data ([ADR 0082](../adr/0082-passage-feedback-forms-are-one-progressive-region-over-the-build-passage-text.md)). | `ob-passage-feedback.js` replaces the "needs JavaScript" paragraph with a labelled form, maps selections onto the published passage text, and sends to the configured endpoint's `/feedback` route; on failure it offers the note to copy. No storage. | The instructions and the contact link remain; reading is complete. | The form keeps its native controls and labels in one column. Print hides the region. |

The component entry module imports these elements as optional enhancements
(`web/openblog.js:1-14`). Content should not rely on that import to supply its only
copy of essential prose. Search and comments are intentionally interactive services;
their server-rendered fallback is navigation/help text rather than a local substitute.

## Other native structures and embeds

- Heading anchors and IDs, callouts, recipe lists, prose, and code fences are generated
  as HTML by the Markdown renderer (`markdown.rs:878-936,620-735`). Native HTML
  structure remains when JS is off.
- Table-of-contents sections use native `<details><summary>` disclosure markup
  (`render.rs:1080-1117`); browsers provide its open/close behavior without script.
- Supported standalone CodePen and YouTube URLs become `<figure>` markup containing an
  iframe **and a visible link below it** (`embed.rs:1-11,106-131`). If iframe rendering
  is unavailable, the link remains a route to the original provider. The iframe itself
  needs the provider/network and does not provide the embedded interactive experience
  offline.
- There is no dedicated audio renderer; direct raw HTML is passed to the Markdown HTML
  writer (`markdown.rs:917-936`; [content authoring docs](../content.md)). Raw HTML is
  therefore not an untrusted-content sanitization boundary: scripts, event attributes,
  or other active markup authored into a document are not converted to inert text by
  this path. Treat contributor-authored or imported HTML as unsafe unless a separate,
  verified sanitization layer is applied. This audit does not add that layer.
- CSS controls colors, layout, emphasis, and some enhanced-state hiding. Without CSS,
  semantic HTML and native controls remain, but visual grouping/affordances can be lost.
  HTML's built-in `hidden` attribute remains effective independently of CSS.

## Accessibility findings and fallback limitations

The source auditor can produce content findings for empty link names, image-alt review,
heading-level skips, link-purpose review, table structure, media alternatives, embed
accessibility, and raw HTML review (`accessibility.rs:29-47,145-265`). Site/theme/embed
findings are separate scopes. A `potential` or `needs-review` result does not mean a
failure was mechanically proven; the author must review the content in context.

Observed gaps/limitations:

1. **Quiz assessment is not available without JS.** Radios still work as native controls,
   but no result or explanation appears; answer correctness is already present in the
   generated document. Do not use this for a high-stakes or confidential assessment.
2. **Search and hosted comments have no offline data fallback.** Search offers archive
   and tag navigation in `<noscript>`; comments offer a clear JavaScript-required
   placeholder. Network failures after the component loads are reported in its status
   region, but do not make either feature work offline.
3. **Back-to-top is an empty host until JS runs; the theme toggle is deliberately
   hidden until JS runs.** Both are nonessential conveniences, but their fallback
   behavior should remain documented.
4. **CSS-disabled rendering is not represented by a browser DOM regression suite.**
   Existing Markdown/render tests assert generated markup and component source tests
   exercise JS logic; the located tests do not disable both JS and CSS in a browser and
   assert reading order, accessible names, links, or form operation.
5. **Raw HTML is active content, not sanitized fallback text.** The ordinary renderer
   preserves it. This is acceptable only under the current trusted-authoring assumption;
   imported/untrusted HTML requires a separately scoped sanitizer before it is exposed.

Existing test evidence includes native-markup assertions in
`crates/openblog-core/src/markdown.rs` and `crates/openblog-core/src/render.rs`, and
component behavior tests in [quiz.test.mjs](../../tests/web/quiz.test.mjs),
[comments.test.mjs](../../tests/web/comments.test.mjs),
[code-runner-component.test.mjs](../../tests/web/code-runner-component.test.mjs),
[rust-playground-component.test.mjs](../../tests/web/rust-playground-component.test.mjs), and
[web-sandbox.test.mjs](../../tests/web/web-sandbox.test.mjs). These are not substitutes for
the browser-level static DOM fixtures called for by issue #108's testing expectations;
those remain a follow-up test gap.

## Sources

- `crates/openblog-core/src/markdown.rs`
- `crates/openblog-core/src/render.rs`
- `crates/openblog-core/src/embed.rs`
- `crates/openblog-core/src/accessibility.rs`
- `web/openblog.js`
- `web/components/`
- `web/base.css`
- `tests/web/`
- [Content authoring](../content.md)
- [Admin Studio](../admin.md)
