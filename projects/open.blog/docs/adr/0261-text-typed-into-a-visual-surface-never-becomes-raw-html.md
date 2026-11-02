# ADR 0261: Text typed into a Visual surface never becomes raw HTML

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#336](https://github.com/journey-to-code-org/open.blog/issues/336)
- Parent story: [#319](https://github.com/journey-to-code-org/open.blog/issues/319)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0257, ADR 0260

## Context

The Visual editor's serializer wrote typed words as Markdown without touching `<`. Typing `<b>x</b>` in Visual
mode therefore saved raw HTML into a post, a path the audit of every Admin input (#336) found. The decision
about Markdown mode itself is ADR 0263.

## Decision

The serializer writes a `<` that could open a tag (`<` followed by a letter, `/`, `!` or `?`) as `&lt;`, and the
surface reads it back as `<`, so what the owner sees and types is unchanged and the saved Markdown holds no
markup. This is the same rule the paste converter uses (ADR 0260). It applies to text typed or pasted in a
Visual surface only; a block already in a post as raw HTML is a preserved card that is written back byte for
byte, so existing posts keep rendering and keep their bytes.

## Consequences

- Visual mode (posts and the landing Text section) cannot create markup, by typing or by pasting.
- Text with a literal `&lt;` followed by a letter reads back as `<`; the page shows the same character either way.
