# Markdown, feed, and syndication semantic-loss audit

- Status: portable projection contract implemented for feeds and current adapters
- Date: 2026-10-24
- Issue: [#109](https://github.com/journey-to-code-org/open.blog/issues/109) (Task P2.3)
- Parent story: [#94](https://github.com/journey-to-code-org/open.blog/issues/94) · Parent epic: [#92](https://github.com/journey-to-code-org/open.blog/issues/92)
- Shared fixtures: [portability-contract.json](../../tests/fixtures/portability-contract.json)

## Scope and method

This audit follows one loaded post from its Markdown body through `Post`, native HTML,
plain text, public feeds, and provider payload builders. The fixture corpus now exercises
the same public fixture posts through the native document renderer, RSS, JSON Feed,
`llms-full.txt`, and DEV, Hashnode, Ghost, WordPress, and Medium syndication shapes.
These tests inspect local output only; no provider network calls occur.

The destination policy chooses a portable Markdown or HTML representation and describes its
canonical-URL behavior. Raw HTML is escaped in portable Markdown and follows the allowlist
policy in portable HTML. Neither representation claims that a third-party importer renders
every feature identically.

Projection errors include the canonical source path; semantic-loss diagnostics also identify
the affected capability and recommended action. Provider failures are reported by target.
The fixture tests only build local payloads. In the command path, dry-run returns before
verification, credential lookup, network requests, or private-state writes; neither previews
nor this audit change canonical source or remote state.

## Representation map

| Surface | Input and transformation | Retained semantics | Known loss or boundary |
| --- | --- | --- | --- |
| Canonical Markdown body | Front matter is separated; `Post.authored_markdown` retains the body. | Authored Markdown, custom fences, raw HTML, reference definitions, source links, and Unicode remain available for downstream rendering. | Structured sidecar credits, cover metadata, canonical metadata, and other front matter are not part of the body string. |
| `post.html` / native article | The Markdown renderer produces HTML, preserving standard structure and applying open.blog transforms for recipes, callouts, quizzes, runnable code, and embeds. The full native page adds metadata, bylines, navigation, and theme/runtime assets around it. | Content and accessible native fallbacks are present in the body HTML; full pages add structured metadata and visible credits. | Custom elements and raw HTML remain native markup; this is not a destination-neutral HTML conversion. |
| `post.text` and `llms-full.txt` | The renderer collects text events outside fenced code blocks, collapses whitespace, and the full-text feed adds article metadata and this text representation. | Ordinary prose and heading text remain. | Fenced code (including quizzes and runnable examples) is omitted. Link destinations are not included in text, so linked reference URLs reduce to their visible labels. The quiz fixture explicitly records this loss. |
| RSS `content:encoded` and JSON Feed `content_html` | When full-content feeds are enabled, each receives `portable_html()` from the canonical Markdown. JSON Feed also includes `content_text` derived from the portable Markdown. | Static capability fallbacks, resolved links, canonical interaction links, and public work context are included without open.blog custom elements. | JSON text is a readable plain-text projection, not a layout-preserving format. The native `post.html` remains unchanged. |
| DEV and Hashnode | Both receive portable Markdown. Hashnode receives it as `contentMarkdown`; DEV as `body_markdown`. | Quizzes, runnable examples, web sandboxes, callouts, attribution, and canonical identity are transformed into readable Markdown fallbacks; raw HTML is escaped and relative links are resolved against canonical context. | Provider rendering of standard Markdown extensions varies. Hashnode automation is draft-only; publish intent is rejected before writing. |
| Ghost and WordPress | Both receive `portable_html()` with resolved links and static fallbacks. | Rendered prose, headings, images, links, and public context are carried without open.blog custom-element markup. | Structured author credits and cover-image metadata are not separate provider fields in these requests. WordPress payloads do not include `canonical_url`; the adapter warns that core WordPress cannot set an external canonical URL. |
| Medium | Manual-only instruction points the user to Medium's Import a story flow and supplies the canonical open.blog URL. The JSON dry-run plan also exposes a portable Markdown artifact for review; no remote request is generated. | The source article remains accessible at its canonical URL for the import workflow. | Extraction, formatting, canonical assignment, images, byline, and reference handling are controlled by Medium and are not verified or asserted by this repository. |

Source traces: `crates/openblog-core/src/model.rs:145-195,855-880`;
`crates/openblog-core/src/markdown.rs:815-895,917-936`;
`crates/openblog-core/src/render.rs:100-130,435-480`;
`crates/openblog-core/src/feeds.rs:13-169,317-355,395-400`;
`crates/openblog-cli/src/syndication.rs:539-592,597-735,951-1156,1160-1360`.

## Identity, attribution, references, and media

- The portable projection's canonical URL is the site's URL for the post. RSS item `link` /
  `guid`, JSON Feed `id` / `url`, and the syndication canonical URL use that identity.
  A post's optional `canonical` field is separate: native social metadata may use it, and
  JSON Feed exposes it as `external_url`; RSS does not emit it as a separate field.
  Syndication uses the projection URL, not the optional override.
- RSS authors are emitted as `dc:creator`; JSON Feed has site-level author data and may
  carry explicit per-item author names/URLs. The provider request builders do not emit
  the structured credit sidecar as a separate author field, even though a native full
  page renders visible contribution credits.
- Research reference sections survive as rendered body content in HTML and as authored
  Markdown in the Markdown targets. The separate reference model is not projected into
  a dedicated RSS or provider field. Native `post.text` keeps link labels but omits their
  targets; portable text includes link destinations.
- RSS emits a cover as an `enclosure` with inferred MIME type and length `0`; JSON Feed
  emits it as `image`. Syndication payloads do not send the cover as a dedicated field.
  Body images remain in HTML/Markdown, subject to the URL behavior above.
- HTML embeds and open.blog components become static fallbacks or canonical links in
  full-content feeds and syndication payloads. Portable Markdown escapes authored raw HTML;
  portable HTML applies the fixed allowlist. Neither claims remote interactive parity.
- Comment policy and other open.blog-only interaction configuration do not have separate
  feed/provider fields. Portable output links participation back to the canonical work.

## Intentional versus accidental differences

| Difference | Classification | Evidence / follow-up |
| --- | --- | --- |
| HTML targets receive portable HTML while DEV/Hashnode receive portable Markdown; Medium is manual-only. | Intentional destination policy. | Request builders use the declared representation, and the dry run prints the format and canonical limitation. |
| Native `post.text` and `llms-full.txt` omit fenced code and link targets. | Existing native text policy. | JSON Feed `content_text` instead comes from the portable Markdown projection and includes code and link destinations. |
| Relative Markdown destinations are resolved against canonical context. | Shared portable projection policy. | Portable Markdown resolves authored links before provider payload construction. |
| Sidecar bylines and cover metadata are absent from provider payload fields. | Accidental metadata gap unless a destination cannot represent them. | They are present in the domain model and some feed/page metadata, but the current `SyndicationPost` and payload builders do not carry them. |
| WordPress does not receive an external canonical field; Medium behavior is unverified. | Explicit provider limitation / manual boundary. | WordPress adapter warning and Medium manual-only instruction document the limits. |
| Full-content feeds use static fallbacks rather than native `<ob-…>` tags. | Explicit portable consumer migration. | Shared fixtures assert portable semantics and absence of native components in RSS and JSON Feed. |

## Fixture and regression coverage

`crates/openblog-core/tests/portability_contract.rs` drives each public fixture through
`post.html`, the native rendered page, RSS `content:encoded`, JSON Feed `content_html`,
`post.text`, and `llms-full.txt`. It keeps each fixture's expected semantics and text-loss
notes next to the canonical source in the shared JSON corpus.

`crates/openblog-cli/src/syndication.rs` runs those same public source fixtures through the
DEV, Hashnode, Ghost, WordPress, and Medium request/instruction builders and checks that
each payload uses its declared Markdown or HTML representation. These are request-shape
tests only; they do not contact providers or claim remote-rendering parity.

The fixture corpus covers Unicode, duplicate heading anchors, relative links, image alt
text, references, explicit and legacy authorship, recipes, callouts, media, quizzes,
runnable code, unknown syntax, and draft exclusion. It does not claim provider-side
equivalence.
