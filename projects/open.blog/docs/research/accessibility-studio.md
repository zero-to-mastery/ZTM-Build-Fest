# Accessibility Studio research

Research date: 2026-10-23

## Summary

Accessibility Studio should be an authoring assistant, not a WCAG certification tool. Its
first release should combine deterministic checks over canonical front matter and the
Markdown syntax tree with a short, contextual manual-review workflow. The product should
describe each result as a detected issue, a potential issue, or a review task; it should
never turn an empty finding list into a conformance claim.

This split follows W3C guidance. ATAG asks authoring tools to integrate accessibility
checking, explain decisions that require an author, locate the relevant content, report
status, and offer repair guidance. It explicitly permits manual checking as the minimum
form of assistance ([ATAG 2.0, B.3.1 and B.3.2](https://www.w3.org/TR/ATAG20/#part_b_improve_accessible)).
W3C also states that evaluation tools cannot determine accessibility on their own and can
produce false or misleading results
([Selecting Web Accessibility Evaluation Tools](https://www.w3.org/WAI/test-evaluate/tools/selecting/#what-evaluation-tools-can-do-and-can-not-do)).

## Verified findings

- WCAG 2.2 is the current W3C Recommendation, and W3C advises using it for new or updated
  accessibility work ([WCAG 2.2 status](https://www.w3.org/TR/WCAG22/#status-of-this-document)).
- Text alternatives depend on an image's purpose and context. A missing `alt` attribute is
  mechanically detectable, but an empty alternative can be correct for decoration and the
  quality of non-empty text requires human judgment
  ([WAI Easy Checks: image text alternatives](https://www.w3.org/WAI/test-evaluate/preliminary/#images)).
- A meaningful heading hierarchy is valuable, but WAI describes starting with H1 and not
  skipping levels as strongly suggested rather than an absolute requirement. Whether text
  is truly a heading and whether a heading is meaningful require comparison with the
  content and presentation
  ([WAI Easy Checks: headings](https://www.w3.org/WAI/test-evaluate/preliminary/#headings)).
- WCAG 2.2 requires link purpose to be understandable from the link text or its
  programmatically determined context. A phrase such as "read more" is therefore a useful
  review signal, not a certain failure without examining its context
  ([Understanding SC 2.4.4](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html)).
- A page needs a programmatically determinable default language
  ([Understanding SC 3.1.1](https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html)).
  The engine already emits the configured language on the root HTML element
  ([renderer](../../crates/openblog-core/src/render.rs)); the audit can reliably detect a
  missing configuration value, while deciding the actual language of prose is a review.
- Accessible data tables require programmatic relationships between header and data cells;
  complex tables can require explicit associations. A caption is useful in most situations,
  but is not universally required
  ([WAI Tables Tutorial](https://www.w3.org/WAI/tutorials/tables/),
  [Caption & Summary](https://www.w3.org/WAI/tutorials/tables/caption-summary/)).
- Prerecorded synchronized media needs captions unless it is a clearly labeled media
  alternative for text. Captions include meaningful non-speech audio, so the presence and
  adequacy of captions cannot be inferred from a media URL
  ([Understanding SC 1.2.2](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html)).
- Contrast depends on rendered foreground/background colors, text size, and presentation
  state, including specified exceptions
  ([Understanding SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)).
  It is therefore a rendered theme/browser concern rather than a Markdown-only check.
- ACT rules are intentionally partial. Passing a rule means that its particular failure was
  not detected, not that the whole WCAG success criterion is satisfied
  ([About ACT Rules](https://www.w3.org/WAI/standards-guidelines/act/rules/about/)).

## Recommended first-release scope

The following is an engineering recommendation, not a statement of WCAG conformance.

Run one audit in the core against parsed front matter and the Markdown syntax tree, and
return the same structured results to build/check and the admin preview. Keep the author in
context by linking every finding to a front-matter field or source range and pairing it with
a repair instruction, as encouraged by ATAG's locate-and-repair criteria
([ATAG 2.0, B.3.1.3 and B.3.2.1](https://www.w3.org/TR/ATAG20/#part_b_improve_accessible)).

### Deterministic or bounded source checks

| Check | Outcome | Important limit |
|---|---|---|
| Empty accessible name on a text link | Detected issue | Image-only links need their image alternative included in the name calculation. |
| Site language configuration absent | Detected issue | Language accuracy remains a manual decision. |
| Cover or Markdown image has empty alternative | Review task | Empty text is correct for a decorative image; do not call it a failure. |
| Alternative text resembles a filename or placeholder | Potential issue | A heuristic cannot judge equivalent purpose. |
| Heading level jumps | Potential issue | A skipped level is not automatically a WCAG failure. |
| Generic link phrase | Potential issue | Nearby programmatic context may make the purpose clear. |
| Table, raw HTML, iframe/embed, audio, or video is present | Review task | Source presence can be detected; semantic adequacy cannot. |

The initial release should not auto-generate alternative text. WAI says alternatives convey
purpose in context, so a filename-derived or image-caption guess can create false confidence
([WAI Easy Checks: image text alternatives](https://www.w3.org/WAI/test-evaluate/preliminary/#images)).

### Guided manual review

For only the content types found in the post, ask the author to confirm:

1. Each image is decorative or has equivalent, contextual alternative text; complex charts
   have a nearby longer explanation.
2. Headings describe their sections and the outline remains meaningful in the selected
   theme.
3. Each link's destination or action is understandable in context.
4. Data-table headers describe the correct rows/columns and complex tables remain
   understandable.
5. Audio/video has the needed captions, transcript, and description for information that is
   otherwise unavailable.
6. Language changes inside the post are identified when the publishing format supports it.

Keep theme and interaction checks separate and mark them as requiring rendered inspection:
text and non-text contrast, visible focus, keyboard operation and order, zoom/reflow,
reduced motion, touch target size, responsive layouts, and third-party embeds. A later
browser-audit release can assist with some of these, but still must not imply complete
conformance. W3C's conformance methodology requires defined scope, representative views,
expertise, evaluation, and reporting; it also recommends involving users with disabilities
([WCAG-EM overview](https://www.w3.org/WAI/test-evaluate/conformance/wcag-em/)).

## Stable finding contract

Use a product-owned taxonomy instead of encoding a WCAG version into identifiers. Standards
mappings can then evolve without breaking API consumers.

```json
{
  "code": "image-alt-review",
  "outcome": "needs-review",
  "impact": "serious",
  "scope": "content",
  "source": { "path": "posts/example.md", "line": 18, "field": null },
  "message": "Decide whether this image is decorative or needs alternative text.",
  "repair": "Describe its purpose in context, or leave the alternative empty when decorative.",
  "references": ["WCAG-2.2-1.1.1"]
}
```

Recommended closed vocabularies:

- `outcome`: `detected`, `potential`, `needs-review`.
- `impact`: `critical`, `serious`, `moderate`, `minor` (product triage, not legal severity).
- `scope`: `content`, `site`, `theme`, `embed`.
- `source`: stable file plus optional line/column range and front-matter field.

Never emit a universal `passed` result. At most, report “no issues detected by these checks”
and list which checks ran. W3C's ACT guidance makes the same distinction between not
detecting a particular failure and satisfying an entire success criterion
([About ACT Rules](https://www.w3.org/WAI/standards-guidelines/act/rules/about/)).

Suggested initial codes are `link-name-empty`, `document-language-missing`,
`image-alt-review`, `image-alt-placeholder`, `heading-level-skip`,
`link-purpose-review`, `table-structure-review`, `media-alternatives-review`,
`embed-accessibility-review`, and `raw-html-review`.

## Product wording boundary

Use this persistent disclosure near the status summary:

> Accessibility Studio finds selected source issues and guides manual review. It does not
> test every accessibility requirement or certify WCAG conformance. Verify the rendered
> site with keyboard and assistive-technology testing and, when conformance matters, a
> qualified accessibility review.

Status copy should say “3 detected issues, 4 items to review” and “No issues detected by
the checks that ran,” never “accessible,” “WCAG compliant,” “certified,” or a percentage
score. This wording reflects W3C's explicit warning that evaluation tools assist human
judgment but cannot determine accessibility
([Selecting Web Accessibility Evaluation Tools](https://www.w3.org/WAI/test-evaluate/tools/selecting/#what-evaluation-tools-can-do-and-can-not-do)).

## Open decisions

1. Whether content findings appear in a dedicated Accessibility pane or as a focused mode
   within the existing Optimize pane. The data contract should not depend on that UI choice.
2. Whether manual-review acknowledgements are ephemeral editor state or durable front
   matter. Persisting them would add authoring metadata and needs a separate decision.
3. Whether a later browser audit is bundled or delegated to an external tool. The first
   release should only reserve the `theme` and `embed` scopes.
4. Whether raw HTML is supported strongly enough to justify HTML-fragment checks in the
   first release; otherwise it should produce one bounded review task.
