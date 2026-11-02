# ADR 0263: The owner surfaces take no HTML or CSS, Markdown mode keeps its raw HTML and flags it, and every landing, look and piece route is bounded and denied by default

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#336](https://github.com/journey-to-code-org/open.blog/issues/336)
- Parent story: [#319](https://github.com/journey-to-code-org/open.blog/issues/319)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0248, ADR 0253, ADR 0257, ADR 0260, ADR 0261, ADR 0262

## Context

The landing builder, the Customize look screen, pieces and the rich Text section were each built to take
no markup. Before they ship the whole Admin is audited: is there any remaining way for an owner, or something
an owner pastes, to put HTML or CSS onto a page, and is every new route safe? The epic leaves one question
open: should Markdown mode also stop accepting new raw HTML?

## The trust boundary

- **The landing page and the look are data, never markup.** The landing renderer reads typed sections and
  Markdown with raw HTML disabled; markup in any field is escaped text on the page (tested for every section
  type) and appears only on the home page, never in a feed, the search index, the sitemap or any other
  generated file (tested over the whole build). The look is a closed set of choices and one strict hex color,
  compiled only to allowlisted tokens; no CSS text exists in the Admin, the request or the file.
- **No Admin form has an HTML or CSS field.** `tests/web/admin-input-scan.test.mjs` fails if a landing field is
  not a typed control, if any control is named or labelled for HTML, CSS, style, markup or script (the one
  reviewed exception is the code-runner source of a post's interactive block), or if any module adds a new way
  to write HTML into the document. The only two reviewed sinks are the sandboxed preview frame, which takes the
  server's own page, and `insertHTML` of elements the editor's block renderer built from validated Markdown.
- **Visual surfaces cannot create markup.** Pasting is converted through an allowlist (ADR 0260) and typed
  text that looks like a tag is saved as plain words (ADR 0261). This closed the one path the audit found:
  typing `<b>` in a post's Visual mode used to be written as raw HTML.

## Decision: Markdown mode keeps its raw HTML, and flags it

Markdown mode is the owner's own source for a post, and posts have always accepted raw HTML (an embedded
frame, a `<details>` block). Stopping it now would break existing posts and the documented behavior (the
epic says existing behavior is unchanged), and would be a one-way door for anyone who relies on it. So:

- Existing posts with raw HTML keep rendering and keep their bytes. Nothing rewrites them.
- Markdown mode still accepts raw HTML. The suggestions panel (ADR 0262) notes a tag in plain words ("kept and
  shown as written, but the Visual editor cannot change it"). It never blocks saving.
- The Visual editor shows raw HTML as a preserved block and never edits it. Visual mode, the landing page,
  pieces, looks and paste cannot create it.
- Reversible later: a per-site setting that refuses new raw HTML would be additive and default to today's
  behavior. It is not built here.

## Route audit

Every landing, look, piece and history route sits behind the session, and every write behind the CSRF token
and a same-origin check, with the body required to be JSON; other verbs and names are 404 or 405 (deny by
default). The Admin has one role, so "role checks under the existing role policy" is: any signed-in owner may
change the page. Bodies are bounded before they are read: 512 KiB for a landing request (a page is at most
256 KiB), 4 KiB for a look, 64 KiB and 64 values for a piece. Unknown section types, malformed or deeply nested
JSON, non-UTF-8 bodies and oversize bodies fail without a write. Refusals do not repeat what was sent: a bad
section id and a bad look value are named, not echoed (this change), and a piece's problems name fields, not
text. A field this release does not know, on a section or in a look, is kept in the file for a newer release
(ADR 0245, ADR 0248) and is never drawn or compiled; tests prove no generated file or stylesheet holds one.
`safety_audit.rs` is the authorization and bounds matrix.

## Consequences

- Adding a route to the audit table, or a free-text control for markup, is a test failure that explains why.
- Owners who rely on raw HTML in Markdown mode are not affected.
