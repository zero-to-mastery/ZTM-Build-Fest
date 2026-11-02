# Accessibility checks and manual review

open.blog helps authors find selected accessibility concerns in canonical Markdown, front
matter, and site configuration. The same Rust audit powers `openblog check`, build output,
and the admin preview, so a finding keeps the same code and meaning in every workflow.

Accessibility Studio finds selected source issues and guides manual review. It does not
test every accessibility requirement or certify WCAG conformance. Verify the rendered site
with keyboard and assistive-technology testing and, when conformance matters, a qualified
accessibility review.

## Author workflow

In the browser editor, open **Accessibility** or press `Alt+7`. The studio audits the current
unsaved document through the production preview endpoint. It shows site-wide findings and
findings for that document only; guidance from unrelated posts, pages, or series is excluded.

For a repository-wide review, run:

```sh
openblog check
```

A build reports the same findings for the content included in that build. A normal
`openblog build` excludes drafts and scheduled posts, while `openblog build --drafts`
includes them; `openblog check` includes unpublished content by default. Each CLI line
includes the outcome, canonical file and line/column or configuration field, message,
repair instruction, and stable code. These findings remain separate from publishing and
SEO warnings.

## What the outcomes mean

| Outcome | Meaning | Author response |
| --- | --- | --- |
| **Detected** | The engine established a specific source condition, such as a text link with no accessible name or a missing default site language. | Fix the named source or configuration field. |
| **Potential** | A bounded heuristic found something that may be a problem, such as placeholder-like image text, a heading jump, or generic link wording. | Review it in context and revise when the guidance applies. |
| **Needs review** | The engine found content whose purpose or rendered behavior requires human judgment, such as an empty image alternative, table, media item, embed, or raw HTML. | Follow the repair guidance and inspect the rendered page. |

“No issues detected by the checks that ran” means only that these checks produced no
finding. It does not mean the page is accessible, passed, certified, or WCAG conformant.
There is intentionally no accessibility percentage score.

## Source checks

| Code | What it locates |
| --- | --- |
| `link-name-empty` | A text link with no accessible name. |
| `document-language-missing` | An empty site `language` setting. This is reported once at site scope. |
| `image-alt-review` | An empty cover or Markdown image alternative that may be correct only when the image is decorative. |
| `image-alt-placeholder` | Alternative text that resembles a filename or common placeholder. |
| `heading-level-skip` | A potential jump in the heading outline, including the generated page title. |
| `link-purpose-review` | Generic link wording whose purpose may depend on context. |
| `table-structure-review` | A document containing one or more tables whose header relationships need review. |
| `media-alternatives-review` | Linked audio or video that may need captions, a transcript, or description. |
| `embed-accessibility-review` | A link the production renderer turns into an embed. |
| `raw-html-review` | A document containing raw HTML. One bounded task is emitted rather than pretending to validate arbitrary HTML. |

Repeated tables, media, embeds, or raw HTML may be collapsed into one document-level task
where repeating the same guidance would add noise. Alternative text is never generated
automatically because its correct wording depends on the image's purpose in context.

## Review the rendered site

Source checks cannot establish whether a selected theme or interactive component works for
every reader. Preview the real theme at wide, tablet, and mobile widths, then check at least:

- text and non-text color contrast;
- visible focus indicators;
- keyboard order and operation without a pointer;
- browser zoom, text resizing, and narrow-screen reflow;
- reduced-motion behavior;
- pointer and touch target size;
- responsive layouts and content that must not be clipped;
- third-party embed keyboard behavior, labels, and fallbacks;
- image purpose and contextual alternative text, including longer explanations for charts;
- heading meaning, link purpose, table headers, captions/transcripts, descriptions, and
  language changes in the content.

Use a screen reader and other assistive technology relevant to the audience when possible.
The first Accessibility Studio release does not automate or persist this review, does not
rewrite front matter, and does not treat dismissing a finding as proof that it is resolved.

The product boundary and supporting standards research are recorded in
[ADR 0001](adr/0001-accessibility-studio-boundary.md) and the
[Accessibility Studio research note](research/accessibility-studio.md).
