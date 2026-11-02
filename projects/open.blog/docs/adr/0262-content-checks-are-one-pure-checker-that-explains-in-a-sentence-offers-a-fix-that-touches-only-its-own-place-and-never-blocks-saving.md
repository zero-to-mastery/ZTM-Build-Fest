# ADR 0262: Content checks are one pure checker that explains in a sentence, offers a fix that touches only its own place, and never blocks saving

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#335](https://github.com/journey-to-code-org/open.blog/issues/335)
- Parent story: [#319](https://github.com/journey-to-code-org/open.blog/issues/319)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0257, ADR 0260

## Context

Owners publish without a reviewer. Pictures with no description, links that say "click here", skipped heading
levels and similar slips are easy to make and easy to fix, but only if someone says so in plain words.

## Decision

- **One pure checker, `web/admin/checks.js`.** `checkMarkdown(markdown, options)` reads Markdown and returns
  issues, each with a rule, one plain sentence, the place it is about, and where a fix is safe a fix. The
  rules: a picture with no description, a link that says "click here", "here" or "read more", an empty link or
  a link with no address, a heading that skips a level, a very long paragraph (over 150 words), a heading or
  paragraph in all capitals, and an `http://` address (local addresses are left alone). In a post the checker
  also notes an HTML tag (ADR 0263). Code, fenced or inline, is never checked. Malformed, empty or oversized input
  returns an empty list or a bounded one (40 issues, 400,000 characters) and never throws.
- **A fix changes only its own place.** A fix is the exact range to replace, the text expected there, and the
  words just around it. `applyFix` changes nothing if the text has moved, so a fix can never land on unrelated
  content. Fixes: upgrade `http` to `https`; move a skipped heading to the next level; and for a missing picture
  description, an empty link or a vague link label, ask for words in a small form under the sentence (Enter
  applies, Escape cancels) and write them with Markdown characters and angle brackets removed. Long
  paragraphs, shouting and a missing address have no fix because any automatic change would rewrite the
  owner's words.
- **A list in a disclosure, announced politely.** `web/admin/checks-panel.js` shows a "N suggestions" disclosure
  with a list of sentences and real "Fix it" buttons (44px tall, wrapping, no layout that depends on a font),
  and a polite status region that speaks the count only when it changes or after a fix. It sits under the
  landing Text section and under the post editor's toolbar, and uses the same checker in both.
- **Warnings never block saving.** The panel knows nothing about saving. The one hard rule that already stops a
  save is unchanged: the landing Text section refuses a picture with no description (ADR 0257).

## Considered options

- **Block saving on every warning.** Rejected: the issue says warnings never block except hard limits.
- **Fix "all caps" by rewriting to sentence case.** Rejected: proper nouns and acronyms make it unsafe.

## Consequences

- The same sentences appear in both editors, and tests cover each rule with fixtures and a Fix it browser flow.
