# Content-capability portability matrix

- Status: current consumer map for the Portable Content & Universal Publishing epic
- Date: 2026-10-24
- Issue: [#107](https://github.com/journey-to-code-org/open.blog/issues/107) (Task P2.1)
- Parent story: [#94](https://github.com/journey-to-code-org/open.blog/issues/94) · Parent epic: [#92](https://github.com/journey-to-code-org/open.blog/issues/92)
- Depends on completed contract work: [#105](https://github.com/journey-to-code-org/open.blog/issues/105) (`PortableProjection`) and
  [#106](https://github.com/journey-to-code-org/open.blog/issues/106) (portability-contract fixtures)

## Current publication projections

One author-owned Markdown document is projected through the shared
[`PortableProjection`](../../crates/openblog-core/src/portability.rs). `representation(Html)`
continues to expose the legacy native body for backward compatibility; portable HTML and Markdown
are separate derived outputs and never become editable source files.

| Surface | Projection and policy |
| --- | --- |
| Native pages | Existing production renderer and runtime remain unchanged. |
| Portable HTML | Static HTML from authored Markdown with safe raw-HTML handling, accessible capability fallbacks, canonical interaction links, public attribution, resolved URLs, and bounded output. |
| Portable Markdown | CommonMark-oriented text with static quiz/code/web-sandbox/callout transformations, title and canonical identity, public credits and provenance, and explicit raw-HTML/canonical-only notes. `openblog export` is dry-run-first. |
| RSS / JSON Feed | Full-content RSS `content:encoded` and JSON Feed `content_html` use portable HTML. JSON Feed also emits `content_text` from portable Markdown. Feed metadata remains distinct from provider payloads. |
| Admin Studio | Authenticated unsaved previews offer native site, portable HTML, portable Markdown, and destination-policy views; source-scoped diagnostics accompany the portable output. |
| Syndication | DEV and Hashnode use portable Markdown; Ghost and WordPress use portable HTML; Medium is manual import. The dry run reports the representation, canonical behavior, and portability diagnostics. |
| Other/unknown capabilities | Preserve authored Markdown where possible, label canonical-only behavior, and report loss. Private-only state produces no public diagnostic or output. |

Portability levels and capability ownership come from the
[ADR](../adr/0004-portable-projections-from-canonical-work.md),
[capability descriptors](../../crates/openblog-core/src/capability.rs), and
[planned-capability registry](./planned-capability-contracts.json). The rows below are the
original native-capability audit and remain useful for parser/native behavior; consumer behavior
is governed by the current projection table above.

## Destination conversion policies

Cross-posting provider policies are typed in the shared core and consumed by both Admin previews
and syndication dry runs. Feed rows describe destination-neutral generated contracts. Unknown
provider identifiers are rejected by configuration parsing; they do not inherit a permissive
destination policy.

| Destination | Representation | Canonical behavior | Workflow |
| --- | --- | --- | --- |
| DEV | Portable Markdown | Canonical URL is sent | Remote draft by default; public publishing requires explicit CLI approval |
| Hashnode | Portable Markdown | Canonical URL is sent | Draft create/update only; public-publish requests are rejected |
| Ghost | Portable HTML | Sent as Ghost canonical URL | Remote draft by default; public publishing requires explicit CLI approval |
| WordPress | Portable HTML | WordPress core cannot set an external canonical URL | Remote draft by default; verify an SEO plugin before public publishing |
| Medium | Portable Markdown | Verify canonical URL during import | Manual import only; no remote write |
| RSS | Portable HTML | Entry link and feed item URL identify the canonical post | Generated feed; no provider API |
| JSON Feed | Portable HTML plus portable text | Item URL identifies the canonical post | Generated feed; no provider API |

Warnings include source path, capability, observed transformation, and a recommended review or
repair action. Warnings do not attest to correctness, accessibility, or provider-side rendering.
An Admin acknowledgement is kept in the post's tracked `.portability.json` sidecar and bound to
the portable source revision, capability, representation, and destination. It records review but
does not suppress the warning or override a projection error; older revisions stay visibly stale.

## Interactive fallback and state policy

Portable artifacts use semantic HTML/CommonMark only; they do not depend on open.blog JavaScript,
live provider endpoints, reader submissions, or owner snippets. Content below refers to authored,
public meaning. Attempts, moderation state, credentials, and private annotations are ephemeral or
private and never enter a public projection.

| Capability | Authored/public meaning retained | Portable behavior and order | Interaction loss / private state |
| --- | --- | --- | --- |
| Knowledge check | Prompt, choices, designated answer, and explanation | Static question, ordered choices, then answer and explanation; Markdown labels the answer explicitly | Scoring, retries, and remembered attempts are unavailable |
| Runnable code | Caption/title and complete source | Caption, source code block, optional prefilled Rust Playground link, then canonical run/edit link. `playgroundLink=false` or an encoded URL over 8 KiB omits only the external link | In-copy editing and execution are unavailable; eligible Rust examples can be opened externally |
| Web sandbox | HTML, CSS, and JavaScript source sections | Each source section is a separately labeled code block; canonical link follows | Live preview and execution are unavailable |
| Interactive demo | Title, the authored fallback description (plain Markdown), and the kind's name | Caption, the description, then a labeled canonical link ("Try the interactive Git sandbox on the original article"); an empty body uses the kind's own summary. Raw HTML, images and non-https links in the body are rejected at build time | The live demonstration and anything done in it are unavailable |
| Discussion/comments | Canonical article identity and discussion link | A labeled canonical link after article content | Submissions, reader identity, moderation queues, and hosted endpoint details are not exported |
| Planned public interactions | Existing authored prose and its position | Labeled canonical link after the preserved authored content; planned behavior is not claimed as implemented | Future interactions remain canonical-only until an owning story defines semantics |
| Private annotations/reflection drafts | None; private state has no public authored representation | No content, diagnostic, or link is emitted | All private reader state remains private |
| Raw HTML | Text and elements accepted by the portable allowlist | Safe elements are preserved where possible; unsupported content is removed or escaped and diagnosed | Scripts, forms, frames, embeds, and active behavior are not carried through |
| Video chapters | Timestamp, chapter label, and source video identity | Ordered timestamp list with links to the corresponding video position when available | Player state is unavailable |
| Recipe | Public recipe facts, sections, lists, and author notes | Static facts followed by labeled ingredients/instructions sections | Interactive scaling and local state are not portable |

The portable representations are readable without JavaScript. Any warning associated with a
transformation includes a recommended review action; no warning can authorize exporting private
state or suppress an unsafe-markup failure.

Discussion links target the generated `#ob-discussion` region only when that region is enabled
on the native article. Hidden discussions and sites without a backend expose no participation
link. Approved public contributions are not currently imported into exports: any future opt-in
must use the owning moderation/publication story's exact approved public projection, attribution
and privacy review. Pending/rejected material, deleted passages and author-only responses are
never fetched by an exporter. Article prose alone cannot opt private state into publication.

## Native capability audit (baseline)

This table records the source audit completed before the consumer rollout. Its native-renderer
descriptions remain useful; feed, Admin-preview, and syndication cells are historical baseline
observations and are superseded by the current projection policy above.

| Capability | Status | Owner (code) | Native HTML | No-JavaScript behavior | Feeds (RSS/JSON Feed) | Admin preview | Syndication | Citations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Articles | Implemented | Markdown→HTML pipeline | Full CommonMark+GFM rendering; raw HTML passed through | Static HTML; no runtime dependency | Native HTML embedded when `feeds.full_content`, with root-relative `src`/`href` URLs absolutized | Same renderer, so authored post HTML is byte-identical | Markdown or rendered HTML per target | `crates/openblog-core/src/markdown.rs:1-75`; `crates/openblog-core/src/feeds.rs:396-397`; `docs/content.md:194-199` |
| Research/citations | Implemented (bounded) | `crates/openblog-core/src/research.rs` | `## Abstract`/`## References` sections stay ordinary Markdown; DOI/license meta line inserted (`render.rs:1328-1346`) | Fully readable; DOI/license line is plain text/links | `ResearchMetadata` is part of `post.html`, so included like any article content | Evidence view surfaces the same `EvidenceFinding`s (`docs/research-profile.md`) | Opt-in `[@key]` citations (`citations: notes` or `bibliography`) are rewritten once into generated footnotes in the publication Markdown, so every destination receives ordinary footnotes (`crates/openblog-core/src/bibliography.rs`, ADR 0048); everything else passes through with the rest of the HTML/Markdown | `crates/openblog-core/src/research.rs:14-109,297-360`; `crates/openblog-core/src/render.rs:1247-1261` |
| Claim evidence | Implemented (opt-in, `claimEvidence.publish`) | `crates/openblog-core/src/claim_publication.rs` | Approved claims become a "Claims and evidence" section of the publication Markdown: headings per claim and per relation, lists of references, locations, rationale, confidence and uncertainty (ADR 0075) | Fully readable static HTML; supporting and contradicting evidence side by side, contested claims marked in text | Same publication Markdown, so feeds carry the same section | Previews show the section for the previewed post | Portable HTML, Markdown and text must carry every claim heading, contested marker and relation heading in order, or the copy is refused (`claim-evidence-lost`) | Reuses the citation reference allowlist (`PublicReference`) for the sources links cite |
| Credits/bylines | Implemented | `crates/openblog-core/src/contributor.rs` | Ordered `<aside class="ob-contributions">` list with roles and unauthenticated-ORCID disclosure; legacy posts fall back to `<a class="p-author h-card">` | Fully static text/links, no script | RSS `<dc:creator>` / JSON Feed `authors[]` ordered by explicit credit (`feeds.rs:54-66,144-163`); legacy uses site author | Same renderer | Explicit authors carried in Markdown/HTML sent to targets (no structured transform) | `crates/openblog-core/src/render.rs:2057-2122`; `crates/openblog-core/src/feeds.rs:54-66,144-163`; closed issues [#9](https://github.com/journey-to-code-org/open.blog/issues/9)/[#10](https://github.com/journey-to-code-org/open.blog/issues/10) |
| Recipes | Implemented | `crates/openblog-core/src/recipe.rs` + `markdown.rs` block transform | `Ingredients`/`Steps` sections wrapped as `ob-recipe-part` with schema.org `Recipe` JSON-LD | Ingredients/steps remain a plain list; "cook mode" and "print recipe" are progressive-enhancement extras | Included as ordinary HTML | Same renderer; preview shows summary card | Rendered HTML/Markdown passed through unchanged | `crates/openblog-core/src/recipe.rs:1-80`; `tests/fixtures/portability-contract.json:58-90` (`recipe-callout-media` fixture); `docs/content.md:394-481` |
| Callouts | Implemented | `markdown.rs::callout_label` + block transform | `<aside class="ob-callout ob-callout-<kind>" role="note">` with a `<p class="ob-callout-title">` | Fully static; no JS involved at all | Included verbatim in `post.html` | Same renderer | Passed through as part of HTML/Markdown | `crates/openblog-core/src/markdown.rs:182-189,1340-1349` (test `github_style_callouts`); `tests/fixtures/portability-contract.json:63-90` |
| Quizzes (knowledge checks) | Implemented; gracefully transformed | `markdown.rs::parse_quiz`/`render_quiz`; `capability.rs` | `<ob-quiz>` with visible `<fieldset>`, radio inputs (`data-correct` marks the answer in source), and a `hidden` feedback/explanation paragraph | Choices are visible and selectable as plain radio inputs; feedback and retry button stay `hidden` without JS (no scored interaction) | Quiz markup is embedded in full-content feeds as-is (no simplified text fallback yet) | Same renderer; Admin also offers a form-based "Add knowledge check" authoring UI (`docs/content.md:212-235`) | Passed through as raw HTML/Markdown with the quiz markup intact | `crates/openblog-core/src/markdown.rs:252-360`; `crates/openblog-core/src/capability.rs:63-69`; fixture `knowledge-check` in `tests/fixtures/portability-contract.json:91-116` records `level: "gracefully-transformed"`, fallback `static-question-and-choices`, and `semanticLoss`: "The current text view omits fenced quiz content" |
| Runnable code | Implemented; gracefully transformed | `markdown.rs` fence handling; `capability.rs` | `rust runnable` → `<ob-rust-playground>` wrapping `<pre><code>`; configured-language fences → `<ob-code-runner>` | Source code remains fully visible/readable/copyable in `<pre><code>`; only Run/Reset/output require JS (`docs/specs/executable-code-lessons.md`) | Embedded verbatim in full-content feeds | Same renderer | Markdown/HTML sent as-is; no remote execution occurs during syndication | `crates/openblog-core/src/markdown.rs:1290-1330` (tests); `crates/openblog-core/src/capability.rs:64-68`; fixture `runnable-and-web-sandbox`, `tests/fixtures/portability-contract.json:117-142` (`level: "gracefully-transformed"`, fallback `pre-code`) |
| Web sandboxes (HTML/CSS/JS) | Implemented; gracefully transformed | `markdown.rs::valid_web_sandbox_source`; `capability.rs` | `<ob-web-sandbox>` with the authored HTML/CSS/JS escaped into visible `<pre><code>` sections | Authored source stays readable as escaped text; the live, isolated iframe preview requires JS | Embedded verbatim | Same renderer | Markdown/HTML sent as-is | `crates/openblog-core/src/markdown.rs:165-179`; fixture `runnable-and-web-sandbox`, `tests/fixtures/portability-contract.json:117-142` (fallback `source-code`); `docs/specs/interactive-web-video-comments.md` |
| Interactive demos (`demo` fence) | Implemented; gracefully transformed | `markdown.rs::render_demo`/`DEMO_KINDS`; `capability.rs` | `<figure class="ob-demo">` around the demo element (`ob-git-sandbox`, `ob-practice-lab`, `ob-fetch-lab`, `ob-component-lab`, `ob-evolution-lab`, `ob-audio-lab`, `ob-native-lab`) whose children are the authored fallback | The authored fallback stays visible; the element replaces it when JavaScript runs | Caption, description, canonical link | Same renderer | Portable HTML or Markdown as above | `web/components/ob-lab.js`; `docs/content.md` |
| Before and after (`compare` fence) | Implemented; fully portable | `compare.rs`; `markdown.rs::transform_blocks`; `capability.rs` | `<ob-compare class="ob-compare">` around two `<figure class="ob-compare-pane">` each holding `<img>` and a labelled `<figcaption>` | Both pictures and captions are side by side; the element adds the reveal control when JavaScript runs and motion is welcome | Two figures, no wrapper | Same renderer | Portable HTML is the two figures; portable Markdown is two images with italic captions | `docs/content.md`; ADR 0291 |
| Video/audio | Partial (video implemented; no dedicated audio capability) | `crates/openblog-core/src/video.rs`; `crates/openblog-core/src/embed.rs` | YouTube URLs become `<youtube-nocookie.com>` iframes via `embed::detect`/`VideoMetadata::embed_url`, plus a visible fallback link; `VideoObject` JSON-LD when fields are present | Fallback `<a>` link to YouTube is always present; raw `<audio>`/`<iframe>` authored directly in Markdown passes through unprocessed (CommonMark raw-HTML passthrough) since there is no dedicated audio capability | Included as part of `post.html` | Same renderer; Admin's Release kit (JS-only) composes a YouTube description, it does not change the published page | Passed through as-is | `crates/openblog-core/src/video.rs:1-85`; `crates/openblog-core/src/embed.rs:36-70`; `docs/content.md:194-197` (raw HTML passthrough); `docs/video-production.md:30-46` |
| Timestamps (video chapters) | Implemented (as plain Markdown + Admin-only validation) | `web/admin/admin.js::buildVideoReleaseKit` | Chapters are "ordinary timestamp lines" the author writes directly in Markdown body text (`docs/video-production.md:52-66`); no Rust parser or dedicated renderer owns them | Fully static plain text — no JS dependency for reading | Timestamp text is ordinary body text, carried through feeds like any other paragraph | Admin's Release kit (`Alt+4`) parses/validates chapters (first at `00:00`, ≥3 chapters, chronological order, ≥10s each) purely client-side in JS and composes a YouTube release description; it does not alter the published post | No special handling; plain text travels with the rest of the Markdown/HTML | `web/admin/admin.js:632-692`; `docs/video-production.md:48-66` |
| Shared Perspectives | Planned (not implemented) | — | — | — | — | — | — | Epic [#143](https://github.com/journey-to-code-org/open.blog/issues/143) "Shared Perspectives — Collaborative, Source-Led Publishing"; no child story (`#144`–`#152`) has shipped code in this repository. Grep for "shared perspective" across `crates/` and `web/` returns no implementation matches |
| Questions/discussions | Partial (generic comments implemented; passage-specific Q&A/corrections planned) | `crates/openblog-core/src/model.rs::CommentsPolicy`; `render.rs`; `netlify/functions/engagement.mjs` | Per-post `<ob-comments>` element with `mode="locked"` when configured; omitted entirely when `comments: hidden` | `<ob-comments path="..." endpoint="..."><p>Comments require JavaScript.</p></ob-comments>` — explicit no-JS fallback text | Comments are not embedded in feeds (separate hosted endpoint only) | Admin exposes moderation queues for the same hosted comments (`docs/specs/hosted-engagement.md`) | Not syndicated; comments remain on the canonical page | `crates/openblog-core/src/render.rs:1145-1161`; `docs/specs/hosted-engagement.md`; planned passage-specific questions/corrections: issue [#29](https://github.com/journey-to-code-org/open.blog/issues/29) "Ask passage-specific questions and submit evidence-based corrections" and the "Third Perspective" workstream `#201`–`#207` referenced in epic [#16](https://github.com/journey-to-code-org/open.blog/issues/16) — neither has shipped code |
| Reflections | Planned (not implemented) | — | — | — | — | — | — | Child stories [#144](https://github.com/journey-to-code-org/open.blog/issues/144) "Create a shared reflection from source material" and [#146](https://github.com/journey-to-code-org/open.blog/issues/146) "Write independently with protected drafts" under epic #143; no implementation found in `crates/` or `web/` |
| Source previews | Planned (not implemented) | — | — | — | — | — | — | Issue [#25](https://github.com/journey-to-code-org/open.blog/issues/25) "Explore interactive citations and source previews" under epic [#16](https://github.com/journey-to-code-org/open.blog/issues/16); no implementation found. (Today's research references are plain Markdown links with no preview affordance — `crates/openblog-core/src/research.rs:86-93`.) |
| Guided explanations (reading modes) | Implemented: supplements and their static groups (ADRs 0140-0142); controls (#69) | `crates/openblog-core/src/reading_depth.rs`; `capability.rs` (`guided-reading-supplements`) | `<div class="ob-supplement" role="group">` with a `<p class="ob-supplement-label">`, the author's quote and a visible `<p class="ob-supplement-end">` end marker; `<ob-reading-modes>` wraps the article when the post has supplements | Every supplement is written out visible, labelled and in order; no control appears and nothing is hidden | Same groups in full-content feeds; the text copy carries `Definition supplement (guided): Aporia.` ... `End of definition supplement.` lines | Same renderer; the build, `check` and Admin warnings list each marker that could not be read | Portable HTML keeps the groups; portable Markdown keeps the quote and its marker as written (fully portable, no canonical link needed) | `docs/specs/reading-modes.md`; `crates/openblog-core/tests/reading_depth.rs`; `tests/browser/reading-modes.spec.mjs` |
| Knowledge relationships | Planned (not implemented) | — | — | — | — | — | — | Issues [#21](https://github.com/journey-to-code-org/open.blog/issues/21) "Build a contextual Knowledge Atlas" (epic #15) and [#27](https://github.com/journey-to-code-org/open.blog/issues/27) "Explore concepts and intellectual relationships" (epic #16); no implementation found |
| Translation comparisons | Planned (not implemented) | — | — | — | — | — | — | Issues [#22](https://github.com/journey-to-code-org/open.blog/issues/22) "Compare editions, translations, and interpretations" (epic #15) and [#31](https://github.com/journey-to-code-org/open.blog/issues/31) "Compare scholarly interpretations and audience-aware explanations" (epic #16); no implementation found |
| Timelines | Planned (not implemented) | — | — | — | — | — | — | Issue [#23](https://github.com/journey-to-code-org/open.blog/issues/23) "Explore historical chronology and intellectual relationships" under epic #15; no implementation found |
| Diagrams | Planned, not yet scoped by any issue | — | — | — | — | — | — | No issue, ADR, research note, or source file in this repository defines diagram authoring or rendering. Searched `crates/`, `web/`, and `docs/` for "mermaid" and "diagram" — no matches other than this document. Raw HTML/image passthrough (`docs/content.md:194-197`) lets an author embed a pre-rendered diagram image today, but there is no dedicated diagram capability, syntax, or descriptor |

## Notes on scope and gaps

- The portability gates for planned research/reader capabilities live in the
  [planned-capability registry](./planned-capability-contracts.md) and its
  [machine-checked contract data](./planned-capability-contracts.json); planned work must use its
  existing story and unique contract owner rather than adding parallel exporters.
- **"Shared Perspectives", "Questions/discussions" (passage-specific), "Reflections", "Source
  previews", "Guided explanations", "Knowledge relationships", "Translation comparisons",
  "Timelines", and "Diagrams"** are drawn directly from the epic roadmap
  (`crates/openblog-core` has no matching modules); treating any of them as shipped would misrepresent
  the backlog recorded in issues #15, #16, and #143. Generic post comments (implemented) are a
  distinct, narrower capability from the planned passage-specific questions/corrections workstream.
- The capability matrix distinguishes shipped native features from planned features. A planned
  interaction remains ordinary authored content plus a canonical link until its owning story
  supplies a semantic fallback; private-only reader or collaboration state never appears in public
  output or diagnostics.
- Portable diagnostics are source-scoped and severity-aware. A warning describes a conversion
  boundary; it does not certify truth, accessibility, or equivalent behavior on a third-party
  destination.
