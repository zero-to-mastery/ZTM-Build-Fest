# Portable HTML pipeline

`PortableProjection::portable_html()` and `portable_markdown()` derive destination-neutral
representations from the canonical authored Markdown. They use the Markdown event renderer and
authored source, never parse generated production HTML to reconstruct content. Native output
remains unchanged.

The renderer preserves the configured punctuation and heading-anchor behavior, resolves Markdown
links and image destinations against the canonical article URL (or the site base for root-relative
paths), and returns the capability descriptors discovered during rendering. Absolute URLs,
fragments, query strings, and Unicode destinations are covered by tests. Invalid or executable
links fail with a source-scoped error instead of silently producing a successful projection.
Native builds report optional portable projection failures as source-scoped warnings.
Explicit checks/exports still fail for those projections. Required portable destinations,
including full-content feeds, are generated before any output writes or stale-file cleanup;
their failure leaves existing generated output intact.

The HTML projection is a body, not a complete page. Full-content RSS and JSON Feed now use its
static HTML fallbacks; JSON Feed also includes text derived from the portable Markdown projection.
Syndication adapters use portable HTML or Markdown according to their destination policy.
`representation(Html)` continues to return the existing native `post.html`. Admin's authenticated
unsaved preview offers native, portable HTML, portable Markdown, and destination-policy views
using the same projection as production. Its diagnostics include the source, severity,
transformation, and recommended action. Authored raw HTML follows the
[raw HTML policy](#raw-html-urls-anchors-and-size-bounds) below.

Portable Markdown is a CommonMark-oriented article with a canonical identity header and public
attribution/provenance metadata. Knowledge checks become a question, choices, answer, and
explanation; runnable fences become ordinary code with a canonical-run link and, for eligible
Rust examples, a prefilled Playground link; web sandboxes become
labelled source fences; callouts become titled blockquotes. Raw HTML is escaped and called out
rather than executed. Markdown source can be inspected without writing files:

```sh
openblog export my-post --format markdown
openblog export my-post --format markdown --out exports/my-post.md
openblog export my-post --format markdown --out exports/my-post.md --write
```

The first two forms are dry runs; only `--write` creates a file, and an existing file is never
overwritten.

HTML comments and other non-content declarations are removed from portable Markdown and its
text companion, not exposed as escaped text. Comment syntax in fenced or inline code remains
authored example content. Comments spanning Markdown blocks follow the same fail-closed
validation as portable HTML.

Admin warning acknowledgements are tracked separately in a per-post `.portability.json` sidecar.
Each record is bound to the portable source revision, capability, representation, and destination.
Acknowledging records an author's review but does not hide the warning or bypass projection errors;
changed source content makes the previous record stale.

Diagnostics carry optional `representation`, `destination`, `portabilityLevel`,
`affectedSemantics`, and `sourceRange` fields alongside their existing code, severity,
capability, source path, message, and recommendation. Ranges are relative to the Markdown
body, not front matter: one-based Unicode-character line/column positions, with an
exclusive end. Repeated capabilities retain separate locations. Article-level findings
and capabilities without precise parser locations have no range; no location is invented.
Admin rebases ranges to the exact unsaved body, including its leading blank lines.
Excluding private state is a privacy boundary, not a loss that may be acknowledged away.

Markdown conversion edits parser-provided source offsets rather than scanning lines for
custom fences. Nested list/quote containers, multiline inline destinations and reference
definitions retain their structure. Literal inline and indented code remain examples,
not links or executable custom syntax.

## Portable Markdown dialect and export contract

This is the destination-neutral contract for
[#115](https://github.com/journey-to-code-org/open.blog/issues/115), under
[ADR 0004](../adr/0004-portable-projections-from-canonical-work.md).
Exported Markdown is a derived delivery artifact, **not** the canonical authored Markdown
and not a round-trip editing format. Neither exporting nor selecting an Admin preview
rewrites the source, native HTML, front matter, or sidecars.

### Baseline and intentional extensions

The baseline is CommonMark: paragraphs, emphasis, headings, thematic breaks, nested
lists/quotes, ordinary links/images, inline code, and fenced/indented code. Ordinary
HTTP(S) links keep their destinations; relative destinations, root-relative destinations,
and fragments resolve against the canonical article/site context. `mailto:` and `tel:`
are supported link schemes; destination image plans require HTTP(S). Executable,
credential-bearing, and malformed URLs fail validation rather than being passed through.

Code examples remain literal code, including examples that contain link-like text,
raw HTML, or custom fence syntax. Generated fences grow when necessary so nested
backticks do not terminate the example. Fence delimiters/whitespace may be normalized;
preserving authored code and readable structure does not imply byte-identical Markdown.
The exported body uses LF line endings and deterministic metadata/fallback ordering.

| Intentional extension | Export behavior | Reader without that extension |
| --- | --- | --- |
| GFM tables | Preserve the authored pipe table and cell order. | Pipe-separated text still includes headers and cell facts, but table navigation is not guaranteed. |
| GFM task lists | Preserve `[x]` / `[ ]` and item order. | Markers and labels remain readable list text; no editable state is promised. |
| Strikethrough | Preserve `~~text~~`. | Delimiters remain visible; readers must not assume typographic deletion is understood. |
| Footnotes | Preserve references and definitions. | Labels, definition text, and evidence URLs remain readable; cross-linking is reader-dependent. |
| Heading attributes | Preserve authored `{#id}` / attribute syntax. | The annotation may display literally; exported links point to real canonical anchors, not assumed remote anchors. |
| open.blog/GFM callout markers | Convert `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, and `[!CAUTION]` to bold titles inside ordinary blockquotes. | The title and quoted content need no callout extension. |

The dialect does not claim full GFM conformance, identical typography, or uniform
third-party support for extensions. Smart punctuation is not applied to the authored
Markdown export. open.blog custom quizzes, runnable fences, web sandboxes, and recognized
embeds are converted according to the [static fallback contract](#static-fallbacks-for-interactive-capabilities);
they are not additional requirements imposed on destination readers.
Raw HTML is escaped as literal text with a visible note, never executed. HTML comments
and declarations are excluded; literal comment syntax inside code stays example content.

### Envelope, identity, and public context

No YAML/TOML front matter or arbitrary private metadata is exported. The artifact begins
with an escaped level-one title, a blank line, `Canonical: <absolute-article-url>`, and an
optional subtitle, followed by the converted body. Public context follows in this order,
when present:

1. **Contributions** from explicit credit sidecars, preserving names, roles, public links,
   and unauthenticated ORCID labels. Credits do not replace bibliographic references.
2. **Work details**: resolvable DOI and license links.
3. **Video details** and **Recipe details**: applicable public facts.
4. An **Originally published at** provenance link when the native publication has one.
5. Visible raw-HTML/export notes, capability fallback/review notes, canonical-only
   interaction explanations, and an applicable discussion link.

Empty sections are omitted; authored bibliography, captions, facts, and ordinary expected
output stay in the body. Private research/reader notes, credentials, attempts, moderation
state, and arbitrary front matter do not enter the artifact. Public CLI exports reject
drafts and future-scheduled posts; authenticated unsaved previews are a separate boundary.

### Loss reporting and destination separation

The Markdown artifact contains reader-facing fallback notes, not a provider payload,
credential, embedded diagnostics JSON, or a numeric portability score. Machine-readable
losses accompany it in the version-1 `export --format markdown --json` manifest under
`diagnostics`, with exact `content`, UTF-8 `bytes`, `sourcePath`, `sourceRevision`,
`canonicalUrl`, representation, capabilities, and dry-run/write intent. Findings retain
stable codes, severity, source/capability, affected semantics, repair guidance, and optional
source ranges as described above.

Safe transformations remain visible warnings; invalid content/URLs and size-bound failures
are errors, not successful truncated output. Errors identify the source and, where known,
the capability. Acknowledgements record scoped review and cannot suppress errors or change
the artifact. Private-data exclusion is protection, not a semantic loss to override.

DEV/Hashnode tag selection, request envelopes, provider byte limits, Ghost Lexical conversion,
WordPress canonical limitations, and Medium manual-import instructions belong to
[destination policies](../cross-posting.md#content-subsets-and-media-review), not this
dialect. Projecting the same post therefore does not change when a target is selected.
Native rendering and legacy article behavior remain unchanged.

The executable specification fixtures in
[`portability_contract.rs`](../../crates/openblog-core/tests/portability_contract.rs)
parse the baseline with extensions **disabled** and verify structure, destinations, literal
code, deterministic output, privacy, and unchanged native/source content. A separate fixture
enables exactly the documented extensions, asserts their events, and verifies that their
substantive facts remain present with a plain CommonMark parser.

## Browser release gates

After building the CLI, run the isolated browser project from the repository root:

```sh
cargo build -p openblog-cli
npm ci --prefix tests/browser
cd tests/browser
npx playwright install chromium
npm test
```

CI installs Chromium and its Linux dependencies and runs these same tests. The fixture
starts the actual authenticated server on loopback with temporary content and credentials;
it stops its own server and removes its temporary content afterward. Browser XML/JSON
parsers independently check RSS/JSON Feed parity, discovery, absolute URLs, substantive
facts, privacy boundaries, and real native anchors. Script-disabled/no-CSS, print,
reduced-motion, narrow-viewport, and keyboard checks exercise static fallbacks.
Authenticated tests exercise real unsaved edits, grouped losses, exact downloads,
clipboard output, source focus/selection, and fail-closed exports after preview errors.
Windows clipboard reads normalize line endings; downloaded bytes remain exact.
These automated checks do not claim screen-reader or WCAG conformance.

## Static fallbacks for interactive capabilities

Generated markup in the projection needs no open.blog script, custom element, form control,
iframe, `hidden` attribute, or stylesheet. Each current capability renders as ordinary HTML
([#112](https://github.com/journey-to-code-org/open.blog/issues/112)):

| Capability | Portable fallback | What moves to the canonical article |
| --- | --- | --- |
| Knowledge check (`quiz` fence) | The prompt, choices as a lettered list, then the author's answer and explanation, visible without opening a disclosure. Portable Markdown likewise shows the answer after the choices. | Scoring, retry, and remembered answers. |
| Runnable code (`rust runnable`, configured runner languages) | The authored source in `<pre><code>` with its title and line options (`showLineNumbers`, the start line, and `{2}` highlights as `data-line-*` attributes, as on ordinary fences), plus a canonical run/edit link. Rust examples also have an **Open in Rust Playground** link with the exact source URL-encoded, using stable/debug/Rust 2021 to match the native runner. `playgroundLink=false` opts out. Encoded URLs over 8 KiB omit the external link, never the source or canonical link. Fences the canonical page cannot run stay ordinary code. The runner endpoint is never included. | In-copy editing, execution, and output; eligible Rust examples can be opened externally. |
| Web sandbox (`web runnable`) | The HTML, CSS, and JavaScript as separate, labelled, escaped code blocks (text before the first marker is kept), plus a link to the live preview. | The isolated live preview. |
| CodePen and YouTube embeds | A titled link to the provider: the authored link text and address when present, otherwise the rebuilt provider address. Hashnode `%[url]` syntax never reaches the output. A video post's `videoUrl` becomes a link at the top unless the body already links that video, after the same production notes (season and episode, status, credits) the native page shows. | The embedded frame. |
| Video chapters | In video posts, a paragraph whose lines (two or more) all start with a timestamp, or a tight bulleted list (`- 00:00 Intro`) whose items all do, becomes an ordered chapter list. Timestamps follow the Admin release kit: `M:SS` or `H:M:SS` with up to two hour and three minute digits, with seconds (and, after an hour, minutes) under 60. The list has `<time>` values, linked to that moment when the post has a YouTube video. | Nothing. |
| Recipes and callouts | A recipe summary list with the same facts as the native card (prep, cook, and total time, servings, yield, cuisine, course, calories) comes first; ingredient and step sections keep their headings and lists; callout titles are bold so they read without styles. | Scaling, timers, checklists, and cook mode. |
| Comments | When the canonical page offers comments, a link to join (or, when locked, read) the discussion there, reported as a `comments` capability with the canonical-only portability level. Hidden comments or an unconfigured backend add nothing, and the hosted endpoint never appears. | Reading and posting comments. |

open.blog has no authored expected-output field for runnable code: output an author writes as
ordinary Markdown next to the fence stays visible like any other content. Portable quiz answers
are visible on screen and in print; the native quiz retains its interactive answer-checking flow.
Generating an external Playground link makes no network request and creates no Gist. The
reader chooses whether to send the embedded source to the Playground by following the link.
Web sandboxes remain labeled, copyable HTML/CSS/JavaScript source plus a canonical live-preview
link; no CodePen export or remote write is attempted.

A `quiz` or `web runnable` fence with no text at all has always built, so it still builds (an
empty knowledge check, or a sandbox with no source); any written content is validated.

Fallbacks stay inside their container, so a quiz or runnable example in a callout, quote, or
list item keeps its position. A malformed capability fails the projection with the source path
and that capability's error and diagnostic; the canonical Markdown, the native HTML, and any
remote state are left untouched.

Markdown recipe details use the native duration formatter for numeric prep/cook/total
times (including computed totals), while preserving nonnumeric text such as "overnight"
or "10-15 min". Runnable language names follow the native renderer's case-insensitive
recognition, so `WEB runnable` and `web runnable` both produce labeled HTML/CSS/JavaScript
sources and the canonical live-preview link.

Reviewed Markdown golden artifacts for the video lesson, recipe, translated research, and hostile imported HTML
live beside their source fixtures under
[`tests/fixtures/portable-html/`](../../tests/fixtures/portable-html/).
`current_markdown_fallbacks_match_reviewed_golden_artifacts` parses these artifacts as plain
CommonMark and checks static output, readable answers/timestamps/captions/code, privacy,
stable bytes, and unchanged canonical/native content. Set `OPENBLOG_UPDATE_GOLDEN=1` only
when intentionally regenerating and reviewing golden changes; ordinary test runs compare
against the committed artifacts without updating them. Core regressions additionally cover
fence collisions inside nested containers and malformed capability failures.

### Semantic-loss gate

Every portable HTML, Markdown and text artifact is checked against required public facts
from the canonical model and the existing parsed/sanitized source events before it is returned.
This is an output validation pass, not reconstruction of authored semantics from native HTML.
Missing facts produce blocking `missing-semantic-fact` errors with the source path, capability,
representation and affected field. They cannot be acknowledged away. Mutation regressions remove
choices, designated answers (even when the answer remains among the choices), explanations,
source code, captions, timestamps, contributor names/roles/identifier provenance, work identifiers,
license links, evidence links, uncertainty and recipe facts from each representation.

Ordinary authored links and images additionally require a matching destination/label relationship
in HTML and parsed Markdown, consuming one output occurrence per source occurrence. An unrelated
link, image source, or visible URL text cannot stand in for a lost anchor relationship.
Repeated metadata link obligations also require distinct anchors; intentionally deduplicated
canonical-only notes and a video's body/metadata identity retain their shared fallback.
Text requires the readable
label-and-destination fallback, also with occurrence counts. Recognized standalone embed
autolinks may use their declared provider label in HTML; authored link labels stay intact.
Bare recognized embed URLs become explicitly labeled Markdown links to their provider.
Video identities come from source embed detection, never presentation markup. Portable
Markdown uses the native fence-option parser, including comma-separated runnable options.

The gate otherwise checks content presence after whitespace normalization, not layout, factual correctness,
or a proof of accessibility. Order, nesting, anchor resolution and readable static presentation
have separate golden/browser gates. Raw HTML deliberately has different policies: HTML checks
the allowlist's retained content, while Markdown/text show literal authored markup and disclose
that transformation instead of promising the HTML allowlist's reconstructed elements. Private
comments and hidden active content are excluded before deriving HTML obligations, so they cannot
be exposed in diagnostic messages. Diagnostic messages name fields, never missing private values.
Plain-text citations retain their authored note identifiers alongside readable note definitions.

## Research, attribution, and planned structures

The projection keeps what identifies and credits the work
([#113](https://github.com/journey-to-code-org/open.blog/issues/113)), in the order the native
page shows it:

- **Credits.** A post with an explicit credit sidecar starts with the same ordered
  "Contributions" list as the native page: each name, its role labels (for example *Author*
  or *Translator*), and a manually entered ORCID iD marked "(unauthenticated)". Contributor
  links resolve against the site, and the decorative ORCID icon (a site asset) is left out.
  Credits are attribution: they never enter the References section or `references()`. A post
  credited only to the legacy site author gets no list; consumers take that byline from
  `authors()`, as feeds do.
- **Work identity.** A research post's DOI and license follow, as on the native page. A DOI
  that cannot be resolved is not shown as the work's identifier there or here; the evidence
  audit reports it.
- **References and citations.** Reference links keep their exact address, including page or
  section fragments and query strings, and references without a link stay visible as text.
  Footnote citations keep their number and note id; each citation links to the note on the
  canonical article (`…/post/#note`), as heading anchors do, so a copy that drops ids still
  reaches the cited note. A repeated citation keeps one number.
- **Provenance.** A `sourceUrl` adds the native "Originally published at" line after the body.
  It must be an absolute HTTP(S) address without credentials; anything else fails the
  projection for that post.

Planned research and reader capabilities (the ids in the
[planned-capability registry](./planned-capability-contracts.json): comparisons, timelines,
source previews, guided explanations, relationships, reading paths, interpretations,
reflections, diagrams, and the rest) have no authoring syntax or portable fallback yet. Until
their owning story ships one, a capability the canonical page reports without a portable
fallback fails closed: its authored content stays visible as ordinary Markdown, a labeled note
such as "**Timeline**: see it on the original article" links to the canonical article, and the
capability is reported with the canonical-only level. The note is article-level for now: until
an owning story detects the block, nothing locates its content, so notes follow the whole body
(footnotes included) rather than the block they describe. An unknown capability gets the label
"Interactive content". Private-only state (local reader annotations and protected reflection
drafts) adds nothing to the copy and is left out of the capability report, so no destination
learns that it exists. Unknown front matter stays in the canonical source and never
reaches the output.

## Raw HTML, URLs, anchors, and size bounds

Authored raw HTML (HTML blocks, inline tags, and `{key=value}` heading attributes) is
untrusted ([#114](https://github.com/journey-to-code-org/open.blog/issues/114)). The projection
tokenizes it and writes it out again from a fixed allowlist, so nothing authored reaches a
destination byte for byte, and anything that is not complete markup (a stray `<`, an
unterminated tag) becomes escaped text. This is the projection's policy, not a general-purpose
sanitizer API. The native page keeps passing raw HTML through, as before.

| Authored markup | Portable output |
| --- | --- |
| Static content elements: paragraphs, headings, lists, tables, quotes, figures, `<details>`, `<abbr>`, `<kbd>`, `<time>`, `<img>`, links, and similar | Kept, with `id`, `class`, `title`, `lang`, `dir`, `aria-label`, `aria-labelledby`, `aria-describedby`, and each element's own static attributes (for example `href`, `src`, `alt`, `cite`, `datetime`, `colspan`, `scope`, `open`). Anything else, including `style`, `target`, `srcset`, `data-*`, and every event handler, is removed. |
| `<script>`, `<style>`, `<noscript>`, `<template>`, `<title>`, `<textarea>`, `<select>`, `<button>` | Removed with their content, including any Markdown written inside them, until their end tag. An inline one that is never closed ends with its paragraph (or other container). One opened in an HTML block that hides authored content after the block and is never closed fails the projection for that post, naming the element, such as `posts/work.md: raw HTML <iframe> is never closed …`, since a browser would hide that content too. A paragraph left empty by removals is removed. |
| `<base>`, `<meta>`, `<link>`, `<input>`, `<source>`, `<track>`, `<area>` | Removed. |
| `<iframe>`, `<frame>`, `<object>`, `<embed>`, `<video>`, `<audio>`, `<canvas>`, `<svg>`, `<math>` | Replaced with "**Video**: see it on the original article" (or Embedded frame, Embedded object, Interactive graphic, Illustration, Math), naming the element's `title` or `aria-label` when it has one. Nothing inside them is kept or checked. |
| `<form>`, `<label>`, page landmarks (`<nav>`, `<main>`, `<header>`, `<footer>`), presentational tags (`<font>`, `<center>`), custom elements (including hand-written `<ob-…>` tags), and unknown elements | The tags (and their attributes) are removed; their content is kept. |
| Comments, doctypes, processing instructions, and CDATA | Removed without a report, since they are never reader content and may hold private notes. A comment left open at the end of its HTML block (for example one split by a blank line inside a `<div>`) keeps hiding everything after it, Markdown included, until a later raw `-->`, as in a browser; if it would hide authored content and is never closed, the projection fails for that post. |

Every removal is reported once per kind as a `raw-html` capability (gracefully transformed,
fallback `allowlisted-html`) whose `RemovedMarkup` diagnostics name the removed elements and
attributes, never their content. A post whose raw HTML loses nothing reports no `raw-html`
capability.

**URLs.** `href`, `src`, and `cite` values are decoded (numeric and common named character
references) and then resolved exactly like Markdown links: relative paths against the canonical
article, root-relative paths against the site base, `#fragment` links to the fragment on the
canonical article. A value that cannot be made a safe HTTP(S), `mailto:`, or `tel:` URL
(`javascript:` in any spelling or encoding, `data:` URLs including SVG images, credentials,
control characters, or an empty value) fails the projection for that post with the element and
attribute named, such as `posts/work.md: link must use HTTP(S), mailto, or tel (raw HTML <img src>)`.
A `<base>` element is removed, so it cannot redirect relative URLs.

**Anchors.** Raw `id` values are kept as written, Unicode included, so authored fragment links
keep their target; a legacy `<a name>` anchor becomes an `id`. An id that repeats an earlier raw
id, a heading id, or a footnote id, that contains whitespace, or that starts with the reserved
`ob-` prefix is removed and counted in the report; for a duplicate, the heading or first element
keeps the anchor. A heading id (`{#id}` or a slug) that repeats an earlier heading's id or a
footnote id, or starts with `ob-`, is renamed to a unique id without the prefix (`x-2`,
`contributions-title`) and counted, so the first heading keeps the id it has on the native page. A
footnote named with the `ob-` prefix is written without an id and counted. Like every fragment link, a link to a
removed or renamed id points at the canonical article, where the native page still has that id,
so it reaches the original target there rather than a place in the portable copy.

**Images.** A raw `<img>` written without `alt` gets `alt=""` (decorative) and is counted in the
report, so every portable image has alternative text; add a real `alt` to describe it.

**Linear time.** An unterminated tag or quoted value is escaped text through the end of its
fragment, so hostile or broken markup costs time in proportion to its length.

**Balance.** Kept elements are closed inside the Markdown container that opened them, a stray
end tag is dropped (a stray `</br>` is a line break, as in a browser), and anything still open at
the end of the body is closed there. The finished body is then balanced once more as a whole, so
an element left open in a recipe section closes before the section does, and the body can be
embedded in any destination container without closing it early.

**Bounds.** A portable body larger than `MAX_PORTABLE_HTML_BYTES` (2 MiB), or nested more than
`MAX_PORTABLE_NESTING_DEPTH` (64) elements deep, fails the projection for that post with a
diagnostic naming the bound. Nothing is ever truncated. As with every projection failure, the
canonical Markdown, the native HTML, and any remote state are left untouched.

## Tests

The focused contract is tested in
[portability.rs](../../crates/openblog-core/src/portability.rs) and
[markdown.rs](../../crates/openblog-core/src/markdown.rs). The golden suite in
[portable_html.rs](../../crates/openblog-core/tests/portable_html.rs) renders the
[video lesson](../../tests/fixtures/portable-html/video-lesson.md),
[recipe](../../tests/fixtures/portable-html/recipe.md),
[research](../../tests/fixtures/portable-html/research.md) (with a
[credit sidecar](../../tests/fixtures/portable-html/research.credits.json) naming two authors
and a translator), and [hostile HTML](../../tests/fixtures/portable-html/hostile-html.md)
fixtures and compares them with their expected `.html` files. The last is an imported post
with scripts, event handlers, a `<base>` tag, frames, SVG, a form, a private comment,
duplicate ids, a legacy anchor, and unclosed tags. It also checks that the output has no runtime-only elements or
attributes, uses only absolute URLs, has a target for every anchor, gives every link an
accessible name and every image alternative text, and leaks neither the comments nor the runner
endpoint nor unknown front matter. The shared [portability fixtures](../../tests/fixtures/portability-contract.json)
also render through `portable_html()`.
