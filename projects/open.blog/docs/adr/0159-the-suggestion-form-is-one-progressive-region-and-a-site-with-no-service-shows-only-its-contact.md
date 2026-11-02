# ADR 0159: The suggestion form is one progressive region, and a site with no service shows only its contact

- Status: Accepted
- Date: 2026-10-26
- Decision issue: [#227](https://github.com/journey-to-code-org/open.blog/issues/227)
- Parent story: [#204](https://github.com/journey-to-code-org/open.blog/issues/204)
- Parent epic: [#16](https://github.com/journey-to-code-org/open.blog/issues/16)
- Builds on: [ADR 0114](0114-the-third-perspective-form-is-one-progressive-region-with-explicit-consent.md), [ADR 0101](0101-one-registry-of-participation-kinds-enabled-per-site-and-post.md), [ADR 0156](0156-acceptance-means-editorial-interest-only-and-nothing-ranks-or-counts-suggestions.md)

## Context

Ordinary reading, static builds and portable exports must work without any hosted service, and a
hosted-only feature must fail to a useful canonical fallback. A reader who has an idea for the
author's future work should always have a way to send it, with or without script, with or without a
service, and should never be told it was published or counted.

## Decision

- **One region per post, only where the kind is `open`.** A post carries a "Suggest something for
  future work" section after the article and any approved reflections, only where the site switched
  `future-suggestion` on and the post's own mode is `open`
  (`participation::configured_mode`, the site setting and the post's front matter). A locked or hidden
  post, a site that leaves the kind `off`, feeds and portable files carry nothing, and every page of a
  site that never names the kind is byte for byte what it was (a test builds twice and compares).
- **Without JavaScript, a sentence and the author's contact.** The region's static text says what to
  send (a question, text, video, audio or other source, a link if there is one, whether the reader may
  be contacted) and links the site's `engagement.feedbackContact` as `mailto:` or a contact page. With
  a hosted service it starts "The form needs JavaScript. Without it,".
- **A static site with no service shows only its contact.** With no hosted transport the region has the
  same text, saying plainly that this site takes suggestions by writing to the author, and loads no
  script and names no endpoint. A static site that names no contact shows nothing at all, because
  there is nothing useful to say.
- **With a service, a Web Component that enhances it.** `<ob-future-suggestion>` replaces the static
  text with a form of native controls: the kind as a radio group (a closed set that names what the
  thing is, never what it is worth), the reader's words, an optional link and source details (out of
  reach for a question, which is words only), an optional article it is about, an optional name that
  may be thanked, and an optional address with its own checkbox agreeing to be contacted. Errors are
  announced on their field with focus there; a press while sending waits; success moves focus to a
  message that says it went to the editors and is never published, and shows the receipt once. The
  form reads the reader's choices through the same validator the function uses
  (`future-suggestion.js`), so a refusal is the same refusal on both sides.
- **It sends only where receipts are issued** (`engagement.receipts`), because a reader must always
  be able to take a suggestion back. Otherwise, and whenever the service cannot take it (offline,
  closed, off, rate limited, failing), the reader gets their suggestion as plain text to copy, with a
  retry where one may help and a link to the contact. Nothing they wrote is lost, nothing is stored in
  the browser, and nothing is e-mailed.
- **Nothing ranks or counts.** The region lists no other reader's suggestion and shows no number; its
  text says there are no votes and no counts.
- **Layout.** One column at every width, native controls, visible focus, no fixed widths: the region
  does not scroll sideways at 320 px or at 400% zoom (measured on the region in the browser tests).
- **The manifest names the kind.** `openblog-participation.json` already lists every kind a site has
  switched on with its mode per post, so the hosted function accepts a suggestion only for a page whose
  entry is `open`; the entry holds a mode and nothing a reader wrote.

## Consequences

The component and its two helper modules (`future-suggestion.js`, `public-url.js`) are written into
every site's assets like the other components, and a page loads the component only where it carries
the form. A browser test covers keyboard use, each error, network loss, a service that is off, a
static site, both reflow measurements, a strict content security policy and the page without script.
