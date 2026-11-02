# ADR 0258: Starter layouts are lists of sample sections, applied through the normal edit flow, and never replace a page without a yes

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#338](https://github.com/journey-to-code-org/open.blog/issues/338)
- Parent story: [#320](https://github.com/journey-to-code-org/open.blog/issues/320)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Builds on: ADR 0245, ADR 0249, ADR 0252

## Context

A blank builder is frightening to someone who has never made a web page. Owners need a good starting point,
and it must not be a way to lose work or to put markup on the page.

## Decision

- **A starter is data.** `STARTERS` in `web/admin/landing.js` lists Welcome, Small business (opening hours,
  contact, map), Portfolio (welcome, a featured post or the latest posts, buttons, social links) and Newsletter
  (a follow button to `/rss.xml`, text, recent posts). Each is a function returning fresh section objects of
  the existing typed sections, so the server validates them exactly as it validates anything else. There is no
  markup, no style and no new section type. **Start from scratch** is the empty list.
- **Sample text is marked.** Every layout begins with a Notice section (id `sample-note`) saying it is a
  sample, and each stand-in sentence starts with "Sample", so an owner can see what to replace and delete the
  note when done. Contact details use `example.com` and a `555` number; the map uses a sample address.
- **A featured post only when there is one.** The Portfolio features the owner's first published post; with
  none it shows the latest posts instead, because a featured post with no post would not save.
- **Applying is an ordinary edit.** Choosing a layout replaces the sections of the draft and nothing else on
  the page. It is unsaved until Save, goes through the same draft, preview, save and conflict flow
  (ADR 0252), and shows an **Undo** in the bar that brings the earlier sections back. Any other edit, a
  delete or a save retires that Undo.
- **Nothing is replaced silently.** When the page has sections and is either stored or already changed,
  choosing a layout (or Reset to default) first asks "Replace your sections with ...?" with "Replace my
  sections" and "Keep what I have". A first visit, where the sections are only the home page's current
  settings, is offered the layouts in a panel and may choose directly, with Undo.
- **Reset to default is always there** as a button. The default is the page built from the owner's home
  settings (the `legacy` page the server already returns); with none it is the Welcome layout. It asks first
  like any replacement.
- **The picker is offered, not forced.** On a first visit the panel is open; "Keep what my home page shows
  now" closes it and changes nothing. After that "Choose a ready-made layout" opens it again.
- **Render proof is shared with Rust.** The starters are written once; a Node test keeps
  `crates/openblog-core/tests/fixtures/landing-starters.json` equal to them and a Rust test loads each into a
  site and builds it on every bundled theme.

## Considered options

- **Starters stored on the server.** Rejected for now: the Admin already owns the typed section catalog, and a
  server list would add a route for no gain.
- **A sample picture in Portfolio.** Rejected: there is no bundled image, and a missing file would break the
  page; the owner can add a Picture section.

## Consequences

- Adding a starter is adding a function to the list and regenerating the fixture
  (`UPDATE_STARTERS=1 node --test tests/web/admin-landing.test.mjs`).
