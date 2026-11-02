# ADR 0247: The home page renders landing sections from validated data, with one h1 and no change when there are none

- Status: Accepted
- Superseded in part by: ADR 0253 (Video and Map sections render privacy-enhanced lazy frames; the "no frame or third-party request" rule no longer holds for them)
- Date: 2026-10-28
- Decision issue: [#324](https://github.com/journey-to-code-org/open.blog/issues/324)
- Parent story: [#315](https://github.com/journey-to-code-org/open.blog/issues/315)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0246
- Serves: [#325](https://github.com/journey-to-code-org/open.blog/issues/325)

## Context

Visitors must see what the owner arranged, on every theme, without any chance that content becomes markup, and a
site that never uses the feature must not change by a byte.

## Decision

- **No visible section means the old code path.** `home()` takes the landing path only on page 1 and only when
  the page has at least one visible section. Otherwise the original statements run untouched: no file, an
  unreadable file, an empty list and a list of only hidden sections all give today's bytes. A golden test
  (`tests/fixtures/landing/`, captured before the renderer existed) pins page 1 and the pager pages.
- **An unusable file is a warning, not an error.** A `landing.json` that does not parse (malformed, a newer
  version, an unknown section type, a bound exceeded) is reported in the build warnings with the first problems,
  and the home page is built from `home.*`. The page is accepted whole or not at all, so no half-page renders.
- **Pager pages are unchanged.** `/page/N/` for N of 2 or more is the post list only. On page 1 the "Older"
  pager is written once, under the first latest-posts list that shows exactly one page of posts (so page 2
  continues it); a shorter list offers no pager rather than skipping posts.
- **One `<h1>`, no skipped level.** The first rendered section with a heading of its own (welcome, latest posts,
  series, or a featured post with a heading) takes the `<h1>`. If text or a piece renders before any of those,
  or none renders a heading, the site title is written as the `<h1>` first. Every other section heading is an
  `<h2>`. Markdown headings in rich text are set as `<h2>`; inside a call-out or a FAQ answer they are bold
  text, so the page only ever has `h1` and `h2`.
- **Everything is escaped; rich text is inert.** Each field goes through the HTML escaper. Rich text, answers and
  call-outs use `render_inert_markdown`: raw HTML is shown as text, links and images keep only `https`,
  `mailto`, `tel` and relative addresses, headings carry no author attributes. Addresses are checked again at
  render time, and an element whose address fails is left out. Alt text is always emitted.
- **Pieces are links, not frames.** A video is a link to the provider's page, a map a link to OpenStreetMap, a
  contact a `mailto:`/`tel:` link. No script, frame or third-party request is added to the home page.
- **Reuse.** Latest posts and series use `post_list` and `series_cards`, so a theme's list style applies. A
  featured post uses `post_list` for one post and renders nothing (with a build warning) when the post is not
  published, so a draft is never featured.
- **Markup.** Each section is `<section class="ob-section ob-home-section ob-home-<type>" id="ob-home-<id>">`,
  labelled by its heading when it has one. Styling reads `--ob-*` tokens only (#325).

## Considered options

- **Replace `home()` wholesale and express today's page as a landing page.** Rejected: byte-identical output is
  the invariant, and it is cheapest to keep by not running new code for sites that do not use it.
- **Fail the build on a bad file.** Rejected (ADR 0246).
- **Embedded video and map frames.** Deferred (ADR 0245).

## Consequences

- #325 styles the `ob-home-*` classes in `web/base.css` and checks every bundled theme.
- A later version may add sections; the renderer's match is exhaustive, so adding one is a compile error until
  it is rendered.
