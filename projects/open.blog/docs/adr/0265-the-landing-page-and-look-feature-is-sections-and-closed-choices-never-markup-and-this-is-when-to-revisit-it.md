# ADR 0265: The landing page and look feature is sections and closed choices, never markup, and this is when to revisit it

- Status: Accepted
- Date: 2026-10-28
- Decision issue: [#342](https://github.com/journey-to-code-org/open.blog/issues/342)
- Parent story: [#321](https://github.com/journey-to-code-org/open.blog/issues/321)
- Parent epic: [#314](https://github.com/journey-to-code-org/open.blog/issues/314)
- Overview of: ADR 0245 to ADR 0264

## Context

Epic #314 lets a person with no code arrange their home page and change how their site looks, from a phone.
The details are in twenty ADRs. This one is the map: it states the few choices everything else follows from,
where each is recorded, what was weighed against it, and what would make a maintainer reopen it.

## Decisions

- **Sections over free-form design** (ADR 0245, 0247). The home page is an ordered list of typed sections from a
  closed set, each rendered by the engine. Owners arrange and fill them; they do not place elements.
- **Rich text instead of HTML** (ADR 0257, 0260, 0261). The one rich section is edited like a word-processor
  document and stored as Markdown read with raw HTML disabled. Pasting goes through an allowlist.
- **Pieces as structured data** (ADR 0253 to 0255). A button, video, map, hours and the rest are validated fields
  with one form schema shared by posts and the landing page, never an embed code.
- **A token-only customizer** (ADR 0248, 0256). A look is a small versioned set of closed choices and one hex
  color, compiled into allowlisted `--ob-*` tokens. No CSS text exists anywhere in the request, file or screen.
- **Storage location and format** (ADR 0246, 0248, 0264). The page is one versioned file, `content/landing.json`,
  saved by atomic rename against a revision; the look lives under `appearance` in `openblog.json`; history is
  private. A newer file or an unknown field is kept, never destroyed. A site with neither builds byte for byte
  as before.
- **Contrast enforcement** (ADR 0248). A pure model nudges the accent until text passes WCAG AA in light and dark
  (stricter for higher contrast), and the screen says so in words. Unreadable choices cannot be saved.
- **The Markdown raw HTML question** (ADR 0263). Markdown mode keeps accepting raw HTML in posts and flags it in
  words; every owner surface built here cannot create it.
- **Builder behaviour** (ADR 0249 to 0252, 0258, 0259, 0262, 0264). Plain-language cards and forms, one column
  from 320px, a preview built by the production renderer in a script-free frame, drafts kept on the device,
  starter layouts that never replace a page without a yes, suggestions that never block saving, and twenty
  restorable saves.

## Considered options

- **A drag-and-drop page designer or a theme editor.** Rejected: free placement cannot be kept accessible,
  readable or responsive by construction, and it needs far more than a phone screen offers.
- **An HTML or CSS box for power users.** Rejected: it is a script and style injection surface in a
  tool for non-programmers, and anyone who wants it can edit a theme. It would also split the trust story in two.
- **A WYSIWYG editor that stores HTML.** Rejected: HTML needs sanitising on every read; Markdown is already the
  format of every post and round-trips.
- **Embed codes for video and maps.** Rejected: an owner cannot judge one, and each loads third-party code. IDs
  and coordinates become privacy-enhanced lazy frames with a link beside them.
- **Free colors and fonts.** Rejected: they cannot be kept readable in both schemes; curated looks, a derived
  accent and a font-style list can.
- **Storing the page in `openblog.json`.** Rejected: large rewrites of the site's main config for a page edit.

## What would trigger revisiting this

- A section type or look control that owners keep asking for and cannot be expressed as data or a closed choice.
- A reviewed need for markup in landing content (for example an approved embed provider), which would be a new
  typed section, not a free field.
- Raw HTML in Markdown mode causing real harm or review burden, which would add a per-site setting that refuses
  new raw HTML (additive, default off).
- A stored-format change: a new `version` of `landing.json` or `appearance`, with a documented upgrade and the
  rule that an older release never overwrites a newer file.
- Real-browser or accessibility regressions in the phone, keyboard, zoom or reduced-motion checks
  (`tests/browser/landing-journey.spec.mjs` and the landing, look and piece specs).

## Consequences

- New landing or look features are added as typed data or closed choices with a test, or they need a new ADR.
- The documentation is in [Admin](../admin.md#change-your-home-page-and-your-look),
  [content](../content.md#landing-page-sections), [themes](../themes.md#how-the-owners-look-layers-over-your-tokens)
  and [theme components](../theme-components.md#styling-the-landing-page).
