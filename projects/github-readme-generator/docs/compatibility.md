# GitHub Compatibility Lab

Open **Health → GitHub Compatibility** for a dedicated, keyboard-accessible review. Filter findings by Likely supported, Needs review, Likely stripped, or Unsafe. Each finding explains what was found, what may happen, why it matters, a safe alternative, and its source location. Source buttons close the dialog and focus the editor without changing Markdown. Approximate locations are labeled.

This is guidance, not exact GitHub parity. Compatibility depends on GitHub's rendering and sanitization pipeline. The Studio preview remains independently sanitized, and source export remains untouched. Analysis runs locally in the existing worker and makes no network requests.

## What is checked

The data-driven registry covers common semantic HTML, headings, images, picture/source, details/summary, tables, containers, executable elements, CSS and interactive/media tags. Additional structural checks explain missing picture fallback images, simple theme-media syntax, absent summaries, unclosed/nested wrappers, table widths/spans, and many columns. Complex media queries receive review guidance rather than a claim that they are invalid.

URL guidance distinguishes repository-relative paths, raw GitHub assets, GitHub blob-page image URLs, browser-session blob URLs, data URLs and executable schemes. Encoded HTML URL schemes are decoded for diagnostics. Studio's URL security boundary can reject a URL regardless of whether GitHub might render a related pattern. Table/mobile and alt-text guidance are labeled Layout and Accessibility rather than called security failures.

An empty alt can be intentional for decorative images. A nested details element can be valid but difficult to navigate. Findings are advisory and should be interpreted in context. Code examples, escaped tags and comments are excluded. The HTML inventory is conservative rather than a complete HTML validator. At most 1,000 findings are retained; the dialog renders 100 at a time with Show more.

## Evidence and fixture verification

Documentation reviewed on 2026-09-27:

- GitHub's [markup pipeline](https://github.com/github/markup) describes sanitization of scripts, styles and presentation attributes.
- GitHub's [formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) documents images, relative paths and picture support.
- GitHub's [collapsed sections guide](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections) documents details/summary.

`tests/fixtures/compatibility/github-patterns.md` contains picture, details, tables, badges, HTML headings, centered paragraphs and unsupported tags. These fixtures are verified by local analyzer and browser tests. **Manual GitHub rendering verification: not performed.** There is no fabricated manual verification date. To verify a future change, render the fixture in a test repository on GitHub, compare light/dark and narrow layouts, and record the date, URL and observed differences here.

Run `npm test -- tests/compatibility-lab.test.js` and the analyzer browser suite. None of these tests claim that the local sanitizer is identical to GitHub's.
